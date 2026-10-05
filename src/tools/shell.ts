import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { ToolError } from './errors.js';
import { runProcess } from './process.js';
import { defineTool } from './types.js';
import { windowsJobPrelude } from './windows-job.js';

export const bashTool = defineTool({
  name: 'Bash',
  description: '通过主机配置的PowerShell/Bash执行完整命令；始终遵循shell权限审批。',
  effect: 'shell',
  schema: z.strictObject({
    command: z.string().min(1).max(16_384),
    cwd: z.string().min(1).max(4096).default('.'),
    timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
  }),
  async prepare(input, context) {
    const cwd = await context.paths.resolve(input.cwd);
    if (!(await lstat(cwd)).isDirectory()) throw new ToolError('TOOL_INPUT', 'cwd必须是目录。');
    return {
      target: cwd,
      preview: `${context.shell.kind}: ${input.command}`,
      async run() {
        await context.paths.resolve(cwd);
        const args =
          context.shell.kind === 'powershell'
            ? [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                '$ErrorActionPreference = "Stop";\n' +
                  (process.platform === 'win32' ? windowsJobPrelude : '') +
                  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n' +
                  '$ErrorActionPreference = "Continue"; $global:LASTEXITCODE = 0;\n& {\n' +
                  input.command +
                  '\n}; $mewcodeSucceeded = $?; $mewcodeNativeCode = $global:LASTEXITCODE;\n' +
                  'if ($mewcodeNativeCode -ne 0) { exit $mewcodeNativeCode }; if (-not $mewcodeSucceeded) { exit 1 }',
              ]
            : ['--noprofile', '--norc', '-c', input.command];
        const output = await runProcess({
          executable: context.shell.executable,
          args,
          cwd,
          signal: context.signal,
          timeoutMs: input.timeoutMs,
          maxBytes: 32 * 1024,
        });
        return {
          content: `stdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
          data: {
            shell: context.shell.kind,
            cwd: context.paths.display(cwd),
            exitCode: output.exitCode,
          },
          truncated: output.truncated,
          ...(output.truncated
            ? {
                error: { code: 'TOOL_OUTPUT_LIMIT', message: '命令因输出上限被终止，结果不完整。' },
              }
            : output.exitCode === 0
              ? {}
              : {
                  error: { code: 'COMMAND_FAILED', message: '命令返回非零退出码。' },
                }),
        };
      },
    };
  },
});
