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
    });
  }

  stop(): void {
    this.running = false;
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
    const chatGuid = this._chatGuid(groupId);
    await this._post('/api/v1/message/text', { chatGuid, message: text });
  }

  setTyping(groupId: string, typing: boolean): void {
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
  // Extended methods (REST)
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

  async getMessages(groupId: string, opts?: { limit?: number; sort?: 'ASC' | 'DESC'; before?: number; after?: number }): Promise<RemoteMessage[]> {
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
      forceNew: true,
      autoConnect: false,
    });
    this.socket = socket;

    socket.on('connect_error', (err) => {
      console.error('[iMessage] connect_error:', err.message);
    });

    socket.on('auth-error', (err: { message: string; reason?: string }) => {
      console.error('[iMessage] auth-error:', err.message, err.reason ?? '');
    });

    socket.on('new-message', (msg: RemoteMessage) => {
      if (msg.guid && this.processedGuids.has(msg.guid)) return;
      if (msg.guid) this.processedGuids.set(msg.guid, Date.now());

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
}
