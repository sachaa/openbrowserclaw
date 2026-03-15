// ---------------------------------------------------------------------------
// OpenBrowserClaw — Provider Settings Component
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { Cloud, Cpu, Eye, EyeOff, Check, AlertCircle, Loader2 } from 'lucide-react';
import type { ProviderType, ProviderInfo } from '../../providers';
import { getAvailableProviders } from '../../providers';
import { getConfig, setConfig } from '../../db';
import { CONFIG_KEYS } from '../../config';
import { decryptValue } from '../../crypto';

interface ProviderSettingsProps {
  /** Current provider type */
  providerType: ProviderType;
  /** Callback when provider type changes */
  onProviderChange: (type: ProviderType) => void;
  /** Callback when API key changes */
  onApiKeyChange?: (key: string) => void;
}

export function ProviderSettings({
  providerType,
  onProviderChange,
  onApiKeyChange,
}: ProviderSettingsProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyMasked, setApiKeyMasked] = useState(true);
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [webGPUStatus, setWebGPUStatus] = useState<{ available: boolean; reason?: string } | null>(null);

  // Load providers and API key
  useEffect(() => {
    async function load() {
      try {
        // Get available providers
        const availableProviders = await getAvailableProviders();
        setProviders(availableProviders);
        
        // Check WebGPU status from ONNX provider
        const onnxInfo = availableProviders.find(p => p.name.includes('ONNX'));
        if (onnxInfo?.webGPUStatus) {
          setWebGPUStatus(onnxInfo.webGPUStatus);
        }

        // Load API key
        const encKey = await getConfig(CONFIG_KEYS.ANTHROPIC_API_KEY);
        if (encKey) {
          try {
            const dec = await decryptValue(encKey);
            setApiKey(dec);
          } catch {
            setApiKey('');
          }
        }
      } catch (e) {
        console.error('Failed to load provider settings:', e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function handleSaveApiKey() {
    await setConfig(CONFIG_KEYS.ANTHROPIC_API_KEY, apiKey.trim());
    onApiKeyChange?.(apiKey.trim());
    setApiKeySaved(true);
    setTimeout(() => setApiKeySaved(false), 2000);
  }

  function handleProviderChange(type: ProviderType) {
    onProviderChange(type);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-4">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ---- Provider Selection ---- */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2">
            <Cpu className="w-4 h-4" /> LLM Provider
          </h3>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {/* Claude (Cloud) Option */}
            <label 
              className={`
                flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors
                ${providerType === 'claude' 
                  ? 'border-primary bg-primary/10' 
                  : 'border-base-300 hover:border-base-400'}
              `}
            >
              <input
                type="radio"
                name="provider"
                value="claude"
                checked={providerType === 'claude'}
                onChange={() => handleProviderChange('claude')}
                className="radio radio-primary radio-sm mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2 font-medium">
                  <Cloud className="w-4 h-4" />
                  Claude (Cloud)
                </div>
                <p className="text-xs opacity-60 mt-1">
                  Uses Anthropic API. Requires API key. Best quality.
                </p>
              </div>
            </label>

            {/* ONNX (Local) Option */}
            <label 
              className={`
                flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors
                ${providerType === 'onnx' 
                  ? 'border-primary bg-primary/10' 
                  : 'border-base-300 hover:border-base-400'}
                ${!webGPUStatus?.available ? 'opacity-60' : ''}
              `}
            >
              <input
                type="radio"
                name="provider"
                value="onnx"
                checked={providerType === 'onnx'}
                onChange={() => handleProviderChange('onnx')}
                disabled={!webGPUStatus?.available}
                className="radio radio-primary radio-sm mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2 font-medium">
                  <Cpu className="w-4 h-4" />
                  ONNX (Local)
                </div>
                <p className="text-xs opacity-60 mt-1">
                  Runs locally in browser. No API key needed. Private.
                </p>
                {webGPUStatus && !webGPUStatus.available && (
                  <p className="text-xs text-warning mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {webGPUStatus.reason || 'WebGPU not available'}
                  </p>
                )}
              </div>
            </label>
          </div>
        </div>
      </div>

      {/* ---- API Key (only for Claude) ---- */}
      {providerType === 'claude' && (
        <div className="card card-bordered bg-base-200">
          <div className="card-body p-4 sm:p-6 gap-3">
            <h3 className="card-title text-base gap-2">
              <Cloud className="w-4 h-4" /> Anthropic API Key
            </h3>
            <div className="flex gap-2">
              <input
                type={apiKeyMasked ? 'password' : 'text'}
                className="input input-bordered input-sm w-full flex-1 font-mono"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setApiKeyMasked(!apiKeyMasked)}
              >
                {apiKeyMasked ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSaveApiKey}
                disabled={!apiKey.trim()}
              >
                Save
              </button>
              {apiKeySaved && (
                <span className="text-success text-sm flex items-center gap-1">
                  <Check className="w-4 h-4" /> Saved
                </span>
              )}
            </div>
            <p className="text-xs opacity-50">
              Your API key is encrypted and stored locally. It never leaves your browser.
            </p>
          </div>
        </div>
      )}

      {/* ---- Local Model Info (for ONNX) ---- */}
      {providerType === 'onnx' && (
        <div className="card card-bordered bg-base-200">
          <div className="card-body p-4 sm:p-6 gap-3">
            <h3 className="card-title text-base gap-2">
              <Cpu className="w-4 h-4" /> Local Model
            </h3>
            <div className="text-sm">
              <p><strong>Model:</strong> Qwen3.5-0.8B-ONNX</p>
              <p><strong>Size:</strong> ~500MB (downloaded once)</p>
              <p><strong>Context:</strong> 8192 tokens</p>
            </div>
            {webGPUStatus?.available && (
              <div className="badge badge-success badge-sm gap-1.5">
                <Check className="w-3 h-3" /> WebGPU available
              </div>
            )}
            <p className="text-xs opacity-50">
              The model will be downloaded on first use and cached in your browser.
              All processing happens locally on your device.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProviderSettings;
