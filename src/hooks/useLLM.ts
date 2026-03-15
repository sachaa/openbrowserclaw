// ---------------------------------------------------------------------------
// OpenBrowserClaw — LLM React Hook
// ---------------------------------------------------------------------------

import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  LLMProvider,
  ProviderType,
  ProviderInfo,
  ModelInfo,
  ChatOptions,
  ModelLoadProgress,
} from '../providers';
import { createProvider, getAvailableProviders } from '../providers';
import type { ConversationMessage, TokenUsage } from '../types';

interface UseLLMState {
  /** Current provider instance */
  provider: LLMProvider | null;
  /** Provider type */
  providerType: ProviderType;
  /** Is provider ready for inference */
  isReady: boolean;
  /** Is model loading */
  isLoading: boolean;
  /** Loading progress (0-100) */
  loadingProgress: number;
  /** Loading status message */
  loadingStatus: string;
  /** Available providers info */
  availableProviders: ProviderInfo[];
  /** Is currently generating */
  isGenerating: boolean;
  /** Last error */
  error: string | null;
}

interface UseLLMActions {
  /** Switch provider type */
  setProviderType: (type: ProviderType) => Promise<void>;
  /** Set API key for cloud providers */
  setApiKey: (key: string) => void;
  /** Initialize the provider */
  initialize: () => Promise<void>;
  /** Send a message */
  sendMessage: (
    messages: ConversationMessage[],
    options?: ChatOptions
  ) => Promise<ConversationMessage>;
  /** Send a message with streaming */
  sendMessageStream: (
    messages: ConversationMessage[],
    onToken: (token: string) => void,
    options?: ChatOptions
  ) => Promise<ConversationMessage>;
  /** Get available models */
  getModels: () => Promise<ModelInfo[]>;
  /** Abort current operation */
  abort: () => void;
  /** Clear error */
  clearError: () => void;
}

export type UseLLMReturn = UseLLMState & UseLLMActions;

/**
 * React hook for LLM interactions
 */
export function useLLM(initialType: ProviderType = 'claude'): UseLLMReturn {
  const [state, setState] = useState<UseLLMState>({
    provider: null,
    providerType: initialType,
    isReady: false,
    isLoading: false,
    loadingProgress: 0,
    loadingStatus: '',
    availableProviders: [],
    isGenerating: false,
    error: null,
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  // Initialize provider on mount
  useEffect(() => {
    async function init() {
      try {
        // Get available providers
        const providers = await getAvailableProviders();
        
        setState(s => ({
          ...s,
          availableProviders: providers,
        }));

        // Create initial provider
        const provider = createProvider({ type: initialType });
        
        setState(s => ({
          ...s,
          provider,
          isReady: provider.isReady(),
        }));
      } catch (e) {
        setState(s => ({
          ...s,
          error: e instanceof Error ? e.message : 'Failed to initialize',
        }));
      }
    }
    
    init();
  }, [initialType]);

  /**
   * Switch provider type
   */
  const setProviderType = useCallback(async (type: ProviderType) => {
    setState(s => ({
      ...s,
      isLoading: true,
      loadingProgress: 0,
      loadingStatus: 'Initializing...',
      error: null,
    }));

    try {
      const provider = createProvider({ type });
      
      // Initialize if needed
      if (provider.initialize) {
        await provider.initialize((prog: ModelLoadProgress) => {
          setState(s => ({
            ...s,
            loadingProgress: prog.progress,
            loadingStatus: prog.status,
          }));
        });
      }

      setState(s => ({
        ...s,
        provider,
        providerType: type,
        isReady: provider.isReady(),
        isLoading: false,
        loadingProgress: 100,
        loadingStatus: 'Ready',
      }));
    } catch (e) {
      setState(s => ({
        ...s,
        isLoading: false,
        error: e instanceof Error ? e.message : 'Failed to switch provider',
      }));
    }
  }, []);

  /**
   * Set API key
   */
  const setApiKey = useCallback((key: string) => {
    if (state.provider?.setApiKey) {
      state.provider.setApiKey(key);
      setState(s => ({
        ...s,
        isReady: state.provider?.isReady() ?? false,
      }));
    }
  }, [state.provider]);

  /**
   * Initialize provider
   */
  const initialize = useCallback(async () => {
    if (!state.provider?.initialize) return;

    setState(s => ({
      ...s,
      isLoading: true,
      loadingProgress: 0,
      loadingStatus: 'Loading model...',
    }));

    try {
      await state.provider.initialize((prog: ModelLoadProgress) => {
        setState(s => ({
          ...s,
          loadingProgress: prog.progress,
          loadingStatus: prog.status,
        }));
      });

      setState(s => ({
        ...s,
        isReady: true,
        isLoading: false,
        loadingProgress: 100,
        loadingStatus: 'Ready',
      }));
    } catch (e) {
      setState(s => ({
        ...s,
        isLoading: false,
        error: e instanceof Error ? e.message : 'Initialization failed',
      }));
    }
  }, [state.provider]);

  /**
   * Send a message
   */
  const sendMessage = useCallback(async (
    messages: ConversationMessage[],
    options?: ChatOptions
  ): Promise<ConversationMessage> => {
    if (!state.provider) {
      throw new Error('Provider not initialized');
    }

    abortControllerRef.current = new AbortController();
    
    setState(s => ({ ...s, isGenerating: true, error: null }));

    try {
      const result = await state.provider.chat(messages, {
        ...options,
        signal: abortControllerRef.current.signal,
      });

      return result;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Generation failed';
      setState(s => ({ ...s, error: errorMsg }));
      throw e;
    } finally {
      setState(s => ({ ...s, isGenerating: false }));
      abortControllerRef.current = null;
    }
  }, [state.provider]);

  /**
   * Send a message with streaming
   */
  const sendMessageStream = useCallback(async (
    messages: ConversationMessage[],
    onToken: (token: string) => void,
    options?: ChatOptions
  ): Promise<ConversationMessage> => {
    if (!state.provider) {
      throw new Error('Provider not initialized');
    }

    abortControllerRef.current = new AbortController();
    
    setState(s => ({ ...s, isGenerating: true, error: null }));

    try {
      let fullContent = '';

      for await (const chunk of state.provider.chatStream(messages, {
        ...options,
        signal: abortControllerRef.current.signal,
        onToken,
      })) {
        fullContent += chunk;
        onToken(chunk);
      }

      return {
        role: 'assistant',
        content: fullContent,
      };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Generation failed';
      setState(s => ({ ...s, error: errorMsg }));
      throw e;
    } finally {
      setState(s => ({ ...s, isGenerating: false }));
      abortControllerRef.current = null;
    }
  }, [state.provider]);

  /**
   * Get available models
   */
  const getModels = useCallback(async (): Promise<ModelInfo[]> => {
    if (!state.provider) return [];
    return state.provider.getModels();
  }, [state.provider]);

  /**
   * Abort current operation
   */
  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
    state.provider?.abort();
    setState(s => ({ ...s, isGenerating: false }));
  }, [state.provider]);

  /**
   * Clear error
   */
  const clearError = useCallback(() => {
    setState(s => ({ ...s, error: null }));
  }, []);

  return {
    ...state,
    setProviderType,
    setApiKey,
    initialize,
    sendMessage,
    sendMessageStream,
    getModels,
    abort,
    clearError,
  };
}

export default useLLM;
