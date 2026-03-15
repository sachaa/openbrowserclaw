// ---------------------------------------------------------------------------
// OpenBrowserClaw — LLM Provider Types
// ---------------------------------------------------------------------------

import type { ConversationMessage, TokenUsage, ToolDefinition } from '../types';

/** Provider types available */
export type ProviderType = 'claude' | 'onnx';

/** Progress callback for model loading */
export type LoadProgressCallback = (progress: ModelLoadProgress) => void;

/** Model loading progress information */
export interface ModelLoadProgress {
  progress: number;      // 0-100
  status: string;        // Status message
  loaded?: number;       // Bytes loaded
  total?: number;        // Total bytes
  file?: string;         // Current file being loaded
}

/** Provider information */
export interface ProviderInfo {
  name: string;
  requiresApiKey: boolean;
  features: {
    streaming: boolean;
    toolUse: boolean;
    vision: boolean;
  };
  limits?: {
    maxTokens: number;
    rateLimit?: number | null;
  };
  webGPUStatus?: {
    available: boolean;
    reason?: string;
  };
}

/** Stream callback for token-by-token responses */
export type StreamCallback = (token: string) => void;

/** Model information */
export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  capabilities: string[];
  isLocal: boolean;
}

/** Options for chat completion */
export interface ChatOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  onToken?: StreamCallback;
  signal?: AbortSignal;
  onTokenUsage?: (usage: TokenUsage) => void;
}

/** Tool call result */
export interface ToolCallResult {
  name: string;
  arguments: Record<string, unknown>;
}

/** Result from chatWithTools */
export interface ChatWithToolsResult {
  message: ConversationMessage;
  toolCalls: ToolCallResult[];
  hasToolCalls: boolean;
}

/**
 * LLM Provider interface
 * All providers must implement this interface
 */
export interface LLMProvider {
  /** Provider display name */
  readonly name: string;
  
  /** Provider type identifier */
  readonly type: ProviderType;
  
  /** Get provider information and capabilities */
  info: ProviderInfo;
  
  /** Check if provider is ready for inference */
  isReady(): boolean;
  
  /** Initialize provider (load model, validate API key, etc.) */
  initialize?(onProgress?: LoadProgressCallback): Promise<void>;
  
  /** Get available models */
  getModels(): Promise<ModelInfo[]>;
  
  /** Set API key (for cloud providers) */
  setApiKey?(key: string): void;
  
  /** Simple chat completion */
  chat(messages: ConversationMessage[], options?: ChatOptions): Promise<ConversationMessage>;
  
  /** Streaming chat completion */
  chatStream(
    messages: ConversationMessage[],
    options?: ChatOptions
  ): AsyncGenerator<string, void, unknown>;
  
  /** Chat with tool support (Claude only) */
  chatWithTools?(
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions
  ): Promise<ChatWithToolsResult>;
  
  /** Parse tool calls from response text (Claude only) */
  parseToolCalls?(text: string): ToolCallResult[];
  
  /** Clean tool markers from response (Claude only) */
  cleanResponse?(text: string): string;
  
  /** Format tool result for next message (Claude only) */
  formatToolResult?(toolName: string, result: string): string;
  
  /** Abort ongoing operation */
  abort(): void;
  
  /** Cleanup resources */
  dispose?(): Promise<void>;
}

/** Provider configuration */
export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  modelUrl?: string;
  localModelId?: string;
}