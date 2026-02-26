// ---------------------------------------------------------------------------
// OpenBrowserClaw — Shared types
// ---------------------------------------------------------------------------

/** Inbound message from any channel */
export interface InboundMessage {
  id: string;
  groupId: string; // "br:main", "tg:-100123456"
  sender: string;
  content: string;
  timestamp: number; // epoch ms
  channel: ChannelType;
}

/** Stored message (superset of InboundMessage) */
export interface StoredMessage extends InboundMessage {
  isFromMe: boolean;
  isTrigger: boolean;
}

/** Scheduled task */
export interface Task {
  id: string;
  groupId: string;
  schedule: string; // cron expression
  prompt: string;
  enabled: boolean;
  lastRun: number | null;
  createdAt: number;
}

/** Session state per group */
export interface Session {
  groupId: string;
  messages: ConversationMessage[];
  updatedAt: number;
}

/** A message in the Claude API conversation format */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** Content block for tool use conversations */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/** Config entry */
export interface ConfigEntry {
  key: string;
  value: string; // JSON-encoded or raw string
}

export type ChannelType = 'browser' | 'telegram';

/** Channel interface — matches NanoClaw's Channel abstraction */
export interface Channel {
  readonly type: ChannelType;
  start(): void;
  stop(): void;
  send(groupId: string, text: string): Promise<void>;
  setTyping(groupId: string, typing: boolean): void;
  onMessage(callback: (msg: InboundMessage) => void): void;
}

/** Messages sent from main thread → Agent Worker */
export type WorkerInbound =
  | { type: 'invoke'; payload: InvokePayload }
  | { type: 'cancel'; payload: { groupId: string } }
  | { type: 'compact'; payload: CompactPayload };

export interface CompactPayload {
  groupId: string;
  messages: ConversationMessage[];
  systemPrompt: string;
  provider: 'anthropic' | 'ollama';
  apiKey: string;
  ollamaUrl: string;
  model: string;
  maxTokens: number;
}

export interface InvokePayload {
  groupId: string;
  messages: ConversationMessage[];
  systemPrompt: string;
  provider: 'anthropic' | 'ollama';
  apiKey: string;
  ollamaUrl: string;
  model: string;
  maxTokens: number;
}


/** Messages sent from Agent Worker → main thread */
export type WorkerOutbound =
  | { type: 'response'; payload: { groupId: string; text: string } }
  | { type: 'error'; payload: { groupId: string; error: string } }
  | { type: 'typing'; payload: { groupId: string } }
  | { type: 'tool-activity'; payload: { groupId: string; tool: string; status: string } }
  | { type: 'thinking-log'; payload: ThinkingLogEntry }
  | { type: 'compact-done'; payload: { groupId: string; summary: string } }
  | { type: 'token-usage'; payload: TokenUsage }
  | { type: 'task-created'; payload: { task: Task } };

/** Token usage info from the API */
export interface TokenUsage {
  groupId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextLimit: number;
}

/** A single entry in the thinking activity log */
export interface ThinkingLogEntry {
  groupId: string;
  kind: 'api-call' | 'tool-call' | 'tool-result' | 'text' | 'info';
  timestamp: number;
  label: string;
  detail?: string;
}

/** Tool definition for Claude API */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Orchestrator state machine */
export type OrchestratorState = 'idle' | 'thinking' | 'responding';

/** Group info for UI */
export interface GroupInfo {
  groupId: string;
  name: string;
  channel: ChannelType;
  lastActivity: number;
  unread: number;
}
