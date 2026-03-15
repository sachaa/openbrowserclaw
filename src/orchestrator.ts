// ---------------------------------------------------------------------------
// OpenBrowserClaw — Orchestrator
// ---------------------------------------------------------------------------
//
// The orchestrator is the main thread coordinator. It manages:
// - State machine (idle → thinking → responding)
// - Message queue and routing
// - Agent worker lifecycle (for Claude)
// - Local LLM provider (for ONNX models with streaming support)
// - Channel coordination
// - Task scheduling

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
  FETCH_MAX_RESPONSE,
  buildTriggerPattern,
  LOCAL_MODELS,
  type LocalModelId,
  DEFAULT_LOCAL_MODEL_ID,
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
import { readGroupFile, writeGroupFile, listGroupFiles } from './storage.js';
import { encryptValue, decryptValue } from './crypto.js';
import { BrowserChatChannel } from './channels/browser-chat.js';
import { TelegramChannel } from './channels/telegram.js';
import { Router } from './router.js';
import { TaskScheduler } from './task-scheduler.js';
import { ulid } from './ulid.js';
import type { ProviderType, ModelLoadProgress } from './providers';
import { ONNXProvider } from './providers';

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
  'provider-loading': { loading: boolean; progress: number; status: string };
  'streaming-aborted': { groupId: string };
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
  private apiKey: string = '';
  private model: string = DEFAULT_MODEL;
  private maxTokens: number = DEFAULT_MAX_TOKENS;
  private messageQueue: InboundMessage[] = [];
  private processing = false;
  private pendingScheduledTasks = new Set<string>();
  
  // Provider support
  private providerType: ProviderType = 'claude';
  private localProvider: ONNXProvider | null = null;
  private providerLoading = false;
  
  // Abort control for streaming
  private _abortStreaming: boolean = false;

  /**
   * Initialize the orchestrator. Must be called before anything else.
   */
  async init(): Promise<void> {
    await openDatabase();

    // Load configuration
    this.assistantName = (await getConfig(CONFIG_KEYS.ASSISTANT_NAME)) || ASSISTANT_NAME;
    this.triggerPattern = buildTriggerPattern(this.assistantName);
    
    const savedProvider = await getConfig(CONFIG_KEYS.LLM_PROVIDER_TYPE);
    if (savedProvider === 'claude' || savedProvider === 'onnx') {
      this.providerType = savedProvider;
    }
    
    const storedKey = await getConfig(CONFIG_KEYS.ANTHROPIC_API_KEY);
    if (storedKey) {
      try {
        this.apiKey = await decryptValue(storedKey);
      } catch {
        this.apiKey = '';
        await setConfig(CONFIG_KEYS.ANTHROPIC_API_KEY, '');
      }
    }
    this.model = (await getConfig(CONFIG_KEYS.MODEL)) || DEFAULT_MODEL;
    this.maxTokens = parseInt(
      (await getConfig(CONFIG_KEYS.MAX_TOKENS)) || String(DEFAULT_MAX_TOKENS),
      10,
    );

    this.router = new Router(this.browserChat, this.telegram);
    this.browserChat.onMessage((msg) => this.enqueue(msg));

    const telegramToken = await getConfig(CONFIG_KEYS.TELEGRAM_BOT_TOKEN);
    if (telegramToken) {
      const chatIdsRaw = await getConfig(CONFIG_KEYS.TELEGRAM_CHAT_IDS);
      const chatIds: string[] = chatIdsRaw ? JSON.parse(chatIdsRaw) : [];
      this.telegram.configure(telegramToken, chatIds);
      this.telegram.onMessage((msg) => this.enqueue(msg));
      this.telegram.start();
    }

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

    this.scheduler = new TaskScheduler((groupId, prompt) =>
      this.invokeAgent(groupId, prompt),
    );
    this.scheduler.start();

    this.events.emit('ready', undefined);
  }

  /**
   * Get current orchestrator state
   */
  getState(): OrchestratorState {
    return this.state;
  }

  /**
   * Get current provider type
   */
  getProviderType(): ProviderType {
    return this.providerType;
  }

  /**
   * Switch between Claude and local provider
   */
  async setProviderType(type: ProviderType): Promise<void> {
    this.providerType = type;
    await setConfig(CONFIG_KEYS.LLM_PROVIDER_TYPE, type);
    
    // Cleanup local provider when switching to Claude
    if (this.localProvider && type === 'claude') {
      await this.localProvider.dispose?.();
      this.localProvider = null;
    }
  }

  /**
   * Check if orchestrator is properly configured for the current provider
   */
  isConfigured(): boolean {
    if (this.providerType === 'onnx') {
      return true; // Local provider needs no API key
    }
    return this.apiKey.length > 0;
  }

  /**
   * Check if currently using local provider
   */
  isLocalProvider(): boolean {
    return this.providerType === 'onnx';
  }

  /**
   * Check WebGPU availability for local models
   */
  async checkWebGPU(): Promise<{ available: boolean; reason?: string }> {
    return ONNXProvider.checkWebGPU();
  }

  /**
   * Initialize local model provider with selected model
   */
  async initializeLocalProvider(
    onProgress?: (prog: ModelLoadProgress) => void
  ): Promise<void> {
    if (this.providerType !== 'onnx') {
      throw new Error('Not using local provider');
    }

    // Get saved model ID or use default
    const savedModelId = await getConfig(CONFIG_KEYS.LOCAL_MODEL_ID);
    const modelId = (savedModelId && savedModelId in LOCAL_MODELS) 
      ? savedModelId as LocalModelId 
      : DEFAULT_LOCAL_MODEL_ID;

    // Dispose existing provider if model changed
    if (this.localProvider && this.localProvider.modelId !== modelId) {
      await this.localProvider.dispose?.();
      this.localProvider = null;
    }

    // Skip if already ready
    if (this.localProvider && this.localProvider.isReady()) {
      return;
    }

    this.providerLoading = true;
    this.events.emit('provider-loading', { 
      loading: true, 
      progress: 0, 
      status: 'Initializing...' 
    });

    try {
      this.localProvider = new ONNXProvider(modelId);
      await this.localProvider.initialize((prog: ModelLoadProgress) => {
        // Check if aborted during initialization
        if (this._abortStreaming) {
          throw new Error('Initialization aborted');
        }
        this.events.emit('provider-loading', { 
          loading: true, 
          progress: prog.progress, 
          status: prog.status 
        });
        onProgress?.(prog);
      });

      this.events.emit('provider-loading', { 
        loading: false, 
        progress: 100, 
        status: 'Ready' 
      });
    } catch (error) {
      this.providerLoading = false;
      this.events.emit('provider-loading', { 
        loading: false, 
        progress: 0, 
        status: 'Failed to load model' 
      });
      throw error;
    } finally {
      this.providerLoading = false;
    }
  }

  /**
   * Check if local model is loaded and ready
   */
  isLocalProviderReady(): boolean {
    return this.localProvider?.isReady() ?? false;
  }

  /**
   * Abort ongoing streaming or model loading
   */
  abortStreaming(): void {
    this._abortStreaming = true;
    this.localProvider?.abort();
    
    // Reset after short delay
    setTimeout(() => {
      this._abortStreaming = false;
    }, 100);
  }

  /**
   * Set Claude API key
   */
  async setApiKey(key: string): Promise<void> {
    this.apiKey = key;
    const encrypted = await encryptValue(key);
    await setConfig(CONFIG_KEYS.ANTHROPIC_API_KEY, encrypted);
  }

  /**
   * Get current Claude model
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Set Claude model
   */
  async setModel(model: string): Promise<void> {
    this.model = model;
    await setConfig(CONFIG_KEYS.MODEL, model);
  }

  /**
   * Get assistant name
   */
  getAssistantName(): string {
    return this.assistantName;
  }

  /**
   * Set assistant name
   */
  async setAssistantName(name: string): Promise<void> {
    this.assistantName = name;
    this.triggerPattern = buildTriggerPattern(name);
    await setConfig(CONFIG_KEYS.ASSISTANT_NAME, name);
  }

  /**
   * Configure Telegram bot integration
   */
  async configureTelegram(token: string, chatIds: string[]): Promise<void> {
    await setConfig(CONFIG_KEYS.TELEGRAM_BOT_TOKEN, token);
    await setConfig(CONFIG_KEYS.TELEGRAM_CHAT_IDS, JSON.stringify(chatIds));
    this.telegram.configure(token, chatIds);
    this.telegram.onMessage((msg) => this.enqueue(msg));
    this.telegram.start();
  }

  /**
   * Submit a message from the browser UI
   */
  submitMessage(text: string, groupId?: string): void {
    this.browserChat.submit(text, groupId);
  }

  /**
   * Start a new session (clear conversation history)
   */
  async newSession(groupId: string = DEFAULT_GROUP_ID): Promise<void> {
    await clearGroupMessages(groupId);
    this.events.emit('session-reset', { groupId });
  }

  /**
   * Compact conversation context to reduce token usage
   */
  async compactContext(groupId: string = DEFAULT_GROUP_ID): Promise<void> {
    if (this.providerType === 'onnx') {
      this.events.emit('error', {
        groupId,
        error: 'Context compaction is not supported with local models yet.',
      });
      return;
    }

    if (!this.apiKey) {
      this.events.emit('error', {
        groupId,
        error: 'API key not configured. Cannot compact context.',
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

    let memory = '';
    try {
      memory = await readGroupFile(groupId, 'CLAUDE.md');
    } catch {}

    const messages = await buildConversationMessages(groupId, CONTEXT_WINDOW_SIZE);
    const systemPrompt = buildSystemPrompt(this.assistantName, memory);

    this.agentWorker.postMessage({
      type: 'compact',
      payload: {
        groupId,
        messages,
        systemPrompt,
        apiKey: this.apiKey,
        model: this.model,
        maxTokens: this.maxTokens,
      },
    });
  }

  /**
   * Shutdown and cleanup all resources
   */
  async shutdown(): Promise<void> {
    this.scheduler.stop();
    this.telegram.stop();
    this.agentWorker.terminate();
    
    if (this.localProvider) {
      await this.localProvider.dispose?.();
      this.localProvider = null;
    }
  }

  // -----------------------------------------------------------------------
  // Private methods
  // -----------------------------------------------------------------------

  private setState(state: OrchestratorState): void {
    this.state = state;
    this.events.emit('state-change', state);
  }

  private async enqueue(msg: InboundMessage): Promise<void> {
    const stored: StoredMessage = {
      ...msg,
      isFromMe: false,
      isTrigger: false,
    };

    const isBrowserMain = msg.groupId === DEFAULT_GROUP_ID;
    const hasTrigger = this.triggerPattern.test(msg.content.trim());

    if (isBrowserMain || hasTrigger) {
      stored.isTrigger = true;
      this.messageQueue.push(msg);
    }

    await saveMessage(stored);
    this.events.emit('message', stored);

    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    if (this.messageQueue.length === 0) return;
    
    if (this.providerType === 'claude' && !this.apiKey) {
      const msg = this.messageQueue.shift()!;
      this.events.emit('error', {
        groupId: msg.groupId,
        error: 'API key not configured. Go to Settings to add your Anthropic API key.',
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
      if (this.messageQueue.length > 0) {
        this.processQueue();
      }
    }
  }

  private async invokeAgent(groupId: string, triggerContent: string): Promise<void> {
    // Show thinking immediately for local models (before model loading)
    this.setState('thinking');
    this.router.setTyping(groupId, true);
    this.events.emit('typing', { groupId, typing: true });

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

    let memory = '';
    try {
      memory = await readGroupFile(groupId, 'CLAUDE.md');
    } catch {}

    const messages = await buildConversationMessages(groupId, CONTEXT_WINDOW_SIZE);
    const systemPrompt = buildSystemPrompt(this.assistantName, memory, this.providerType);

    if (this.providerType === 'onnx') {
      // Use streaming for local models
      await this.invokeLocalAgent(groupId, messages, systemPrompt);
    } else {
      this.agentWorker.postMessage({
        type: 'invoke',
        payload: {
          groupId,
          messages,
          systemPrompt,
          apiKey: this.apiKey,
          model: this.model,
          maxTokens: this.maxTokens,
        },
      });
    }
  }

  /**
   * Invoke local LLM agent with streaming response
   * Local models (Gemma, Qwen) are too small for reliable tool calling
   */
  private async invokeLocalAgent(
    groupId: string,
    messages: ConversationMessage[],
    systemPrompt: string
  ): Promise<void> {
    // Reset abort flag
    this._abortStreaming = false;
    
    try {
      // Show thinking indicator while loading model
      if (!this.localProvider || !this.localProvider.isReady()) {
        this.events.emit('thinking-log', {
          groupId,
          kind: 'info',
          timestamp: Date.now(),
          label: 'Loading model',
          detail: 'Initializing local model...',
        });
        
        await this.initializeLocalProvider();
        
        // Check if aborted during loading
        if (this._abortStreaming) {
          throw new Error('Aborted');
        }
      }

      this.events.emit('thinking-log', {
        groupId,
        kind: 'info',
        timestamp: Date.now(),
        label: 'Starting inference',
        detail: `Using ${this.localProvider?.modelId || 'local model'}`,
      });

      // Switch to responding state
      this.setState('responding');
      this.events.emit('typing', { groupId, typing: false });

      const tempId = 'streaming-' + Date.now();
      let fullResponse = '';

      // Stream tokens with throttling
      let lastUpdate = Date.now();
      const UPDATE_INTERVAL = 100; // Update every 100ms max

      for await (const token of this.localProvider!.chatStream(messages, {
        maxTokens: Math.min(this.maxTokens, 1024),
        systemPrompt: systemPrompt,
      })) {
        // Check for abort
        if (this._abortStreaming) {
          fullResponse += ' [stopped]';
          break;
        }

        fullResponse += token;

        const now = Date.now();
        if (now - lastUpdate > UPDATE_INTERVAL) {
          this.events.emit('message', {
            id: tempId,
            groupId,
            sender: this.assistantName,
            content: fullResponse,
            timestamp: Date.now(),
            channel: groupId.startsWith('tg:') ? 'telegram' : 'browser',
            isFromMe: true,
            isTrigger: false,
          } as StoredMessage);
          lastUpdate = now;
        }
      }

      // Final update with complete response
      await this.deliverResponse(groupId, fullResponse);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      
      // Don't show error if aborted intentionally
      if (errorMsg === 'Aborted' || this._abortStreaming) {
        this.events.emit('streaming-aborted', { groupId });
      } else {
        this.events.emit('error', {
          groupId,
          error: `Local model error: ${errorMsg}`,
        });
      }
      
      this.events.emit('typing', { groupId, typing: false });
      this.setState('idle');
    }
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
    await clearGroupMessages(groupId);

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

    await this.router.send(groupId, text);

    if (this.pendingScheduledTasks.has(groupId)) {
      this.pendingScheduledTasks.delete(groupId);
      playNotificationChime();
    }

    this.events.emit('message', stored);
    this.events.emit('typing', { groupId, typing: false });

    this.setState('idle');
    this.router.setTyping(groupId, false);
  }
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  assistantName: string, 
  memory: string,
  providerType: ProviderType = 'claude'
): string {
  const parts = [
    `You are ${assistantName}, a personal AI assistant running in the user's browser.`,
  ];
  
  if (providerType === 'onnx') {
    // Local model - simple chat mode, no tools
    parts.push(
      '',
      'You are a helpful AI assistant. You can have conversations, answer questions, and help with various tasks.',
      '',
      'Guidelines:',
      '- Be helpful, friendly, and concise.',
      '- If you don\'t know something, say so honestly.',
      '- You cannot execute commands, create files, or access the internet.',
      '- For tasks requiring those capabilities, suggest the user switch to Claude mode.',
    );
  } else {
    // Claude - full tool access
    parts.push(
      '',
      'You have access to the following tools:',
      '- **bash**: Execute commands in a sandboxed Linux VM (Alpine).',
      '- **javascript**: Execute JavaScript code.',
      '- **read_file** / **write_file** / **list_files**: Manage files.',
      '- **fetch_url**: Make HTTP requests.',
      '- **update_memory**: Persist important context.',
      '- **create_task**: Schedule recurring tasks.',
      '',
      'Guidelines:',
      '- Be concise and direct.',
      '- Use tools proactively when they help answer the question.',
      '- Update memory when you learn important preferences.',
      '- Strip <internal> tags from your responses.',
    );
  }

  if (memory) {
    parts.push('', '## Persistent Memory', '', memory);
  }

  return parts.join('\n');
}

/**
 * Strip HTML from text
 */
function stripHtml(html: string): string {
  let text = html;
  text = text.replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '');
  text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  return text;
}

// ---------------------------------------------------------------------------
// Notification chime
// ---------------------------------------------------------------------------

function playNotificationChime(): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

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

    setTimeout(() => ctx.close(), 1000);
  } catch {}
}