import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry, parseCommand } from '../../src/core/commands.js';
import type { CommandHost } from '../../src/core/commands.js';
import { Conversation } from '../../src/core/conversation.js';
import { MockProvider } from '../../src/providers/mock.js';
import type { LLMProvider } from '../../src/providers/types.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';
import { commandRuntime } from '../../src/cli/commands.js';
import { loadConfiguration } from '../../src/config/load.js';

function host(): CommandHost {
  let model = 'mock-v1';
  let mode: ReturnType<CommandHost['mode']> = 'default';
  return {
    model: () => model,
    setModel: (value) => {
      model = value;
    },
    mode: () => mode,
    setMode: (value) => {
      mode = value;
    },
    permissions: () => mode,
    clear: vi.fn(),
    compact: () => 'compacted',
  };
}

describe('Slash Command registry', () => {
  it('groups Chinese/quoted/empty arguments and treats shell syntax as text', () => {
    expect(parseCommand(' /review "中文 路径" \'🐈 猫\' "" C:\\work $(whoami) ')).toEqual({
      name: 'review',
      args: ['中文 路径', '🐈 猫', '', 'C:\\work', '$(whoami)'],
      raw: '"中文 路径" \'🐈 猫\' "" C:\\work $(whoami)',
    });
    expect(parseCommand('普通任务')).toBeUndefined();
    for (const input of [
      '/../escape',
      '/MODEL',
      '/help "坏引号',
      `/help ${'a '.repeat(65)}`,
      'a'.repeat(262145),
    ])
      expect(() => parseCommand(input)).toThrow();
  });

  it('runs builtins locally, validates arity, completes names and returns explicit Agent handoff', async () => {
    const local = host();
    const commands = new CommandRegistry(local);
    expect(await commands.execute('/help')).toMatchObject({
      kind: 'local',
      text: expect.stringContaining('/resume'),
    });
    expect(commands.complete('/mo')).toEqual(['/model']);
    expect(commands.complete('/model x')).toEqual([]);
    await commands.execute('/model gpt-5.5');
    expect(local.model()).toBe('gpt-5.5');
    await commands.execute('/plan');
    expect(local.mode()).toBe('plan');
    await commands.execute('/plan off');
    expect(local.mode()).toBe('default');
    await commands.execute('/permissions accept-edits');
    expect(local.mode()).toBe('accept-edits');
    expect(await commands.execute('/clear')).toMatchObject({ kind: 'local', clear: true });
    expect(local.clear).toHaveBeenCalledOnce();
    expect(await commands.execute('/compact')).toEqual({ kind: 'local', text: 'compacted' });
    expect(await commands.execute('/plan "分析 项目"')).toEqual({
      kind: 'agent',
      mode: 'plan',
      prompt: '分析 项目',
    });
    expect(
      await commands.execute('/resume 00000000-0000-4000-8000-000000000001 "继续 中文"'),
    ).toEqual({
      kind: 'agent',
      mode: 'accept-edits',
      prompt: '继续 中文',
      resume: '00000000-0000-4000-8000-000000000001',
    });
    for (const input of [
      '/missing',
      '/clear extra',
      '/compact extra',
      '/resume',
      '/resume ../x',
      '/model ""',
      '/model "sk-secret?"',
      '/permissions root',
      '/help missing',
    ])
      await expect(commands.execute(input)).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
  });

  it('rejects overlapping commands throughout asynchronous compaction and explicit running state', async () => {
    let done!: (text: string) => void;
    const local = host();
    local.compact = () =>
      new Promise((resolve) => {
        done = resolve;
      });
    const commands = new CommandRegistry(local);
    const pending = commands.execute('/compact');
    await expect(commands.execute('/clear')).rejects.toMatchObject({ code: 'BUSY' });
    await expect(commands.execute('/help', true)).rejects.toMatchObject({ code: 'BUSY' });
    done('done');
    await pending;
    expect(await commands.execute('/clear')).toMatchObject({ clear: true });
  });

  it('keeps the startup ceiling and executor approval gate when switching modes', async () => {
    const box = await createSandbox();
    try {
      const loaded = await loadConfiguration({
        cwd: box.cwd,
        userHome: box.home,
        env: {},
        overrides: { mode: 'plan' },
      });
      const executor = await ToolExecutor.create(createBuiltinRegistry(), {
        root: box.cwd,
        mode: 'plan',
      });
      const commands = commandRuntime(loaded, executor);
      await expect(commands.execute('/permissions accept-edits')).rejects.toMatchObject({
        code: 'COMMAND_INVALID',
      });
      await expect(commands.execute('/plan off')).rejects.toMatchObject({
        code: 'COMMAND_INVALID',
      });
      let approve!: (answer: boolean) => void;
      const busyExecutor = await ToolExecutor.create(createBuiltinRegistry(), {
        root: box.cwd,
        approve: () =>
          new Promise((resolve) => {
            approve = resolve;
          }),
      });
      loaded.settings.mode = 'default';
      const busyCommands = commandRuntime(loaded, busyExecutor);
      const write = busyExecutor.execute(
        { callId: 'approval', name: 'WriteFile', input: { path: 'file.txt', content: 'text' } },
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(approve).toBeDefined());
      await expect(busyCommands.execute('/permissions plan')).rejects.toMatchObject({
        code: 'BUSY',
      });
      approve(false);
      await write;
      await busyCommands.execute('/plan on');
      expect(busyExecutor.mode).toBe('plan');
    } finally {
      await removeSandbox(box.root);
    }
  });
});

describe('chat state commands', () => {
  const options = { model: 'mock-v1', maxOutputTokens: 4096, timeoutMs: 5000 };
  it('clears committed history, switches request model and compresses without model calls', async () => {
    const requests: string[] = [];
    const mock = new MockProvider({ delayMs: 0, response: 'answer'.repeat(1000) });
    const provider: LLMProvider = {
      ...mock,
      id: mock.id,
      capabilities: mock.capabilities,
      stream: (request, signal) => {
        requests.push(request.model);
        return mock.stream(request, signal);
      },
    };
    const conversation = new Conversation(provider, { ...options, maxContextCharacters: 200000 });
    for (let i = 0; i < 8; i++)
      for await (const _event of conversation.send(`goal-${i}`)) {
        expect(_event.type).toBeDefined();
        /* drain */
      }
    const before = JSON.stringify(conversation.history).length;
    expect(conversation.compact()).toContain('本地历史摘录');
    expect(JSON.stringify(conversation.history).length).toBeLessThan(before);
    expect(conversation.history[0]?.content).toBe('goal-0');
    expect(requests).toHaveLength(8);
    conversation.setModel('different-model');
    conversation.clear();
    expect(conversation.history).toEqual([]);
    for await (const _event of conversation.send('fresh')) {
      expect(_event.type).toBeDefined();
      /* drain */
    }
    expect(requests.at(-1)).toBe('different-model');
    expect(conversation.history[0]?.content).toBe('fresh');
  });

  it('refuses clear/model/compact while generating and preserves cancelled history', async () => {
    const conversation = new Conversation(new MockProvider({ delayMs: 500 }), options);
    const controller = new AbortController();
    const stream = conversation.send('waiting', controller.signal)[Symbol.asyncIterator]();
    const pending = stream.next();
    expect(() => conversation.clear()).toThrow();
    expect(() => conversation.setModel('other')).toThrow();
    expect(() => conversation.compact()).toThrow();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(conversation.history).toEqual([]);
    conversation.clear();
  });
});
