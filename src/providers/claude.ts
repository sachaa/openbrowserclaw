// ---------------------------------------------------------------------------
// OpenBrowserClaw — Claude Provider (Anthropic API)
// ---------------------------------------------------------------------------

import type {
  LLMProvider,
  ProviderInfo,
  ProviderType,
  LoadProgressCallback,
  ModelInfo,
  ChatOptions,
  ChatWithToolsResult,
  ToolCallResult,
} from './types';
import type { ConversationMessage, TokenUsage, ToolDefinition } from '../types';
import { ANTHROPIC_API_URL, ANTHROPIC_API_VERSION } from '../config';

// Available Claude models
const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    contextLength: 200000,
    capabilities: ['text-generation', 'vision', 'tool-use'],
    isLocal: false,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    contextLength: 200000,
    capabilities: ['text-generation', 'vision', 'tool-use'],
    isLocal: false,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    contextLength: 200000,
    capabilities: ['text-generation', 'vision', 'tool-use'],
    isLocal: false,
  },
];

/**
 * Claude Provider for Anthropic API
 */
export class ClaudeProvider implements LLMProvider {
  readonly name = 'Claude (Anthropic)';
  readonly type: ProviderType = 'claude';
  
  private apiKey: string = '';
  private model: string = 'claude-sonnet-4-6';
  private abortController: AbortController | null = null;
  private _info: ProviderInfo;

  constructor() {
    this._info = {
      name: this.name,
      requiresApiKey: true,
      features: {
        streaming: true,
        toolUse: true,
        vision: true,
      },
      limits: {
        maxTokens: 200000,
        rateLimit: null,
      },
    };
  }

  /** Provider information */
  get info(): ProviderInfo {
    return this._info;
  }

  /**
   * Check if provider is ready
   */
  isReady(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Initialize provider (no-op for Claude, just validates API key)
   */
  async initialize?(_onProgress?: LoadProgressCallback): Promise<void> {
    // No initialization needed for cloud API
  }

  /**
   * Set API key
   */
  setApiKey(key: string): void {
    this.apiKey = key;
  }

  /**
   * Set model
   */
  setModel(model: string): void {
    this.model = model;
  }

  /**
   * Get current model
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Get available models
   */
  async getModels(): Promise<ModelInfo[]> {
    return CLAUDE_MODELS;
  }

  /**
   * Create streaming chat generator
   */
  async *chatStream(
    messages: ConversationMessage[],
    options?: ChatOptions
  ): AsyncGenerator<string, void, unknown> {
    if (!this.apiKey) {
      throw new Error('API key not set');
    }

    this.abortController = new AbortController();
    const signal = options?.signal;
    
    if (signal) {
      signal.addEventListener('abort', () => {
        this.abortController?.abort();
      });
    }

    const body: Record<string, any> = {
      model: this.model,
      max_tokens: options?.maxTokens || 4096,
      messages: messages,
    };

    if (options?.systemPrompt) {
      body.system = options.systemPrompt;
    }

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Claude API error ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      // Emit token usage
      if (result.usage && options?.onTokenUsage) {
        options.onTokenUsage({
          groupId: '',
          inputTokens: result.usage.input_tokens || 0,
          outputTokens: result.usage.output_tokens || 0,
          cacheReadTokens: result.usage.cache_read_input_tokens || 0,
          cacheCreationTokens: result.usage.cache_creation_input_tokens || 0,
          contextLimit: 200000,
        });
      }

      // Extract text from response
      const textBlocks = result.content.filter(
        (block: any) => block.type === 'text'
      );
      
      const fullText = textBlocks
        .map((b: any) => b.text || '')
        .join('');

      // Yield in chunks for streaming effect
      const chunkSize = 10;
      for (let i = 0; i < fullText.length; i += chunkSize) {
        if (this.abortController?.signal.aborted) {
          return;
        }
        yield fullText.slice(i, i + chunkSize);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Simple chat completion
   */
  async chat(
    messages: ConversationMessage[],
    options?: ChatOptions
  ): Promise<ConversationMessage> {
    if (!this.apiKey) {
      throw new Error('API key not set');
    }

    this.abortController = new AbortController();
    const signal = options?.signal;
    
    if (signal) {
      signal.addEventListener('abort', () => {
        this.abortController?.abort();
      });
    }

    const body: Record<string, any> = {
      model: this.model,
      max_tokens: options?.maxTokens || 4096,
      messages: messages,
    };

    if (options?.systemPrompt) {
      body.system = options.systemPrompt;
    }

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Claude API error ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      // Emit token usage
      if (result.usage && options?.onTokenUsage) {
        options.onTokenUsage({
          groupId: '',
          inputTokens: result.usage.input_tokens || 0,
          outputTokens: result.usage.output_tokens || 0,
          cacheReadTokens: result.usage.cache_read_input_tokens || 0,
          cacheCreationTokens: result.usage.cache_creation_input_tokens || 0,
          contextLimit: 200000,
        });
      }

      // Extract text from response
      const textBlocks = result.content.filter(
        (block: any) => block.type === 'text'
      );
      
      const text = textBlocks
        .map((b: any) => b.text || '')
        .join('');

      return {
        role: 'assistant',
        content: text,
      };
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Chat with tool support
   */
  async chatWithTools(
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions
  ): Promise<ChatWithToolsResult> {
    if (!this.apiKey) {
      throw new Error('API key not set');
    }

    this.abortController = new AbortController();
    const signal = options?.signal;
    
    if (signal) {
      signal.addEventListener('abort', () => {
        this.abortController?.abort();
      });
    }

    const body: Record<string, any> = {
      model: this.model,
      max_tokens: options?.maxTokens || 4096,
      messages: messages,
      tools: tools,
    };

    if (options?.systemPrompt) {
      body.system = options.systemPrompt;
    }

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Claude API error ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      // Emit token usage
      if (result.usage && options?.onTokenUsage) {
        options.onTokenUsage({
          groupId: '',
          inputTokens: result.usage.input_tokens || 0,
          outputTokens: result.usage.output_tokens || 0,
          cacheReadTokens: result.usage.cache_read_input_tokens || 0,
          cacheCreationTokens: result.usage.cache_creation_input_tokens || 0,
          contextLimit: 200000,
        });
      }

      // Check for tool use
      const toolUseBlocks = result.content.filter(
        (block: any) => block.type === 'tool_use'
      );

      if (toolUseBlocks.length > 0) {
        const toolCalls: ToolCallResult[] = toolUseBlocks.map((block: any) => ({
          name: block.name,
          arguments: block.input || {},
        }));

        return {
          message: {
            role: 'assistant',
            content: result.content,
          },
          toolCalls,
          hasToolCalls: true,
        };
      }

      // No tool use - extract text
      const textBlocks = result.content.filter(
        (block: any) => block.type === 'text'
      );
      
      const text = textBlocks
        .map((b: any) => b.text || '')
        .join('');

      return {
        message: {
          role: 'assistant',
          content: text,
        },
        toolCalls: [],
        hasToolCalls: false,
      };
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Abort ongoing request
   */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    this.abort();
    this.apiKey = '';
  }
}

export default ClaudeProvider;
