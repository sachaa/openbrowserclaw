// ---------------------------------------------------------------------------
// OpenBrowserClaw — ONNX Provider (Local LLM - Chat Only, No Tools)
// ---------------------------------------------------------------------------

import type {
  LLMProvider,
  ProviderInfo,
  ProviderType,
  LoadProgressCallback,
  ModelInfo,
  ChatOptions,
} from './types';
import type { ConversationMessage } from '../types';
import {
  LOCAL_MODELS,
  type LocalModelId,
  DEFAULT_LOCAL_MODEL_ID,
} from '../config';

/**
 * Model architecture types
 */
type ModelArchitecture = 'pipeline' | 'qwen';

/**
 * Architecture mapping for local models
 */
const MODEL_ARCHITECTURES: Record<LocalModelId, ModelArchitecture> = {
  GEMMA_3_1B: 'pipeline',
  QWEN_3_5_0_8B: 'qwen',
};

/**
 * ONNX Provider for local LLM inference using Transformers.js
 * Supports different model architectures: pipeline (Gemma) and Qwen specific
 */
export class ONNXProvider implements LLMProvider {
  readonly name = 'ONNX (Local)';
  readonly type: ProviderType = 'onnx';
  
  private _generator: any = null;
  private _tokenizer: any = null;
  private _processor: any = null; // For Qwen architecture
  private _model: any = null;     // For Qwen architecture
  private _isLoading = false;
  private _isReady = false;
  private _info: ProviderInfo;
  private _modelId: LocalModelId;
  private _architecture: ModelArchitecture;
  private _abortController: AbortController | null = null;

  constructor(modelId: LocalModelId = DEFAULT_LOCAL_MODEL_ID) {
    this._modelId = modelId;
    this._architecture = MODEL_ARCHITECTURES[modelId];
    const modelConfig = LOCAL_MODELS[modelId];
    this._info = {
      name: `${modelConfig.name} (Local)`,
      requiresApiKey: false,
      features: {
        streaming: true,
        toolUse: false,
        vision: false,
      },
      limits: {
        maxTokens: modelConfig.contextLength,
        rateLimit: null,
      },
    };
  }

  get info(): ProviderInfo {
    return this._info;
  }
  
  get modelId(): LocalModelId {
    return this._modelId;
  }

  /**
   * Check WebGPU availability in the browser
   */
  static async checkWebGPU(): Promise<{ available: boolean; reason?: string }> {
    if (typeof navigator === 'undefined') {
      return { available: false, reason: 'Not in browser environment' };
    }
    
    const nav = navigator as Navigator & { gpu?: { requestAdapter: () => Promise<any> } };
    if (nav.gpu) {
      try {
        const adapter = await nav.gpu.requestAdapter();
        if (adapter) return { available: true };
        return { available: false, reason: 'No WebGPU adapter found' };
      } catch (e) {
        return { available: false, reason: `WebGPU error: ${e}` };
      }
    }
    return { available: false, reason: 'WebGPU not supported in this browser' };
  }

  /**
   * Load the ONNX model with progress reporting
   */
  private async loadModel(onProgress?: LoadProgressCallback): Promise<void> {
    if (this._isReady && (this._generator || this._model)) return;

    if (this._isLoading) {
      while (this._isLoading) {
        // Check for abort during loading wait
        if (this._abortController?.signal.aborted) {
          throw new Error('Model loading aborted');
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return;
    }

    this._isLoading = true;
    this._abortController = new AbortController();
    const modelConfig = LOCAL_MODELS[this._modelId];

    try {
      onProgress?.({ progress: 0, status: 'Initializing...' });

      // Check for abort
      if (this._abortController.signal.aborted) {
        throw new Error('Aborted');
      }

      const { pipeline, env } = await import('@huggingface/transformers');
      
      // Disable local models, fetch from Hugging Face
      env.allowLocalModels = false;

      // Check WebGPU availability
      const webGPU = await ONNXProvider.checkWebGPU();
      const useWebGPU = webGPU.available;
      
      onProgress?.({ 
        progress: 5, 
        status: useWebGPU ? 'WebGPU available' : 'Using CPU mode (slow)'
      });

      // Check abort before loading
      if (this._abortController.signal.aborted) {
        throw new Error('Aborted');
      }

      // Progress callback for model loading
      const progressCallback = (p: any) => {
        if (this._abortController?.signal.aborted) {
          throw new Error('Aborted');
        }
        if (p.status === 'progress' && typeof p.progress === 'number') {
          const scaledProgress = 5 + Math.round(p.progress * 90);
          onProgress?.({ 
            progress: Math.min(scaledProgress, 95), 
            status: p.file ? `Loading: ${p.file}` : 'Downloading model files...'
          });
        }
      };

      // Load model based on architecture
      if (this._architecture === 'qwen') {
        await this.loadQwenModel(useWebGPU, progressCallback);
      } else {
        await this.loadPipelineModel(useWebGPU, progressCallback);
      }

      onProgress?.({ progress: 100, status: 'Model ready!' });
      this._isReady = true;
    } catch (error) {
      console.error('Failed to load ONNX model:', error);
      throw new Error(
        `Failed to load local model. ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      this._isLoading = false;
      this._abortController = null;
    }
  }

  /**
   * Load Gemma model using pipeline API
   */
  private async loadPipelineModel(
    useWebGPU: boolean,
    progressCallback: (p: any) => void
  ): Promise<void> {
    const modelConfig = LOCAL_MODELS[this._modelId];
    const { pipeline, env } = await import('@huggingface/transformers');
    
    env.allowLocalModels = false;

    if (useWebGPU) {
      this._generator = await pipeline(
        'text-generation',
        modelConfig.id,
        {
          dtype: 'q4',
          device: 'webgpu',
          progress_callback: progressCallback,
        }
      );
    } else {
      this._generator = await pipeline(
        'text-generation',
        modelConfig.id,
        {
          dtype: 'fp32',
          progress_callback: progressCallback,
        }
      );
    }

    this._tokenizer = this._generator.tokenizer;
  }

  /**
   * Load Qwen model using specific Qwen3_5ForConditionalGeneration
   */
  private async loadQwenModel(
    useWebGPU: boolean,
    progressCallback: (p: any) => void
  ): Promise<void> {
    const modelConfig = LOCAL_MODELS[this._modelId];
    const { 
      AutoProcessor, 
      Qwen3_5ForConditionalGeneration,
      env 
    } = await import('@huggingface/transformers');
    
    env.allowLocalModels = false;

    // Load processor
    this._processor = await AutoProcessor.from_pretrained(modelConfig.id);

    // Load model with Qwen-specific dtype configuration
    if (useWebGPU) {
      this._model = await Qwen3_5ForConditionalGeneration.from_pretrained(
        modelConfig.id,
        {
          dtype: {
            embed_tokens: 'q4',
            vision_encoder: 'fp16',
            decoder_model_merged: 'q4',
          },
          device: 'webgpu',
          progress_callback: progressCallback,
        }
      );
    } else {
      this._model = await Qwen3_5ForConditionalGeneration.from_pretrained(
        modelConfig.id,
        {
          dtype: 'fp32',
          progress_callback: progressCallback,
        }
      );
    }

    this._tokenizer = this._processor.tokenizer;
  }

  /**
   * Check if provider is ready for inference
   */
  isReady(): boolean {
    if (this._architecture === 'qwen') {
      return this._isReady && this._model !== null && this._processor !== null;
    }
    return this._isReady && this._generator !== null;
  }

  /**
   * Initialize the provider and load the model
   */
  async initialize(onProgress?: LoadProgressCallback): Promise<void> {
    const webGPU = await ONNXProvider.checkWebGPU();
    this._info = { ...this._info, webGPUStatus: webGPU };
    await this.loadModel(onProgress);
  }

  /**
   * Get available models for this provider
   */
  async getModels(): Promise<ModelInfo[]> {
    return Object.entries(LOCAL_MODELS).map(([id, config]) => ({
      id: config.id,
      name: config.name,
      contextLength: config.contextLength,
      capabilities: ['text-generation'],
      isLocal: true,
    }));
  }

  /**
   * Build formatted messages for the chat template
   */
  private buildMessages(
    messages: ConversationMessage[],
    systemPrompt: string
  ): Array<{ role: string; content: string }> {
    const result: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt }
    ];

    for (const msg of messages) {
      let content = '';
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join('\n');
      }
      
      if (!content) continue;

      // Merge consecutive messages from same role
      const lastNonSystem = result.length > 1 ? result[result.length - 1] : null;
      
      if (lastNonSystem && lastNonSystem.role === msg.role) {
        lastNonSystem.content += '\n' + content;
      } else {
        result.push({ role: msg.role, content });
      }
    }

    // Ensure proper user/assistant alternation for chat models
    const systemMsg = result[0];
    const chatMessages = result.slice(1);
    
    const filtered: Array<{ role: string; content: string }> = [];
    let expectedRole: 'user' | 'assistant' = 'user';
    
    for (const msg of chatMessages) {
      if (msg.role === expectedRole) {
        filtered.push(msg);
        expectedRole = expectedRole === 'user' ? 'assistant' : 'user';
      }
    }

    return [systemMsg, ...filtered];
  }

  /**
   * Streaming chat completion
   */
  async *chatStream(
    messages: ConversationMessage[],
    options?: ChatOptions
  ): AsyncGenerator<string, void, unknown> {
    if (this._architecture === 'qwen') {
      yield* this.qwenChatStream(messages, options);
    } else {
      yield* this.pipelineChatStream(messages, options);
    }
  }

  /**
   * Streaming chat for pipeline-based models (Gemma)
   */
  private async *pipelineChatStream(
    messages: ConversationMessage[],
    options?: ChatOptions
  ): AsyncGenerator<string, void, unknown> {
    if (!this._generator) throw new Error('Pipeline not initialized');

    const { TextStreamer } = await import('@huggingface/transformers');
    
    const formattedMessages = this.buildMessages(
      messages, 
      options?.systemPrompt || 'You are a helpful assistant.'
    );

    let accumulatedText = '';
    let isComplete = false;
    let lastYieldedLength = 0;

    // Create custom streamer to capture tokens
    const streamer = new TextStreamer(this._tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (token: string) => {
        accumulatedText += token;
      },
    });

    // Start generation
    const generationPromise = this._generator(formattedMessages, {
      max_new_tokens: options?.maxTokens || 512,
      do_sample: false,
      streamer,
    });

    generationPromise
      .then(() => { isComplete = true; })
      .catch(() => { isComplete = true; });

    // Yield tokens as they arrive
    while (!isComplete) {
      // Check for abort
      if (this._abortController?.signal.aborted) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 50));
      
      if (accumulatedText.length > lastYieldedLength) {
        const newText = accumulatedText.slice(lastYieldedLength);
        lastYieldedLength = accumulatedText.length;
        yield newText;
      }
    }

    // Yield any remaining text
    if (accumulatedText.length > lastYieldedLength) {
      yield accumulatedText.slice(lastYieldedLength);
    }
  }

  /**
   * Streaming chat for Qwen architecture
   */
  private async *qwenChatStream(
    messages: ConversationMessage[],
    options?: ChatOptions
  ): AsyncGenerator<string, void, unknown> {
    if (!this._model || !this._processor) throw new Error('Qwen model not initialized');

    const { TextStreamer } = await import('@huggingface/transformers');
    
    // Build conversation
    const formattedMessages = this.buildMessages(
      messages,
      options?.systemPrompt || 'You are a helpful assistant.'
    );

    // Apply chat template
    const text = this._processor.apply_chat_template(formattedMessages, {
      add_generation_prompt: true,
    });

    // Prepare inputs
    const inputs = await this._processor(text);

    let accumulatedText = '';
    let isComplete = false;
    let lastYieldedLength = 0;

    // Create streamer
    const streamer = new TextStreamer(this._tokenizer, {
      skip_prompt: true,
      skip_special_tokens: false,
      callback_function: (token: string) => {
        accumulatedText += token;
      },
    });

    // Generate
    const generationPromise = this._model.generate({
      ...inputs,
      max_new_tokens: options?.maxTokens || 512,
      streamer,
    });

    generationPromise
      .then(() => { isComplete = true; })
      .catch(() => { isComplete = true; });

    // Stream results
    while (!isComplete) {
      // Check for abort
      if (this._abortController?.signal.aborted) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 50));
      
      if (accumulatedText.length > lastYieldedLength) {
        const newText = accumulatedText.slice(lastYieldedLength);
        lastYieldedLength = accumulatedText.length;
        yield newText;
      }
    }

    if (accumulatedText.length > lastYieldedLength) {
      yield accumulatedText.slice(lastYieldedLength);
    }
  }

  /**
   * Non-streaming chat completion
   */
  async chat(
    messages: ConversationMessage[],
    options?: ChatOptions
  ): Promise<ConversationMessage> {
    // Collect all chunks from streaming
    let fullContent = '';
    for await (const chunk of this.chatStream(messages, options)) {
      fullContent += chunk;
    }
    
    return { role: 'assistant', content: fullContent };
  }

  /**
   * Abort ongoing generation or loading
   */
  abort(): void {
    this._abortController?.abort();
    this._abortController = null;
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    this._generator = null;
    this._tokenizer = null;
    this._processor = null;
    this._model = null;
    this._isReady = false;
    this._abortController = null;
  }
}

export default ONNXProvider;