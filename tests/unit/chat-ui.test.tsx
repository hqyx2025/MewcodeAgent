import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { Chat } from '../../src/ui/chat.js';
import { Conversation } from '../../src/core/conversation.js';
import { MockProvider } from '../../src/providers/mock.js';
import type { LLMProvider } from '../../src/providers/types.js';
import { AppError } from '../../src/shared/errors.js';
import { CommandRegistry } from '../../src/core/commands.js';

describe('Ink conversation UI', () => {
  afterEach(cleanup);
  const options = { model: 'mock-v1', maxOutputTokens: 4096, timeoutMs: 1000 };

  it('completes commands, changes model, clears rendered history and hands off resume', async () => {
    const conversation = new Conversation(
      new MockProvider({ delayMs: 0, response: 'old answer marker' }),
      options,
    );
    const commands = new CommandRegistry({
      model: () => conversation.model,
      setModel: (model) => conversation.setModel(model),
      mode: () => 'default',
      setMode: () => {},
      permissions: () => 'default',
      clear: () => conversation.clear(),
      compact: () => conversation.compact(),
    });
    const onAgent = vi.fn();
    const view = render(
      <Chat
        conversation={conversation}
        model="mock-v1"
        provider="mock"
        commands={commands}
        onAgent={onAgent}
      />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('输入问题'));
    const submit = async (text: string) => {
      view.stdin.write(text);
      await vi.waitFor(() => expect(view.lastFrame()).toContain(text));
      view.stdin.write('\r');
    };
    view.stdin.write('/mo');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('/mo'));
    view.stdin.write('\t');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('/model'));
    view.stdin.write('test-model');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('test-model'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('模型：test-model'));
    await submit('old question marker');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('old answer marker'));
    await submit('/clear');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('已清空');
      expect(view.lastFrame()).not.toContain('old answer marker');
      expect(view.lastFrame()).not.toContain('old question marker');
    });
    expect(conversation.history).toEqual([]);
    await submit('/resume 00000000-0000-4000-8000-000000000001');
    await vi.waitFor(() =>
      expect(onAgent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'agent', resume: '00000000-0000-4000-8000-000000000001' }),
      ),
    );
  });

  it('accepts Chinese/emoji input, deletes a full grapheme and submits a round', async () => {
    const conversation = new Conversation(
      new MockProvider({ delayMs: 0, response: '完整回答🐈' }),
      options,
    );
    const view = render(<Chat conversation={conversation} model="mock-v1" provider="mock" />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('MewCode Agent'));
    view.stdin.write('你好👨‍👩‍👧‍👦');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('你好👨‍👩‍👧‍👦'));
    view.stdin.write('\u007f');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('你好');
      expect(view.lastFrame()).not.toContain('👨');
    });
    view.stdin.write('\r');
    await vi.waitFor(() => expect(conversation.history).toHaveLength(2));
    await vi.waitFor(() => expect(view.frames.join('\n')).toContain('完整回答🐈'));
    expect(conversation.history[0]?.content).toBe('你好');
    view.unmount();
  });

  it('cancels a waiting response and returns to input without committing it', async () => {
    const conversation = new Conversation(new MockProvider({ delayMs: 500 }), options);
    const view = render(<Chat conversation={conversation} model="mock-v1" provider="mock" />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('输入问题'));
    view.stdin.write('取消测试');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('取消测试'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('生成中'));
    view.stdin.write('\u001b');
    await vi.waitFor(() => expect(view.frames.join('\n')).toContain('CANCELLED'));
    expect(conversation.history).toEqual([]);
    view.unmount();
  });

  it('exits on Ctrl+C and aborts the outstanding provider request', async () => {
    let requestSignal: AbortSignal | undefined;
    const mock = new MockProvider({ delayMs: 500 });
    const provider: LLMProvider = {
      id: 'captured',
      capabilities: mock.capabilities,
      stream: (request, signal) => {
        requestSignal = signal;
        return mock.stream(request, signal);
      },
    };
    const conversation = new Conversation(provider, options);
    const view = render(<Chat conversation={conversation} model="mock-v1" provider="mock" />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('输入问题'));
    view.stdin.write('退出测试');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('退出测试'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    view.stdin.write('\u0003');
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    expect(conversation.history).toEqual([]);
  });

  it('shows a classified provider error and restores the input state', async () => {
    const provider: LLMProvider = {
      id: 'failure',
      capabilities: { streaming: true, toolCalling: false },
      stream: async function* () {
        throw new AppError('MODEL_AUTH', '鉴权失败。');
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const conversation = new Conversation(provider, options);
    const view = render(<Chat conversation={conversation} model="test" provider="mock" />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('输入问题'));
    view.stdin.write('问题');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('问题'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.frames.join('\n')).toContain('MODEL_AUTH'));
    expect(conversation.history).toEqual([]);
    expect(view.lastFrame()).toContain('Enter 发送');
    view.unmount();
  });

  it('coalesces a fast stream and renders its final full answer', async () => {
    const response = '字'.repeat(120);
    const conversation = new Conversation(
      new MockProvider({ delayMs: 1, chunkSize: 1, response }),
      { ...options, timeoutMs: 5000 },
    );
    const view = render(<Chat conversation={conversation} model="mock-v1" provider="mock" />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('输入问题'));
    view.stdin.write('快速流');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('快速流'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(conversation.history).toHaveLength(2), { timeout: 5000 });
    expect(conversation.history.at(-1)?.content).toBe(response);
    await vi.waitFor(() => expect(view.frames.join('\n').replace(/\n/g, '')).toContain(response));
    expect(view.frames.length).toBeLessThan(120);
    view.unmount();
  });
});
