import { render } from 'ink';
import { Chat } from './chat.js';
import type { ChatProps } from './chat.js';

export async function startChat(props: ChatProps): Promise<void> {
  const instance = render(<Chat {...props} />, { exitOnCtrlC: false, maxFps: 30 });
  try {
    await instance.waitUntilExit();
  } finally {
    instance.unmount();
  }
}
