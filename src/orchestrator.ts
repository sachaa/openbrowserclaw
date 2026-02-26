// ---------------------------------------------------------------------------
// OpenBrowserClaw — Orchestrator
// ---------------------------------------------------------------------------
//
// The orchestrator is the main thread coordinator. It manages:
// - State machine (idle → thinking → responding)
// - Message queue and routing
// - Agent worker lifecycle
// - Channel coordination
// - Task scheduling
//
// This mirrors NanoClaw's src/index.ts but adapted for browser primitives.

import type {
  InboundMessage,
  StoredMessage,
  WorkerOutbound,
  OrchestratorState,
  Task,
  ConversationMessage,
  ThinkingLogEntry,
} from './types.js';
import {
  ASSISTANT_NAME,
  CONFIG_KEYS,
  CONTEXT_WINDOW_SIZE,
DEFAULT_GROUP_ID,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_OLLAMA_URL,
  buildTriggerPattern,
} from './config.js';
import {
  openDatabase,
  saveMessage,
  getRecentMessages,
  buildConversationMessages,
  getConfig,
  setConfig,
  saveTask,
  clearGroupMessages,
} from './db.js';
import { readGroupFile } from './storage.js';
import { encryptValue, decryptValue } from './crypto.js';
import { BrowserChatChannel } from './channels/browser-chat.js';
import { TelegramChannel } from './channels/telegram.js';
import { Router } from './router.js';
import { TaskScheduler } from './task-scheduler.js';
import { ulid } from './ulid.js';

// ---------------------------------------------------------------------------
// Event emitter for UI updates
// ---------------------------------------------------------------------------

type EventMap = {
  'state-change': OrchestratorState;
  'message': StoredMessage;
  'typing': { groupId: string; typing: boolean };
  'tool-activity': { groupId: string; tool: string; status: string };
  'thinking-log': ThinkingLogEntry;
  'error': { groupId: string; error: string };
  'ready': void;
  'session-reset': { groupId: string };
  'context-compacted': { groupId: string; summary: string };
  'token-usage': import('./types.js').TokenUsage;
};

type EventCallback<T> = (data: T) => void;

class EventBus {
  private listeners = new Map<string, Set<EventCallback<any>>>();

  on<K extends keyof EventMap>(event: K, callback: EventCallback<EventMap[K]>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off<K extends keyof EventMap>(event: K, callback: EventCallback<EventMap[K]>): void {
    this.listeners.get(event)?.delete(callback);
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  readonly events = new EventBus();
  readonly browserChat = new BrowserChatChannel();
  readonly telegram = new TelegramChannel();

  private router!: Router;
  private scheduler!: TaskScheduler;
  private agentWorker!: Worker;
  private state: OrchestratorState = 'idle';
  private triggerPattern!: RegExp;
  private assistantName: string = ASSISTANT_NAME;
  private provider: 'anthropic' | 'ollama' = DEFAULT_PROVIDER;
  private ollamaUrl: string = DEFAULT_OLLAMA_URL;
  private apiKey: string = '';
  private model: string = DEFAULT_MODEL;
  private maxTokens: number = DEFAULT_MAX_TOKENS;
  private messageQueue: InboundMessage[] = [];
  private processing = false;
  private pendingScheduledTasks = new Set<string>();

  /**
   * Initialize the orchestrator. Must be called before anything else.
   */
  async init(): Promise<void> {
    // Open database
    await openDatabase();

    // Load config
       // Load config
    this.assistantName = (await getConfig(CONFIG_KEYS.ASSISTANT_NAME)) || ASSISTANT_NAME;
    this.triggerPattern = buildTriggerPattern(this.assistantName);
    this.provider =
      ((await getConfig(CONFIG_KEYS.PROVIDER)) as 'anthropic' | 'ollama') || DEFAULT_PROVIDER;
    this.ollamaUrl = (await getConfig(CONFIG_KEYS.OLLAMA_URL)) || DEFAULT_OLLAMA_URL;

    const storedKey = await getConfig(CONFIG_KEYS.ANTHROPIC_API_KEY);

    if (storedKey) {
      try {
        this.apiKey = await decryptValue(storedKey);
      } catch {
        // Stored as plaintext from before encryption — clear it
        this.apiKey = '';
        await setConfig(CONFIG_KEYS.ANTHROPIC_API_KEY, '');
      }
    }
    this.model = (await getConfig(CONFIG_KEYS.MODEL)) || DEFAULT_MODEL;
    this.maxTokens = parseInt(
      (await getConfig(CONFIG_KEYS.MAX_TOKENS)) || String(DEFAULT_MAX_TOKENS),
      10,
    );

    // Set up router
    this.router = new Router(this.browserChat, this.telegram);

    // Set up channels
    this.browserChat.onMessage((msg) => this.enqueue(msg));

    // Configure Telegram if token exists
    const telegramToken = await getConfig(CONFIG_KEYS.TELEGRAM_BOT_TOKEN);
    if (telegramToken) {
      const chatIdsRaw = await getConfig(CONFIG_KEYS.TELEGRAM_CHAT_IDS);
      const chatIds: string[] = chatIdsRaw ? JSON.parse(chatIdsRaw) : [];
      this.telegram.configure(telegramToken, chatIds);
      this.telegram.onMessage((msg) => this.enqueue(msg));
      this.telegram.start();
    }

    // Set up agent worker
    this.agentWorker = new Worker(
      new URL('./agent-worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.agentWorker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      this.handleWorkerMessage(event.data);
    };
    this.agentWorker.onerror = (err) => {
      console.error('Agent worker error:', err);
    };

    // Set up task scheduler
    this.scheduler = new TaskScheduler((groupId, prompt) =>
      this.invokeAgent(groupId, prompt),
    );
    this.scheduler.start();

    // Wire up browser chat display callback
    this.browserChat.onDisplay((groupId, text, isFromMe) => {
      // Display handled via events.emit('message', ...)
    });

    this.events.emit('ready', undefined);
  }

  /**
   * Get the current state.
   */
  getState(): OrchestratorState {
    return this.state;
  }

  getProvider(): 'anthropic' | 'ollama' {
    return this.provider;
  }

  async setProvider(val: 'anthropic' | 'ollama'): Promise<void> {
    this.provider = val;
    await setConfig(CONFIG_KEYS.PROVIDER, val);
  }

  getOllamaUrl(): string {
    return this.ollamaUrl;
  }

  async setOllamaUrl(val: string): Promise<void> {
    this.ollamaUrl = val;
    await setConfig(CONFIG_KEYS.OLLAMA_URL, val);
  }

  /**
   * Check if the AI provider is configured.
   */
  isConfigured(): boolean {
    if (this.provider === 'ollama') {
      return this.ollamaUrl.trim().length > 0;
    }
    return this.apiKey.length > 0;
  }

  /**
   * Update the API key.
   */
  async setApiKey(key: string): Promise<void> {
    this.apiKey = key;
    const encrypted = await encryptValue(key);
    await setConfig(CONFIG_KEYS.ANTHROPIC_API_KEY, encrypted);
  }

  /**
   * Get current model.
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Update the model.
   */
  async setModel(model: string): Promise<void> {
    this.model = model;
    await setConfig(CONFIG_KEYS.MODEL, model);
  }

  /**
   * Get assistant name.
   */
  getAssistantName(): string {
    return this.assistantName;
  }

  /**
   * Update assistant name and trigger pattern.
   */
  async setAssistantName(name: string): Promise<void> {
    this.assistantName = name;
    this.triggerPattern = buildTriggerPattern(name);
    await setConfig(CONFIG_KEYS.ASSISTANT_NAME, name);
  }

  /**
   * Configure Telegram.
   */
  async configureTelegram(token: string, chatIds: string[]): Promise<void> {
    await setConfig(CONFIG_KEYS.TELEGRAM_BOT_TOKEN, token);
    await setConfig(CONFIG_KEYS.TELEGRAM_CHAT_IDS, JSON.stringify(chatIds));
    this.telegram.configure(token, chatIds);
    this.telegram.onMessage((msg) => this.enqueue(msg));
    this.telegram.start();
  }

  /**
   * Submit a message from the browser chat UI.
   */
  submitMessage(text: string, groupId?: string): void {
    this.browserChat.submit(text, groupId);
  }

  /**
   * Start a completely new session — clears message history for the group.
   */
  async newSession(groupId: string = DEFAULT_GROUP_ID): Promise<void> {
    // Clear messages from DB
    await clearGroupMessages(groupId);
    this.events.emit('session-reset', { groupId });
  }

  /**
   * Compact (summarize) the current context to reduce token usage.
   * Asks Claude to produce a summary, then replaces the history with it.
   */
  async compactContext(groupId: string = DEFAULT_GROUP_ID): Promise<void> {
    if (!this.isConfigured()) {
      this.events.emit('error', {
        groupId,
        error: this.provider === 'anthropic'
          ? 'API key not configured. Cannot compact context.'
          : 'Ollama URL not configured. Cannot compact context.',
      });
      return;
    }

    if (this.state !== 'idle') {
      this.events.emit('error', {
        groupId,
        error: 'Cannot compact while processing. Wait for the current response to finish.',
      });
      return;
    }

    this.setState('thinking');
    this.events.emit('typing', { groupId, typing: true });

    // Load group memory
    let memory = '';
    try {
      memory = await readGroupFile(groupId, 'CLAUDE.md');
    } catch {
      // No memory file yet
    }

    const messages = await buildConversationMessages(groupId, CONTEXT_WINDOW_SIZE);
    const systemPrompt = buildSystemPrompt(this.assistantName, memory);

    this.agentWorker.postMessage({
      type: 'compact',
      payload: {
        groupId,
        messages,
        systemPrompt,
        provider: this.provider,
        apiKey: this.apiKey,
        ollamaUrl: this.ollamaUrl,
        model: this.model,
        maxTokens: this.maxTokens,
      },
    });
  }

  /**
   * Shut down everything.
   */
  shutdown(): void {
    this.scheduler.stop();
    this.telegram.stop();
    this.agentWorker.terminate();
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private setState(state: OrchestratorState): void {
    this.state = state;
    this.events.emit('state-change', state);
  }

  private async enqueue(msg: InboundMessage): Promise<void> {
    // Save to DB
    const stored: StoredMessage = {
      ...msg,
      isFromMe: false,
      isTrigger: false,
    };

    // Check trigger
    const isBrowserMain = msg.groupId === DEFAULT_GROUP_ID;
    const hasTrigger = this.triggerPattern.test(msg.content.trim());

    // Browser main group always triggers; other groups need the trigger pattern
    if (isBrowserMain || hasTrigger) {
      stored.isTrigger = true;
      this.messageQueue.push(msg);
    }

    await saveMessage(stored);
    this.events.emit('message', stored);

    // Process queue
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    if (this.messageQueue.length === 0) return;
    if (!this.isConfigured()) {
      // Can't process without configuration
      const msg = this.messageQueue.shift()!;
      this.events.emit('error', {
        groupId: msg.groupId,
        error: this.provider === 'anthropic'
          ? 'API key not configured. Go to Settings to add your Anthropic API key.'
          : 'Ollama URL not configured. Go to Settings to configure your Ollama Host.',
      });
      return;
    }

    this.processing = true;
    const msg = this.messageQueue.shift()!;

    try {
      await this.invokeAgent(msg.groupId, msg.content);
    } catch (err) {
      console.error('Failed to invoke agent:', err);
    } finally {
      this.processing = false;
      // Process next in queue
      if (this.messageQueue.length > 0) {
        this.processQueue();
      }
    }
  }

  private async invokeAgent(groupId: string, triggerContent: string): Promise<void> {
    this.setState('thinking');
    this.router.setTyping(groupId, true);
    this.events.emit('typing', { groupId, typing: true });

    // If this is a scheduled task, save the prompt as a user message so
    // it appears in conversation context and in the chat UI.
    if (triggerContent.startsWith('[SCHEDULED TASK]')) {
      this.pendingScheduledTasks.add(groupId);
      const stored: StoredMessage = {
        id: ulid(),
        groupId,
        sender: 'Scheduler',
        content: triggerContent,
        timestamp: Date.now(),
        channel: groupId.startsWith('tg:') ? 'telegram' : 'browser',
        isFromMe: false,
        isTrigger: true,
      };
      await saveMessage(stored);
      this.events.emit('message', stored);
    }

    // Load group memory
    let memory = '';
    try {
      memory = await readGroupFile(groupId, 'CLAUDE.md');
    } catch {
      // No memory file yet — that's fine
    }

    // Build conversation context
    const messages = await buildConversationMessages(groupId, CONTEXT_WINDOW_SIZE);

    const systemPrompt = buildSystemPrompt(this.assistantName, memory);

    // Send to agent worker
    this.agentWorker.postMessage({
      type: 'invoke',
      payload: {
        groupId,
        messages,
        systemPrompt,
        provider: this.provider,
        apiKey: this.apiKey,
        ollamaUrl: this.ollamaUrl,
        model: this.model,
        maxTokens: this.maxTokens,
      },
    });
  }

  private async handleWorkerMessage(msg: WorkerOutbound): Promise<void> {
    switch (msg.type) {
      case 'response': {
        const { groupId, text } = msg.payload;
        await this.deliverResponse(groupId, text);
        break;
      }

      case 'task-created': {
        const { task } = msg.payload;
        try {
          await saveTask(task);
        } catch (err) {
          console.error('Failed to save task from agent:', err);
        }
        break;
      }

      case 'error': {
        const { groupId, error } = msg.payload;
        await this.deliverResponse(groupId, `⚠️ Error: ${error}`);
        break;
      }

      case 'typing': {
        const { groupId } = msg.payload;
        this.router.setTyping(groupId, true);
        this.events.emit('typing', { groupId, typing: true });
        break;
      }

      case 'tool-activity': {
        this.events.emit('tool-activity', msg.payload);
        break;
      }

      case 'thinking-log': {
        this.events.emit('thinking-log', msg.payload);
        break;
      }

      case 'compact-done': {
        await this.handleCompactDone(msg.payload.groupId, msg.payload.summary);
        break;
      }

      case 'token-usage': {
        this.events.emit('token-usage', msg.payload);
        break;
      }
    }
  }

  private async handleCompactDone(groupId: string, summary: string): Promise<void> {
    // Clear old messages
    await clearGroupMessages(groupId);

    // Save the summary as a system-style message from the assistant
    const stored: StoredMessage = {
      id: ulid(),
      groupId,
      sender: this.assistantName,
      content: `📝 **Context Compacted**\n\n${summary}`,
      timestamp: Date.now(),
      channel: groupId.startsWith('tg:') ? 'telegram' : 'browser',
      isFromMe: true,
      isTrigger: false,
    };
    await saveMessage(stored);

    this.events.emit('context-compacted', { groupId, summary });
    this.events.emit('typing', { groupId, typing: false });
    this.setState('idle');
  }

  private async deliverResponse(groupId: string, text: string): Promise<void> {
    // Save to DB
    const stored: StoredMessage = {
      id: ulid(),
      groupId,
      sender: this.assistantName,
      content: text,
      timestamp: Date.now(),
      channel: groupId.startsWith('tg:') ? 'telegram' : 'browser',
      isFromMe: true,
      isTrigger: false,
    };
    await saveMessage(stored);

    // Route to channel
    await this.router.send(groupId, text);

    // Play notification chime for scheduled task responses
    if (this.pendingScheduledTasks.has(groupId)) {
      this.pendingScheduledTasks.delete(groupId);
      playNotificationChime();
    }

    // Emit for UI
    this.events.emit('message', stored);
    this.events.emit('typing', { groupId, typing: false });

    this.setState('idle');
    this.router.setTyping(groupId, false);
  }
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(assistantName: string, memory: string): string {
  const parts = [
    `You are ${assistantName}, a personal AI assistant running in the user's browser.`,
    '',
    'You have access to the following tools:',
    '- **bash**: Execute commands in a sandboxed Linux VM (Alpine). Use for scripts, text processing, package installation.',
    '- **javascript**: Execute JavaScript code. Lighter than bash — no VM boot needed. Use for calculations, data transforms.',
    '- **read_file** / **write_file** / **list_files**: Manage files in the group workspace (persisted in browser storage).',
    '- **fetch_url**: Make HTTP requests (subject to CORS).',
    '- **update_memory**: Persist important context to CLAUDE.md — loaded on every conversation.',
    '- **create_task**: Schedule recurring tasks with cron expressions.',
    '',
    'Guidelines:',
    '- Be concise and direct.',
    '- Use tools proactively when they help answer the question.',
    '- Update memory when you learn important preferences or context.',
    '- For scheduled tasks, confirm the schedule with the user.',
    '- Strip <internal> tags from your responses — they are for your internal reasoning only.',
  ];

  if (memory) {
    parts.push('', '## Persistent Memory', '', memory);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Notification chime (Web Audio API — no external files needed)
// ---------------------------------------------------------------------------

function playNotificationChime(): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    // Two-tone chime: C5 → E5
    const frequencies = [523.25, 659.25];
    for (let i = 0; i < frequencies.length; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = frequencies[i];

      gain.gain.setValueAtTime(0.3, now + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.4);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + i * 0.15);
      osc.stop(now + i * 0.15 + 0.4);
    }

    // Clean up context after sounds finish
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // AudioContext may not be available — fail silently
  }
}
