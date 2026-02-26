// ---------------------------------------------------------------------------
// OpenBrowserClaw — Telegram Bot API Channel
// ---------------------------------------------------------------------------

import type { Channel, InboundMessage } from '../types.js';
import { TELEGRAM_API_BASE, TELEGRAM_MAX_LENGTH, TELEGRAM_POLL_TIMEOUT } from '../config.js';

type MessageCallback = (msg: InboundMessage) => void;

/**
 * Telegram channel using the Bot API via fetch().
 * Pure HTTPS — no WebSockets, no CORS issues (api.telegram.org allows all origins).
 */
export class TelegramChannel implements Channel {
  readonly type = 'telegram' as const;
  private token: string = '';
  private registeredChatIds = new Set<string>();
  private offset = 0;
  private abortController: AbortController | null = null;
  private messageCallback: MessageCallback | null = null;
  private running = false;

  /**
   * Configure the channel with a bot token and registered chat IDs.
   */
  configure(token: string, chatIds: string[]): void {
    this.token = token;
    this.registeredChatIds = new Set(chatIds);
  }

  /**
   * Add a chat ID to the registered set.
   */
  registerChatId(chatId: string): void {
    this.registeredChatIds.add(chatId);
  }

  /**
   * Start the long-polling loop.
   */
  start(): void {
    if (!this.token) return;
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.poll();
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  /**
   * Send a message to a Telegram chat.
   * Auto-splits messages that exceed Telegram's 4096-char limit.
   */
  async send(groupId: string, text: string): Promise<void> {
    const chatId = groupId.replace(/^tg:/, '');
    const chunks = splitText(text, TELEGRAM_MAX_LENGTH);
    for (const chunk of chunks) {
      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
      });
    }
  }

  /**
   * Send a typing indicator.
   */
  setTyping(groupId: string, typing: boolean): void {
    if (!typing) return; // Telegram only supports "start typing"
    const chatId = groupId.replace(/^tg:/, '');
    // Fire-and-forget
    this.apiCall('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
    }).catch(() => {});
  }

  /**
   * Register callback for inbound messages.
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * Check if the channel is configured and running.
   */
  isConfigured(): boolean {
    return this.token.length > 0;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async poll(): Promise<void> {
    while (this.running && this.abortController && !this.abortController.signal.aborted) {
      try {
        const res = await fetch(
          `${TELEGRAM_API_BASE}${this.token}/getUpdates?offset=${this.offset}&timeout=${TELEGRAM_POLL_TIMEOUT}`,
          { signal: this.abortController.signal },
        );

        if (!res.ok) {
          console.error(`Telegram poll error: HTTP ${res.status}`);
          await sleep(5000);
          continue;
        }

        const data = await res.json();
        if (!data.ok || !data.result) {
          await sleep(5000);
          continue;
        }

        for (const update of data.result) {
          this.offset = update.update_id + 1;
          this.handleUpdate(update);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') break;
        console.error('Telegram poll error:', err);
        await sleep(5000);
      }
    }
  }

  private handleUpdate(update: TelegramUpdate): void {
    const msg = update.message;
    if (!msg) return;

    const chatId = String(msg.chat.id);

    // Handle /chatid command — always respond (registration helper)
    if (msg.text === '/chatid') {
      this.apiCall('sendMessage', {
        chat_id: chatId,
        text: `Chat ID: \`${chatId}\`\nRegister this ID in OpenBrowserClaw settings.`,
        parse_mode: 'Markdown',
      }).catch(console.error);
      return;
    }

    // Handle /ping command
    if (msg.text === '/ping') {
      this.apiCall('sendMessage', {
        chat_id: chatId,
        text: 'Pong! 🏓 OpenBrowserClaw is running.',
      }).catch(console.error);
      return;
    }

    // Ignore unregistered chats
    if (!this.registeredChatIds.has(chatId)) return;

    // Extract message content
    const content =
      msg.text ||
      (msg.photo ? '[Photo]' : null) ||
      (msg.voice ? '[Voice message]' : null) ||
      (msg.document ? `[Document: ${msg.document.file_name}]` : null) ||
      (msg.sticker ? `[Sticker: ${msg.sticker.emoji || ''}]` : null) ||
      (msg.location ? `[Location: ${msg.location.latitude}, ${msg.location.longitude}]` : null) ||
      (msg.contact ? `[Contact: ${msg.contact.first_name}]` : null) ||
      '[Unsupported message type]';

    const senderName = msg.from?.first_name || msg.from?.username || 'Unknown';

    this.messageCallback?.({
      id: String(msg.message_id),
      groupId: `tg:${chatId}`,
      sender: senderName,
      content,
      timestamp: msg.date * 1000,
      channel: 'telegram',
    });
  }

  private async apiCall(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${TELEGRAM_API_BASE}${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Telegram API ${method} failed: ${res.status} ${text}`);
    }
    return res.json();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= max) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline boundary
    let end = max;
    const lastNewline = remaining.lastIndexOf('\n', max);
    if (lastNewline > max * 0.5) end = lastNewline;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Telegram API types (minimal subset)
// ---------------------------------------------------------------------------

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string; username?: string };
  date: number;
  text?: string;
  photo?: unknown[];
  voice?: unknown;
  document?: { file_name?: string };
  sticker?: { emoji?: string };
  location?: { latitude: number; longitude: number };
  contact?: { first_name: string };
}
