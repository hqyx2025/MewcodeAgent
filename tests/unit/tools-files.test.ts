import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { defineTool } from '../../src/tools/types.js';
import type { ExecutorOptions } from '../../src/tools/executor.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

describe('file tools and permissions', () => {
  let sandbox: Awaited<ReturnType<typeof createSandbox>>;
  beforeEach(async () => {
    sandbox = await createSandbox();
  });
  afterEach(async () => {
    await removeSandbox(sandbox.root);
  });
  const executor = (options: Partial<ExecutorOptions> = {}) =>
    ToolExecutor.create(createBuiltinRegistry(), { root: sandbox.cwd, ...options });
  const call = (exec: ToolExecutor, name: string, input: unknown, signal?: AbortSignal) =>
    exec.execute({ callId: randomUUID(), name, input }, signal);
  const revision = (text: string) => createHash('sha256').update(text).digest('hex');

  it('exports six strict JSON Schemas and rejects unknown tools/fields', async () => {
    const registry = createBuiltinRegistry();
    const definitions = registry.definitions();
    expect(definitions).toHaveLength(6);
    expect(definitions.find((tool) => tool.name === 'ReadFile')?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['path'],
    });
    expect(() => registry.register(registry.get('ReadFile'))).toThrow('重复');
    const exec = await executor();
    expect((await call(exec, 'Unknown', {})).error?.code).toBe('TOOL_NOT_FOUND');
    expect((await call(exec, 'ReadFile', { path: 'a', mode: 'accept-edits' })).error?.code).toBe(
      'TOOL_INPUT',
    );
  });

  it('reads a Unicode line range and hashes the complete file including CRLF/BOM', async () => {
    const text = '\ufeff你好🐈\r\n第二行\r\n尾行';
    await writeFile(join(sandbox.cwd, '中文.txt'), text);
    const result = await call(await executor(), 'ReadFile', {
      path: '中文.txt',
      startLine: 2,
      endLine: 2,
    });
    expect(result).toMatchObject({
      ok: true,
      content: '2: 第二行',
      truncated: false,
      data: { revision: revision(text), totalLines: 3 },
    });
  });

  it('rejects binary, invalid UTF-8, oversized files and invalid line ranges', async () => {
    const exec = await executor();
    await writeFile(join(sandbox.cwd, 'bin'), Buffer.from([0, 1]));
    await writeFile(join(sandbox.cwd, 'invalid'), Buffer.from([0xff]));
    await writeFile(join(sandbox.cwd, 'big'), 'x'.repeat(1024 * 1024 + 1));
    await writeFile(join(sandbox.cwd, 'valid'), 'one\ntwo');
    for (const path of ['bin', 'invalid'])
      expect((await call(exec, 'ReadFile', { path })).error?.code).toBe('FILE_BINARY');
    expect((await call(exec, 'ReadFile', { path: 'big' })).error?.code).toBe('FILE_TOO_LARGE');
    expect(
      (await call(exec, 'ReadFile', { path: 'valid', startLine: 2, endLine: 1 })).error?.code,
    ).toBe('TOOL_INPUT');
    expect((await call(exec, 'ReadFile', { path: 'missing' })).error?.code).toBe('FILE_NOT_FOUND');
  });

  it('bounds long output and explicit very large requested line ranges', async () => {
    await writeFile(join(sandbox.cwd, 'long'), '猫'.repeat(30_000));
    await writeFile(join(sandbox.cwd, 'lines'), 'x\n'.repeat(3000));
    const exec = await executor();
    const long = await call(exec, 'ReadFile', { path: 'long' });
    expect(long.truncated).toBe(true);
    expect(Buffer.byteLength(long.content)).toBeLessThanOrEqual(32 * 1024);
    expect(long.content).not.toContain('\ufffd');
    const lines = await call(exec, 'ReadFile', { path: 'lines', endLine: 99999 });
    expect(lines.truncated).toBe(true);
    expect(lines.data).toMatchObject({ endLine: 2000 });
  });

  it('rejects traversal, credential/internal paths, Windows aliases and directory reads', async () => {
    const exec = await executor();
    for (const path of [
      '../outside',
      '.env.local',
      '.ENV.local',
      '.git/config',
      '.mewcode/config.yaml',
      '.mewcode/cache/x',
      'file:stream',
      'trailing.',
      'NUL.txt',
    ]) {
      expect((await call(exec, 'ReadFile', { path })).error?.code, path).toBe('PATH_DENIED');
    }
    expect((await call(exec, 'ReadFile', { path: '.' })).error?.code).toBe('TOOL_INPUT');
  });

  it('rejects directory symlinks/junctions to both inside and outside the root', async () => {
    await mkdir(join(sandbox.cwd, 'real'));
    await writeFile(join(sandbox.cwd, 'real', 'a'), 'inside');
    await writeFile(join(sandbox.home, 'a'), 'outside');
    for (const [name, target] of [
      ['inner-link', join(sandbox.cwd, 'real')],
      ['outer-link', sandbox.home],
    ]) {
      await symlink(
        target!,
        join(sandbox.cwd, name!),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect((await call(await executor(), 'ReadFile', { path: `${name}/a` })).error?.code).toBe(
        'PATH_DENIED',
      );
    }
  });

  it('rejects replacement of the canonical project root with a junction', async () => {
    const exec = await executor();
    const { rename } = await import('node:fs/promises');
    await rename(sandbox.cwd, join(sandbox.root, 'moved-project'));
    await symlink(sandbox.home, sandbox.cwd, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await call(exec, 'ReadFile', { path: '.' })).error?.code).toBe('PATH_DENIED');
  });

  it.skipIf(process.platform === 'win32')('rejects FIFO paths before a blocking open', async () => {
    await promisify(execFile)('mkfifo', [join(sandbox.cwd, 'pipe')]);
    expect((await call(await executor(), 'ReadFile', { path: 'pipe' })).error?.code).toBe(
      'TOOL_INPUT',
    );
  });

  it('defaults to ask, respects refusal, allows accept-edits and never bypasses Plan/deny', async () => {
    const input = { path: 'new.txt', content: 'new' };
    expect((await call(await executor(), 'WriteFile', input)).error?.code).toBe('TOOL_PERMISSION');
    expect(
      (await call(await executor({ approve: async () => false }), 'WriteFile', input)).error?.code,
    ).toBe('TOOL_PERMISSION');
    expect(
      (await call(await executor({ mode: 'plan', approve: async () => true }), 'WriteFile', input))
        .error?.code,
    ).toBe('TOOL_PERMISSION');
    expect(
      (
        await call(
          await executor({ mode: 'accept-edits', denyTools: ['WriteFile'] }),
          'WriteFile',
          input,
        )
      ).error?.code,
    ).toBe('TOOL_PERMISSION');
    expect((await call(await executor({ mode: 'accept-edits' }), 'WriteFile', input)).ok).toBe(
      true,
    );
    expect(await readFile(join(sandbox.cwd, 'new.txt'), 'utf8')).toBe('new');
    expect(
      (await call(await executor({ denyTools: ['ReadFile'] }), 'ReadFile', { path: 'new.txt' }))
        .error?.code,
    ).toBe('TOOL_PERMISSION');
  });

  it('atomically creates/overwrites and preserves file permissions without temporary leftovers', async () => {
    const exec = await executor({ mode: 'accept-edits' });
    const created = await call(exec, 'WriteFile', { path: '创建.txt', content: '旧🐈' });
    expect(created.ok).toBe(true);
    expect((await call(exec, 'WriteFile', { path: '创建.txt', content: 'new' })).error?.code).toBe(
      'FILE_CONFLICT',
    );
    if (process.platform !== 'win32') await chmod(join(sandbox.cwd, '创建.txt'), 0o664);
    const changed = await call(exec, 'WriteFile', {
      path: '创建.txt',
      content: '新🐈',
      expectedRevision: revision('旧🐈'),
    });
    expect(changed).toMatchObject({ ok: true, data: { revision: revision('新🐈') } });
    expect(await readFile(join(sandbox.cwd, '创建.txt'), 'utf8')).toBe('新🐈');
    if (process.platform !== 'win32')
      expect((await stat(join(sandbox.cwd, '创建.txt'))).mode & 0o777).toBe(0o664);
    expect((await readdir(sandbox.cwd)).some((name) => name.startsWith('.mewcode-tmp-'))).toBe(
      false,
    );
    expect(
      (await call(exec, 'WriteFile', { path: 'missing-dir/a', content: 'new' })).error?.code,
    ).toBe('FILE_NOT_FOUND');
  });

  it('refuses version changes during approval and does not overwrite concurrent creation', async () => {
    await writeFile(join(sandbox.cwd, 'existing'), 'old');
    const exec = await executor({
      approve: async (request) => {
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.input)).toBe(true);
        expect(request.preview).toContain('新内容');
        await writeFile(request.target, 'external');
        return true;
      },
    });
    for (const input of [
      { path: 'existing', content: 'new', expectedRevision: revision('old') },
      { path: 'created', content: 'new' },
    ]) {
      const result = await call(exec, 'WriteFile', input);
      expect(result.error?.code).toBe('FILE_CONFLICT');
      expect(await readFile(join(sandbox.cwd, input.path), 'utf8')).toBe('external');
    }
  });

  it('rejects approval-time replacement of the target with a junction', async () => {
    await mkdir(join(sandbox.cwd, 'folder'));
    const exec = await executor({
      approve: async () => {
        const { rename } = await import('node:fs/promises');
        await rename(join(sandbox.cwd, 'folder'), join(sandbox.cwd, 'moved'));
        await symlink(
          sandbox.home,
          join(sandbox.cwd, 'folder'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        return true;
      },
    });
    expect(
      (await call(exec, 'WriteFile', { path: 'folder/new', content: 'blocked' })).error?.code,
    ).toBe('PATH_DENIED');
    await expect(stat(join(sandbox.home, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires unique exact matches or explicit replaceAll and a current revision', async () => {
    const exec = await executor({ mode: 'accept-edits' });
    await writeFile(join(sandbox.cwd, 'edit'), 'same\nsame\n🐈');
    const input = {
      path: 'edit',
      oldText: 'same',
      newText: '$& 中文',
      expectedRevision: revision('same\nsame\n🐈'),
    };
    expect((await call(exec, 'EditFile', input)).error?.code).toBe('EDIT_AMBIGUOUS');
    expect((await call(exec, 'EditFile', { ...input, oldText: 'missing' })).error?.code).toBe(
      'EDIT_NO_MATCH',
    );
    const result = await call(exec, 'EditFile', { ...input, replaceAll: true });
    expect(result).toMatchObject({ ok: true, data: { replacements: 2 } });
    expect(await readFile(join(sandbox.cwd, 'edit'), 'utf8')).toBe('$& 中文\n$& 中文\n🐈');
    expect((await call(exec, 'EditFile', { ...input, replaceAll: true })).error?.code).toBe(
      'FILE_CONFLICT',
    );
  });

  it('cancels pending approval, rejects overlapping writes and does not execute a late approval', async () => {
    let approve!: (allowed: boolean) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const exec = await executor({
      approve: async () => {
        entered();
        return new Promise((resolve) => {
          approve = resolve;
        });
      },
    });
    const abort = new AbortController();
    const pending = call(exec, 'WriteFile', { path: 'pending', content: 'never' }, abort.signal);
    await ready;
    expect((await call(exec, 'WriteFile', { path: 'other', content: 'never' })).error?.code).toBe(
      'BUSY',
    );
    abort.abort();
    expect((await pending).error?.code).toBe('CANCELLED');
    approve(true);
    await expect(stat(join(sandbox.cwd, 'pending'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces total approval deadline and prevents repeated callId execution', async () => {
    const exec = await executor({
      timeoutMs: 30,
      approve: async () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100)),
    });
    const request = {
      callId: 'same-id',
      name: 'WriteFile',
      input: { path: 'late', content: 'never' },
    };
    expect((await exec.execute(request)).error?.code).toBe('TOOL_TIMEOUT');
    expect((await exec.execute(request)).error?.code).toBe('TOOL_DUPLICATE');
    await expect(stat(join(sandbox.cwd, 'late'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects replacement amplification before allocating or modifying large content', async () => {
    await writeFile(join(sandbox.cwd, 'amplify'), 'a'.repeat(1000));
    const result = await call(await executor({ mode: 'accept-edits' }), 'EditFile', {
      path: 'amplify',
      oldText: 'a',
      newText: 'b'.repeat(2000),
      replaceAll: true,
      expectedRevision: revision('a'.repeat(1000)),
    });
    expect(result.error?.code).toBe('FILE_TOO_LARGE');
    expect(await readFile(join(sandbox.cwd, 'amplify'), 'utf8')).toBe('a'.repeat(1000));
  });

  it('bounds concurrent read requests and releases slots after cancellation', async () => {
    const registry = createBuiltinRegistry();
    let started = 0;
    let ready!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    registry.register(
      defineTool({
        name: 'WaitingRead',
        description: 'test delayed read',
        effect: 'read',
        schema: z.strictObject({}),
        async prepare(_input, context) {
          return {
            target: context.paths.root,
            preview: 'wait',
            async run() {
              if (++started === 8) ready();
              await new Promise<void>((_resolve, reject) => {
                context.signal.addEventListener(
                  'abort',
                  () => reject(new Error('private error detail')),
                  { once: true },
                );
              });
              return { content: 'done' };
            },
          };
        },
      }),
    );
    const exec = await ToolExecutor.create(registry, { root: sandbox.cwd });
    const controller = new AbortController();
    const pending = Array.from({ length: 8 }, () =>
      call(exec, 'WaitingRead', {}, controller.signal),
    );
    await allStarted;
    expect((await call(exec, 'ReadFile', { path: 'missing' })).error?.code).toBe('BUSY');
    controller.abort();
    expect((await Promise.all(pending)).every((result) => result.error?.code === 'CANCELLED')).toBe(
      true,
    );
    expect((await call(exec, 'ReadFile', { path: 'missing' })).error?.code).toBe('FILE_NOT_FOUND');
  });

  it('uses copied validated input when caller mutates the original during approval', async () => {
    const input = { path: 'immutable', content: 'original' };
    const exec = await executor({
      approve: async (request) => {
        input.content = 'changed after validation';
        expect(request.input).toMatchObject({ content: 'original' });
        return true;
      },
    });
    expect((await call(exec, 'WriteFile', input)).ok).toBe(true);
    expect(await readFile(join(sandbox.cwd, 'immutable'), 'utf8')).toBe('original');
  });
});
