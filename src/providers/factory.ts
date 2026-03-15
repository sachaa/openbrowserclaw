// ---------------------------------------------------------------------------
// OpenBrowserClaw — Provider Factory
// ---------------------------------------------------------------------------

import type { LLMProvider, ProviderType, ProviderInfo, ProviderConfig } from './types';
import { ClaudeProvider } from './claude';
import { ONNXProvider } from './onnx';

/**
 * Create a provider instance
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.type) {
    case 'claude': {
      const provider = new ClaudeProvider();
      if (config.apiKey) {
        provider.setApiKey(config.apiKey);
      }
      return provider;
    }
    case 'onnx':
      return new ONNXProvider();
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

/**
 * Get list of available providers info
 */
export async function getAvailableProviders(): Promise<ProviderInfo[]> {
  const list: ProviderInfo[] = [];
  
  // Always add Claude provider
  list.push(new ClaudeProvider().info);
  
  // Add ONNX provider with WebGPU status
  const onnxProvider = new ONNXProvider();
  const info = onnxProvider.info;
  
  // Check WebGPU status
  const gpu = await ONNXProvider.checkWebGPU();
  info.webGPUStatus = gpu;
  
  list.push(info);
  
  return list;
}

/**
 * Get provider by type
 */
export function getProviderByType(type: ProviderType): LLMProvider {
  return createProvider({ type });
}

/**
 * Check if a provider type is available
 */
export function isProviderAvailable(type: ProviderType): boolean {
  return type === 'claude' || type === 'onnx';
}

// Re-export types and providers
export type {
  LLMProvider,
  ProviderType,
  ProviderInfo,
  ProviderConfig,
  LoadProgressCallback,
  ModelLoadProgress,
  ModelInfo,
  ChatOptions,
  ChatWithToolsResult,
  ToolCallResult,
  StreamCallback,
} from './types';

export { ClaudeProvider } from './claude';
export { ONNXProvider } from './onnx';
