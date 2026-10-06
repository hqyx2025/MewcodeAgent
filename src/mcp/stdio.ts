import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { processEnvironment } from '../tools/process.js';
import { windowsJobPrelude } from '../tools/windows-job.js';
import { MESSAGE_BYTES } from './schema.js';

// A Job Object owns the relay and all descendants. Byte-stream forwarding avoids
// PowerShell's text pipeline (which changes newlines and buffers native input).
function windowsRelay(command: string, args: string[], cwd: string): string {
  const data = Buffer.from(JSON.stringify({ command, args, cwd }), 'utf8').toString('base64');
  return (
    windowsJobPrelude +
    `
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
namespace MewCode {
  public static class Relay {
    public static int Run(string command, string arguments, string cwd) {
      var info = new ProcessStartInfo(command, arguments);
      info.WorkingDirectory = cwd;
      info.UseShellExecute = false;
      info.CreateNoWindow = true;
      info.RedirectStandardInput = true;
      info.RedirectStandardOutput = true;
      info.RedirectStandardError = true;
      var child = Process.Start(info);
      var input = Task.Run(() => {
        var source = Console.OpenStandardInput();
        var destination = child.StandardInput.BaseStream;
        var buffer = new byte[4096];
        int count;
        while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
          destination.Write(buffer, 0, count);
          destination.Flush();
        }
      });
      input.ContinueWith(t => { try { child.StandardInput.Close(); } catch {} });
      var output = Task.Run(() => child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));
      var error = Task.Run(() => child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));
      child.WaitForExit();
      // Descendants may keep inherited pipes open. Exiting closes the Job Object.
      Task.WaitAll(new Task[] { output, error }, 500);
      return child.ExitCode;
    }
  }
}
'@ -ErrorAction Stop
$mcpData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
$mcpArgs = ${quoteWindowsArgs(args)}
$mcpExit = [MewCode.Relay]::Run($mcpData.command, $mcpArgs, $mcpData.cwd)
exit $mcpExit
`
  );
}

function quoteWindowsArgs(args: string[]): string {
  const quoted = args
    .map((arg) => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"')
    .join(' ');
  return "'" + quoted.replaceAll("'", "''") + "'";
}

export class OwnedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private closing?: Promise<void>;
  private closed = false;
  private readonly buffer = new ReadBuffer({ maxBufferSize: MESSAGE_BYTES });
  private bytes = 0;
  private messages = 0;
  constructor(
    private readonly options: {
      command: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ) {}
  get pid(): number | undefined {
    return this.child?.pid;
  }
  async start(): Promise<void> {
    if (this.child || this.closed) throw new Error('MCP transport already started');
    const win = process.platform === 'win32';
    const script = win
      ? windowsRelay(this.options.command, this.options.args, this.options.cwd)
      : '';
    const child = spawn(
      win
        ? join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          )
        : this.options.command,
      win
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ]
        : this.options.args,
      {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !win,
      },
    );
    this.child = child;
    const fail = () => {
      this.onerror?.(new Error('MCP stdio stream failed'));
      void this.close();
    };
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.stderr.on('data', (chunk: Buffer) => {
      // Never print or retain server diagnostics, even before initialization.
      this.bytes += chunk.length;
      if (this.bytes > 16 * 1024 * 1024) fail();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.bytes += chunk.length;
        if (this.bytes > 16 * 1024 * 1024) throw new Error('MCP session byte limit');
        this.buffer.append(chunk);
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage()) !== null) {
          if (++this.messages > 2_000) throw new Error('MCP session message limit');
          this.onmessage?.(message);
        }
      } catch {
        fail();
      }
    });
    child.once('exit', () => {
      void this.close();
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => {
        fail();
        reject(new Error('MCP process unavailable'));
      });
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child || this.closed) throw new Error('MCP transport closed');
    const data = serializeMessage(message);
    if (Buffer.byteLength(data) > MESSAGE_BYTES) throw new Error('MCP outgoing limit');
    await new Promise<void>((resolve, reject) =>
      this.child!.stdin.write(data, (error) => (error ? reject(error) : resolve())),
    );
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const child = this.child;
      if (child?.pid) {
        if (process.platform === 'win32') {
          // Killing the wrapper closes the non-inheritable Job Object handle.
          child.kill();
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
        if (child.exitCode === null && child.signalCode === null)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2_000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      this.buffer.clear();
      this.onclose?.();
    })();
    return this.closing;
  }
}

export function stdioEnvironment(
  references: Record<string, string>,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const output = processEnvironment();
  for (const [key, name] of Object.entries(references)) {
    const value = env[name];
    if (value === undefined || value.includes('\0'))
      throw new Error('MCP environment reference unavailable');
    output[key] = value;
  }
  return output;
}
