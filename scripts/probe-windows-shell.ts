import { spawn } from 'node:child_process';
import { processEnvironment } from '../src/tools/process.js';
import { windowsJobPrelude } from '../src/tools/windows-job.js';

if (process.platform === 'win32') {
  const extraNames = new Set([
    'APPDATA',
    'LOCALAPPDATA',
    'USERNAME',
    'USERDOMAIN',
    'ALLUSERSPROFILE',
    'PSMODULEPATH',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
  ]);
  const expanded = {
    ...processEnvironment(),
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => extraNames.has(name.toUpperCase())),
    ),
  };
  for (const [name, env, script] of [
    ['minimal plain', processEnvironment(), 'Write-Output "PS_READY"'],
    ['expanded plain', expanded, 'Write-Output "PS_READY"'],
    [
      'minimal job',
      processEnvironment(),
      'Write-Output "COMPILING";\n' +
        windowsJobPrelude.replace(
          '[MewCode.ProcessJob]::Bind()',
          'Write-Output "COMPILED"; [MewCode.ProcessJob]::Bind()',
        ) +
        '\nWrite-Output "BOUND"',
    ],
    [
      'expanded job',
      expanded,
      'Write-Output "COMPILING";\n' +
        windowsJobPrelude.replace(
          '[MewCode.ProcessJob]::Bind()',
          'Write-Output "COMPILED"; [MewCode.ProcessJob]::Bind()',
        ) +
        '\nWrite-Output "BOUND"',
    ],
  ] as const) {
    process.stdout.write(`PROBE ${name}\n`);
    await new Promise<void>((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', (data: Buffer) =>
        process.stdout.write(`OUT ${data.toString().slice(0, 1000)}\n`),
      );
      child.stderr.on('data', (data: Buffer) =>
        process.stdout.write(`ERR ${data.toString().slice(0, 1000)}\n`),
      );
      child.on('exit', (code) => process.stdout.write(`EXIT ${code}\n`));
      const timer = setTimeout(() => {
        process.stdout.write('TIMEOUT\n');
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('close', () => {
          child.kill();
          child.stdout.destroy();
          child.stderr.destroy();
          resolve();
        });
      }, 8000);
      child.on('close', () => {
        clearTimeout(timer);
        process.stdout.write('CLOSED\n');
        resolve();
      });
      child.on('error', () => {
        clearTimeout(timer);
        process.stdout.write('SPAWN_ERROR\n');
        resolve();
      });
    });
  }
}
