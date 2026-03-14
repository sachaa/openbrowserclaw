// ---------------------------------------------------------------------------
// OpenBrowserClaw — iMessage Channel
// ---------------------------------------------------------------------------
//
// Connects to a remote iMessage server via Socket.IO + REST.
// Browser-safe — uses socket.io-client and fetch() directly.
//
// groupId prefix: "im:"
// Examples:
//   DM:    im:iMessage;-;+918527438574
//   Group: im:iMessage;+;chat143843922472236064
// ---------------------------------------------------------------------------

import { io, type Socket } from 'socket.io-client';
import type { Channel, InboundMessage } from '../types.js';

type MessageCallback = (msg: InboundMessage) => void;

// ---------------------------------------------------------------------------
// Remote-mode types
// ---------------------------------------------------------------------------

interface RemoteMessage {
  guid: string;
  text: string | null;
  handle?: { address: string };
  chats?: Array<{ guid: string }>;
  isFromMe: boolean;
  dateCreated: number;
  attachments?: Array<{ guid: string; transferName: string; mimeType: string; totalBytes: number }>;
  associatedMessageGuid?: string;
  associatedMessageType?: string | number | null;
}

// ---------------------------------------------------------------------------
// IMessageChannel
// ---------------------------------------------------------------------------

export interface IMessageConfig {
  serverUrl: string;
  apiKey: string;
}

export class IMessageChannel implements Channel {
  readonly type = 'imessage' as const;

  private enabled = false;
  private serverUrl = '';
  private apiKey = '';

  private socket: Socket | null = null;
  private processedGuids = new Map<string, number>();
  private guidCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly GUID_TTL_MS = 5 * 60 * 1000;

  private messageCallback: MessageCallback | null = null;
  private running = false;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  configure(config: IMessageConfig): void {
    this.serverUrl = config.serverUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.enabled = !!(this.serverUrl && this.apiKey);
  }

  disable(): void {
    this.stop();
    this.enabled = false;
    this.serverUrl = '';
    this.apiKey = '';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // -----------------------------------------------------------------------
  // Channel interface
  // -----------------------------------------------------------------------

  start(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    this._startRemote().catch((err) => {
      console.error('[iMessage] start error:', err);
      this.running = false;
    });
  }

  stop(): void {
    this.running = false;
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    if (this.guidCleanupTimer) {
      clearInterval(this.guidCleanupTimer);
      this.guidCleanupTimer = null;
    }
    this.processedGuids.clear();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  async send(groupId: string, text: string): Promise<void> {
    if (!this.enabled) return;
    const chatGuid = this._chatGuid(groupId);
    await this._post('/api/v1/message/text', { chatGuid, message: text });
  }

  setTyping(groupId: string, typing: boolean): void {
    if (!this.enabled) return;
    const chatGuid = this._chatGuid(groupId);
    const encoded = encodeURIComponent(chatGuid);
    if (typing) {
      if (this.typingTimer) clearTimeout(this.typingTimer);
      this._post(`/api/v1/chat/${encoded}/typing`, {}).catch(() => {});
      this.typingTimer = setTimeout(() => {
        this.typingTimer = null;
        this._delete(`/api/v1/chat/${encoded}/typing`).catch(() => {});
      }, 3000);
    } else {
      if (this.typingTimer) {
        clearTimeout(this.typingTimer);
        this.typingTimer = null;
      }
      this._delete(`/api/v1/chat/${encoded}/typing`).catch(() => {});
    }
  }

  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  // -----------------------------------------------------------------------
  // Private — socket connection
  // -----------------------------------------------------------------------

  private async _startRemote(): Promise<void> {
    if (!this.serverUrl) return;

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    const socket = io(this.serverUrl, {
      auth: this.apiKey ? { apiKey: this.apiKey } : undefined,
      transports: ['websocket'],
      timeout: 10_000,
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      forceNew: true,
      autoConnect: false,
    });
    this.socket = socket;

    socket.on('connect_error', (err) => {
      console.error('[iMessage] connect_error:', err.message);
    });

    socket.on('auth-error', (err: { message: string; reason?: string }) => {
      console.error('[iMessage] auth-error:', err.message, err.reason ?? '');
      this.stop();
    });

    socket.on('new-message', (msg: RemoteMessage) => {
      if (msg.guid && this.processedGuids.has(msg.guid)) return;
      if (msg.guid) this.processedGuids.set(msg.guid, Date.now());

      if (!this.messageCallback) return;
      if (msg.isFromMe) return;
      if (msg.associatedMessageGuid) return;
      if (!msg.text?.trim()) return;

      const chatGuid = msg.chats?.[0]?.guid;
      if (!chatGuid) return;

      this.messageCallback({
        id: msg.guid,
        groupId: `im:${chatGuid}`,
        sender: msg.handle?.address ?? 'unknown',
        content: msg.text,
        timestamp: msg.dateCreated,
        channel: 'imessage',
      });
    });

    socket.on('disconnect', (reason) => {
      if (!this.running) return;
      if (reason === 'io server disconnect') {
        socket.connect();
      }
    });

    if (!this.guidCleanupTimer) {
      this.guidCleanupTimer = setInterval(() => {
        const cutoff = Date.now() - IMessageChannel.GUID_TTL_MS;
        for (const [guid, ts] of this.processedGuids) {
          if (ts < cutoff) this.processedGuids.delete(guid);
        }
      }, 60_000);
    }

    socket.connect();
  }

  // -----------------------------------------------------------------------
  // Private — REST helpers
  // -----------------------------------------------------------------------

  private static readonly REQUEST_TIMEOUT_MS = 15_000;

  private async _request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      IMessageChannel.REQUEST_TIMEOUT_MS,
    );
    try {
      return await fetch(`${this.serverUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`[iMessage] ${init.method ?? 'GET'} ${path} timed out after ${IMessageChannel.REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async _post(path: string, body: unknown): Promise<unknown> {
    const res = await this._request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[iMessage] POST ${path} failed ${res.status}: ${text}`);
    }
    const json = await res.json();
    return json.data ?? json;
  }

  private async _delete(path: string): Promise<void> {
    await this._request(path, {
      method: 'DELETE',
      headers: this.apiKey ? { 'X-API-Key': this.apiKey } : {},
    });
  }

  // -----------------------------------------------------------------------
  // Private — helpers
  // -----------------------------------------------------------------------

  private _chatGuid(groupId: string): string {
    const raw = groupId.startsWith('im:') ? groupId.slice(3) : groupId;
    return raw.replace(/^iMessage;/, 'any;');
  }
}
