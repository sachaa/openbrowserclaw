// ---------------------------------------------------------------------------
// BrowserClaw — Browser Chat Channel
// ---------------------------------------------------------------------------

import type { Channel, InboundMessage } from '../types.js';
import { DEFAULT_GROUP_ID } from '../config.js';
import { ulid } from '../ulid.js';

type MessageCallback = (msg: InboundMessage) => void;
type TypingCallback = (groupId: string, typing: boolean) => void;
type MessageDisplayCallback = (groupId: string, text: string, isFromMe: boolean) => void;

/**
 * In-browser chat channel. Bridges the UI chat component with the orchestrator.
 * Unlike Telegram, this doesn't poll — the UI directly calls submit().
 */
export class BrowserChatChannel implements Channel {
  readonly type = 'browser' as const;
  private messageCallback: MessageCallback | null = null;
  private typingCallback: TypingCallback | null = null;
  private displayCallback: MessageDisplayCallback | null = null;
  private activeGroupId: string = DEFAULT_GROUP_ID;

  start(): void {
    // No-op — browser chat is always "started"
  }

  stop(): void {
    // No-op
  }

  /**
   * Called by the UI when the user submits a message.
   */
  submit(text: string, groupId?: string): void {
    const gid = groupId || this.activeGroupId;
    const msg: InboundMessage = {
      id: ulid(),
      groupId: gid,
      sender: 'You',
      content: text,
      timestamp: Date.now(),
      channel: 'browser',
    };
    this.messageCallback?.(msg);
  }

  /**
   * Send a response to the browser chat UI for display.
   */
  async send(groupId: string, text: string): Promise<void> {
    this.displayCallback?.(groupId, text, true);
  }

  /**
   * Show/hide typing indicator in the UI.
   */
  setTyping(groupId: string, typing: boolean): void {
    this.typingCallback?.(groupId, typing);
  }

  /**
   * Register callback for inbound messages (from UI → orchestrator).
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * Register callback for typing indicator changes.
   */
  onTyping(callback: TypingCallback): void {
    this.typingCallback = callback;
  }

  /**
   * Register callback for displaying messages in the UI.
   */
  onDisplay(callback: MessageDisplayCallback): void {
    this.displayCallback = callback;
  }

  /**
   * Set the currently active group (for UI tab switching).
   */
  setActiveGroup(groupId: string): void {
    this.activeGroupId = groupId;
  }

  getActiveGroup(): string {
    return this.activeGroupId;
  }
}
