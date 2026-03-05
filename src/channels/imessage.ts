// ---------------------------------------------------------------------------
// OpenBrowserClaw — Photon iMessage Channel
// ---------------------------------------------------------------------------
//
// Supports two modes:
//   local  — @photon-ai/imessage-kit   (macOS only, direct SQLite DB access)
//   remote — direct socket.io + REST    (any OS, Photon server, browser-safe)
//
// groupId prefix: "im:"
// Examples:
//   DM:    im:iMessage;-;+918527438574
//   Group: im:iMessage;+;chat143843922472236064
//
// Remote mode connects directly to the Photon server using socket.io-client
// and fetch(). No Node.js dependencies — works in the browser.
// ---------------------------------------------------------------------------

import { io, type Socket } from 'socket.io-client';
import type { Channel, InboundMessage } from '../types.js';

type MessageCallback = (msg: InboundMessage) => void;

// ---------------------------------------------------------------------------
// Local-mode types (Node only — @photon-ai/imessage-kit)
// ---------------------------------------------------------------------------

interface LocalSDK {
  send(to: string, content: string | { text?: string; images?: string[]; files?: string[] }): Promise<{ message?: { guid?: string } }>;
  getMessages(filter: { chatId?: string; search?: string; limit?: number; since?: Date; unreadOnly?: boolean }): Promise<{ messages: LocalMessage[] }>;
  getUnreadMessages(): Promise<{ groups: Array<{ sender: string; messages: LocalMessage[] }>; total: number; senderCount: number }>;
  listChats(opts?: { type?: 'all' | 'dm' | 'group'; hasUnread?: boolean; limit?: number; search?: string }): Promise<LocalChat[]>;
  startWatching(events: { onMessage: (msg: LocalMessage) => void; onError?: (err: Error) => void }): Promise<void>;
  stopWatching(): void;
  close(): Promise<void>;
}

interface LocalMessage {
  guid: string;
  text: string | null;
  sender: string;
  senderName?: string;
  chatId: string;
  isGroupChat: boolean;
  isFromMe: boolean;
  date: Date;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>;
}

interface LocalChat {
  chatId: string;
  displayName: string;
  isGroup: boolean;
  unreadCount: number;
}

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

interface RemoteChat {
  guid: string;
  displayName: string;
  chatIdentifier: string;
  style: number;
  participants?: unknown[];
  isArchived?: boolean;
}

// ---------------------------------------------------------------------------
// MESSAGE_EFFECTS — iMessage bubble/screen effect identifiers
// ---------------------------------------------------------------------------

export const MESSAGE_EFFECTS = {
  slam:         'com.apple.MobileSMS.expressivesend.impact',
  loud:         'com.apple.MobileSMS.expressivesend.loud',
  gentle:       'com.apple.MobileSMS.expressivesend.gentle',
  invisibleInk: 'com.apple.MobileSMS.expressivesend.invisibleink',
  confetti:     'com.apple.messages.effect.CKConfettiEffect',
  balloons:     'com.apple.messages.effect.CKBalloonEffect',
  fireworks:    'com.apple.messages.effect.CKFireworksEffect',
  shooting:     'com.apple.messages.effect.CKShootingStarEffect',
  lasers:       'com.apple.messages.effect.CKLasersEffect',
  love:         'com.apple.messages.effect.CKHeartEffect',
  celebration:  'com.apple.messages.effect.CKSpotlightEffect',
  echo:         'com.apple.messages.effect.CKEchoEffect',
} as const;

export type MessageEffect = typeof MESSAGE_EFFECTS[keyof typeof MESSAGE_EFFECTS];

// ---------------------------------------------------------------------------
// IMessageChannel
// ---------------------------------------------------------------------------

export type IMessageMode = 'disabled' | 'local' | 'remote';

export interface IMessageConfig {
  mode: IMessageMode;
  serverUrl?: string;
  apiKey?: string;
}

export class IMessageChannel implements Channel {
  readonly type = 'imessage' as const;

  private mode: IMessageMode = 'disabled';
  private serverUrl = '';
  private apiKey = '';

  private localSdk: LocalSDK | null = null;

  // Remote mode — raw socket + server URL for REST calls
  private socket: Socket | null = null;
  private processedGuids = new Map<string, number>();
  private guidCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly GUID_TTL_MS = 5 * 60 * 1000;

  private messageCallback: MessageCallback | null = null;
  private running = false;

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  configure(config: IMessageConfig): void {
    this.mode = config.mode;
    this.serverUrl = (config.serverUrl ?? '').replace(/\/+$/, '');
    this.apiKey = config.apiKey ?? '';
  }

  // -----------------------------------------------------------------------
  // Channel interface
  // -----------------------------------------------------------------------

  start(): void {
    if (this.mode === 'disabled') {
      console.warn('[iMessage] start() called but mode is disabled');
      return;
    }
    if (this.running) {
      console.log('[iMessage] already running — skipping duplicate start()');
      return;
    }
    this.running = true;

    console.log(`[iMessage] starting in ${this.mode} mode`);

    if (this.mode === 'local') {
      this._startLocal().catch((err) => {
        console.error('[iMessage] local start error:', err);
      });
    } else {
      this._startRemote().catch((err) => {
        console.error('[iMessage] remote start error:', err);
      });
    }
  }

  stop(): void {
    console.log('[iMessage] stop() called, running was:', this.running);
    this.running = false;
    if (this.guidCleanupTimer) {
      clearInterval(this.guidCleanupTimer);
      this.guidCleanupTimer = null;
    }
    this.processedGuids.clear();
    if (this.mode === 'local' && this.localSdk) {
      this.localSdk.stopWatching();
      this.localSdk.close().catch(() => {});
      this.localSdk = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  async send(groupId: string, text: string): Promise<void> {
    if (this.mode === 'local') {
      const sdk = this._requireLocal('send');
      await sdk.send(this._localTarget(groupId), text);
    } else if (this.mode === 'remote') {
      const chatGuid = this._chatGuid(groupId);
      await this._post('/api/v1/message/text', { chatGuid, message: text });
    }
  }

  setTyping(groupId: string, typing: boolean): void {
    if (this.mode !== 'remote') return;
    const chatGuid = this._chatGuid(groupId);
    const encoded = encodeURIComponent(chatGuid);
    if (typing) {
      this._post(`/api/v1/chat/${encoded}/typing`, {}).catch(() => {});
      setTimeout(() => {
        this._delete(`/api/v1/chat/${encoded}/typing`).catch(() => {});
      }, 3000);
    } else {
      this._delete(`/api/v1/chat/${encoded}/typing`).catch(() => {});
    }
  }

  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  // -----------------------------------------------------------------------
  // Extended local-mode methods
  // -----------------------------------------------------------------------

  async getMessagesLocal(groupId: string, opts?: { limit?: number; since?: Date }): Promise<LocalMessage[]> {
    const sdk = this._requireLocal('getMessagesLocal');
    const result = await sdk.getMessages({ chatId: this._chatGuid(groupId), ...opts });
    return result.messages;
  }

  async searchMessagesLocal(keyword: string, opts?: { limit?: number }): Promise<LocalMessage[]> {
    const sdk = this._requireLocal('searchMessagesLocal');
    const result = await sdk.getMessages({ search: keyword, limit: opts?.limit ?? 20 });
    return result.messages;
  }

  async getUnreadMessagesLocal(): Promise<{ groups: Array<{ sender: string; messages: LocalMessage[] }>; total: number; senderCount: number }> {
    return this._requireLocal('getUnreadMessagesLocal').getUnreadMessages();
  }

  async listChatsLocal(opts?: { type?: 'all' | 'dm' | 'group'; hasUnread?: boolean; limit?: number; search?: string }): Promise<LocalChat[]> {
    return this._requireLocal('listChatsLocal').listChats(opts);
  }

  // -----------------------------------------------------------------------
  // Extended remote-mode methods (REST)
  // -----------------------------------------------------------------------

  async editMessage(messageGuid: string, editedMessage: string): Promise<void> {
    await this._post(`/api/v1/message/${encodeURIComponent(messageGuid)}/edit`, {
      editedMessage,
      backwardsCompatibilityMessage: editedMessage,
      partIndex: 0,
    });
  }

  async addReaction(groupId: string, messageGuid: string, reaction: string): Promise<void> {
    await this._post('/api/v1/message/react', {
      chatGuid: this._chatGuid(groupId),
      selectedMessageGuid: messageGuid,
      reaction,
      partIndex: 0,
    });
  }

  async removeReaction(groupId: string, messageGuid: string, reaction: string): Promise<void> {
    await this._post('/api/v1/message/react', {
      chatGuid: this._chatGuid(groupId),
      selectedMessageGuid: messageGuid,
      reaction: `-${reaction}`,
      partIndex: 0,
    });
  }

  async getMessagesRemote(groupId: string, opts?: { limit?: number; sort?: 'ASC' | 'DESC'; before?: number; after?: number }): Promise<RemoteMessage[]> {
    const res = await this._post('/api/v1/message/query', {
      chatGuid: this._chatGuid(groupId),
      with: ['chat', 'handle', 'attachment'],
      ...opts,
    });
    return res as RemoteMessage[];
  }

  async getChatInfo(groupId: string): Promise<RemoteChat> {
    const chatGuid = this._chatGuid(groupId);
    const res = await this._get(`/api/v1/chat/${encodeURIComponent(chatGuid)}`);
    return res as RemoteChat;
  }

  async createPoll(groupId: string, title: string, options: string[]): Promise<{ guid: string }> {
    const res = await this._post('/api/v1/poll', {
      chatGuid: this._chatGuid(groupId),
      title,
      options,
    });
    return res as { guid: string };
  }

  // -----------------------------------------------------------------------
  // Private — start helpers
  // -----------------------------------------------------------------------

  private async _startLocal(): Promise<void> {
    const localPkg = '@photon-ai/imessage-kit';
    const { IMessageSDK } = await import(/* @vite-ignore */ localPkg);
    const sdk = new IMessageSDK() as unknown as LocalSDK;
    this.localSdk = sdk;

    await sdk.startWatching({
      onMessage: (msg: LocalMessage) => {
        if (msg.isFromMe) return;
        if (!this.messageCallback) return;
        this.messageCallback({
          id: msg.guid,
          groupId: `im:${msg.chatId}`,
          sender: msg.sender,
          content: msg.text ?? '',
          timestamp: msg.date.getTime(),
          channel: 'imessage',
        });
      },
      onError: (err: Error) => {
        console.error('[iMessage] watcher error:', err);
      },
    });
  }

  private async _startRemote(): Promise<void> {
    if (!this.serverUrl) {
      console.error('[iMessage] no serverUrl configured');
      return;
    }
    console.log('[iMessage] connecting to', this.serverUrl, 'hasKey:', !!this.apiKey);

    // Clean up any existing socket before creating a new one
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    const socket = io(this.serverUrl, {
      auth: this.apiKey ? { apiKey: this.apiKey } : undefined,
      transports: ['websocket'],
      timeout: 10_000,
      forceNew: true,
      autoConnect: false,
    });
    this.socket = socket;

    // Wire up ALL listeners BEFORE calling connect(), so we never miss events.

    socket.on('connect', () => {
      console.log('[iMessage] socket connected (id:', socket.id + '), waiting for server ready...');
    });

    // Different server versions emit different ready events
    const onReady = () => {
      console.log('[iMessage] server ready — listening for new-message events');
    };
    socket.on('hello-world', onReady);
    socket.on('auth-ok', onReady);

    socket.on('connect_error', (err) => {
      console.error('[iMessage] connect_error:', err.message);
    });

    socket.on('auth-error', (err: { message: string; reason?: string }) => {
      console.error('[iMessage] auth-error:', err.message, err.reason ?? '');
    });

    socket.on('new-message', (msg: RemoteMessage) => {
      if (msg.guid && this.processedGuids.has(msg.guid)) return;
      if (msg.guid) this.processedGuids.set(msg.guid, Date.now());

      console.log('[iMessage] new-message:', {
        guid: msg.guid,
        text: msg.text?.slice(0, 50),
        isFromMe: msg.isFromMe,
        sender: msg.handle?.address,
        chatGuid: msg.chats?.[0]?.guid,
      });

      if (!this.messageCallback) return;
      if (msg.isFromMe) return;
      if (msg.associatedMessageGuid) return;

      const chatGuid = msg.chats?.[0]?.guid ?? '';
      this.messageCallback({
        id: msg.guid,
        groupId: `im:${chatGuid}`,
        sender: msg.handle?.address ?? 'unknown',
        content: msg.text ?? '',
        timestamp: msg.dateCreated,
        channel: 'imessage',
      });
    });

    socket.on('disconnect', (reason) => {
      console.warn('[iMessage] disconnected:', reason);
      if (!this.running) return;
      if (reason === 'io server disconnect') {
        console.log('[iMessage] server kicked us — reconnecting...');
        socket.connect();
      }
    });

    // Log any unhandled events for debugging
    socket.onAny((event, ...args) => {
      if (['connect', 'hello-world', 'auth-ok', 'connect_error', 'auth-error', 'new-message', 'disconnect'].includes(event)) return;
      console.log('[iMessage] event:', event, JSON.stringify(args).slice(0, 200));
    });

    // Periodically prune stale guids to prevent unbounded memory growth
    if (!this.guidCleanupTimer) {
      this.guidCleanupTimer = setInterval(() => {
        const cutoff = Date.now() - IMessageChannel.GUID_TTL_MS;
        for (const [guid, ts] of this.processedGuids) {
          if (ts < cutoff) this.processedGuids.delete(guid);
        }
      }, 60_000);
    }

    // NOW connect — all listeners are already in place
    socket.connect();
  }

  // -----------------------------------------------------------------------
  // Private — REST helpers
  // -----------------------------------------------------------------------

  private async _post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.serverUrl}${path}`, {
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

  private async _get(path: string): Promise<unknown> {
    const res = await fetch(`${this.serverUrl}${path}`, {
      headers: this.apiKey ? { 'X-API-Key': this.apiKey } : {},
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[iMessage] GET ${path} failed ${res.status}: ${text}`);
    }
    const json = await res.json();
    return json.data ?? json;
  }

  private async _delete(path: string): Promise<void> {
    await fetch(`${this.serverUrl}${path}`, {
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

  private _localTarget(groupId: string): string {
    const chatGuid = this._chatGuid(groupId);
    if (chatGuid.includes(';+;chat') || (chatGuid.startsWith('chat') && !chatGuid.includes(';'))) {
      return chatGuid;
    }
    return chatGuid.split(';').pop() ?? chatGuid;
  }

  private _requireLocal(method: string): LocalSDK {
    if (!this.localSdk) {
      throw new Error(`[iMessage] ${method}: local SDK not initialised. Call start() first and ensure mode is 'local'.`);
    }
    return this.localSdk;
  }
}
