// ---------------------------------------------------------------------------
// OpenBrowserClaw — Settings page
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import {
  Palette, KeyRound, Eye, EyeOff, Bot, MessageSquare,
  Smartphone, HardDrive, Lock, Check, AlertCircle, Loader2, Cpu, Cloud,
  Download, Trash2, Info,
} from 'lucide-react';
import { getConfig, setConfig } from '../../db.js';
import { CONFIG_KEYS, LOCAL_MODELS, type LocalModelId, DEFAULT_LOCAL_MODEL_ID } from '../../config.js';
import { getStorageEstimate, requestPersistentStorage } from '../../storage.js';
import { decryptValue } from '../../crypto.js';
import { getOrchestrator } from '../../stores/orchestrator-store.js';
import { useThemeStore, type ThemeChoice } from '../../stores/theme-store.js';
import type { ProviderType, ModelLoadProgress } from '../../providers';

const CLAUDE_MODELS = [
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

export function SettingsPage() {
  const orch = getOrchestrator();

  // Provider state
  const [providerType, setProviderType] = useState<ProviderType>('claude');
  const [webGPUStatus, setWebGPUStatus] = useState<{ available: boolean; reason?: string } | null>(null);
  
  // Local model state
  const [localModelId, setLocalModelId] = useState<LocalModelId>(DEFAULT_LOCAL_MODEL_ID);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoadProgress, setModelLoadProgress] = useState(0);
  const [modelLoadStatus, setModelLoadStatus] = useState('');
  const [modelReady, setModelReady] = useState(false);

  // Claude API key state
  const [apiKey, setApiKey] = useState('');
  const [apiKeyMasked, setApiKeyMasked] = useState(true);
  const [apiKeySaved, setApiKeySaved] = useState(false);

  // Claude model selection
  const [claudeModel, setClaudeModel] = useState(orch.getModel());

  // Assistant configuration
  const [assistantName, setAssistantName] = useState(orch.getAssistantName());

  // Telegram configuration
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatIds, setTelegramChatIds] = useState('');
  const [telegramSaved, setTelegramSaved] = useState(false);

  // Storage state
  const [storageUsage, setStorageUsage] = useState(0);
  const [storageQuota, setStorageQuota] = useState(0);
  const [isPersistent, setIsPersistent] = useState(false);

  // Theme state
  const { theme, setTheme } = useThemeStore();

  // Load saved configuration on mount
  useEffect(() => {
    async function loadConfiguration() {
      // Load provider type
      const savedProvider = await getConfig(CONFIG_KEYS.LLM_PROVIDER_TYPE);
      if (savedProvider === 'claude' || savedProvider === 'onnx') {
        setProviderType(savedProvider);
      }

      // Load local model selection
      const savedModelId = await getConfig(CONFIG_KEYS.LOCAL_MODEL_ID);
      if (savedModelId && savedModelId in LOCAL_MODELS) {
        setLocalModelId(savedModelId as LocalModelId);
      }

      // Check WebGPU support
      try {
        const gpu = await orch.checkWebGPU();
        setWebGPUStatus(gpu);
      } catch (e) {
        setWebGPUStatus({ available: false, reason: 'WebGPU check failed' });
      }

      // Check if local model is already loaded
      if (orch.isLocalProviderReady()) {
        setModelReady(true);
      }

      // Load Claude API key
      const encKey = await getConfig(CONFIG_KEYS.ANTHROPIC_API_KEY);
      if (encKey) {
        try {
          const dec = await decryptValue(encKey);
          setApiKey(dec);
        } catch {
          setApiKey('');
        }
      }

      // Load Telegram configuration
      const token = await getConfig(CONFIG_KEYS.TELEGRAM_BOT_TOKEN);
      if (token) setTelegramToken(token);
      
      const chatIds = await getConfig(CONFIG_KEYS.TELEGRAM_CHAT_IDS);
      if (chatIds) {
        try {
          setTelegramChatIds(JSON.parse(chatIds).join(', '));
        } catch {
          setTelegramChatIds(chatIds);
        }
      }

      // Load storage estimate
      const est = await getStorageEstimate();
      setStorageUsage(est.usage);
      setStorageQuota(est.quota);
      
      if (navigator.storage?.persisted) {
        setIsPersistent(await navigator.storage.persisted());
      }
    }
    loadConfiguration();
  }, []);

  // Subscribe to provider loading events from orchestrator
  useEffect(() => {
    const handleProviderLoading = (data: { loading: boolean; progress: number; status: string }) => {
      setModelLoading(data.loading);
      setModelLoadProgress(data.progress);
      setModelLoadStatus(data.status);
      if (!data.loading && data.progress === 100) {
        setModelReady(true);
      }
    };

    orch.events.on('provider-loading', handleProviderLoading);
    
    return () => {
      orch.events.off('provider-loading', handleProviderLoading);
    };
  }, [orch]);

  // Handle provider type change
  async function handleProviderChange(type: ProviderType) {
    setProviderType(type);
    await orch.setProviderType(type);
    await setConfig(CONFIG_KEYS.LLM_PROVIDER_TYPE, type);
    
    // Reset model ready state when switching providers
    if (type === 'claude') {
      setModelReady(false);
    } else {
      setModelReady(orch.isLocalProviderReady());
    }
  }

  // Handle local model selection change
  async function handleLocalModelChange(newModelId: LocalModelId) {
    setLocalModelId(newModelId);
    await setConfig(CONFIG_KEYS.LOCAL_MODEL_ID, newModelId);
    
    // Reset model status when changing model
    setModelReady(false);
    setModelLoadProgress(0);
  }

  // Initialize and download the selected local model
  async function handleInitializeLocalModel() {
    try {
      setModelLoading(true);
      await orch.initializeLocalProvider((prog: ModelLoadProgress) => {
        setModelLoadProgress(prog.progress);
        setModelLoadStatus(prog.status);
      });
      setModelReady(true);
    } catch (e) {
      console.error('Failed to initialize local model:', e);
    } finally {
      setModelLoading(false);
    }
  }

  // Unload the local model to free memory
  async function handleUnloadLocalModel() {
    await orch.shutdown();
    setModelReady(false);
    setModelLoadProgress(0);
    setModelLoadStatus('');
  }

  // Save Claude API key
  async function handleSaveApiKey() {
    await orch.setApiKey(apiKey.trim());
    setApiKeySaved(true);
    setTimeout(() => setApiKeySaved(false), 2000);
  }

  // Change Claude model
  async function handleClaudeModelChange(value: string) {
    setClaudeModel(value);
    await orch.setModel(value);
  }

  // Save assistant name
  async function handleAssistantNameSave() {
    await orch.setAssistantName(assistantName.trim());
  }

  // Save Telegram configuration
  async function handleTelegramSave() {
    const ids = telegramChatIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    await orch.configureTelegram(telegramToken.trim(), ids);
    setTelegramSaved(true);
    setTimeout(() => setTelegramSaved(false), 2000);
  }

  // Request persistent storage permission
  async function handleRequestPersistentStorage() {
    const granted = await requestPersistentStorage();
    setIsPersistent(granted);
  }

  const storagePercent = storageQuota > 0 ? (storageUsage / storageQuota) * 100 : 0;
  const currentLocalModel = LOCAL_MODELS[localModelId];

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 max-w-3xl mx-auto space-y-4">
      <h2 className="text-xl font-bold mb-4">Settings</h2>

      {/* Theme Settings */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2">
            <Palette className="w-4 h-4" /> Appearance
          </h3>
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Theme</legend>
            <select
              className="select select-bordered select-sm w-full"
              value={theme}
              onChange={(e) => setTheme(e.target.value as ThemeChoice)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </fieldset>
        </div>
      </div>

      {/* Provider Selection */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2">
            <Cpu className="w-4 h-4" /> LLM Provider
          </h3>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {/* Claude Cloud Option */}
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
                  Uses Anthropic API. Requires API key. Best quality with full tool support.
                </p>
              </div>
            </label>

            {/* Local ONNX Option */}
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
                  Local Model (ONNX)
                </div>
                <p className="text-xs opacity-60 mt-1">
                  Runs locally in browser. No API key needed. Private and offline-capable.
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

      {/* Claude API Key Configuration */}
      {providerType === 'claude' && (
        <div className="card card-bordered bg-base-200">
          <div className="card-body p-4 sm:p-6 gap-3">
            <h3 className="card-title text-base gap-2">
              <KeyRound className="w-4 h-4" /> Anthropic API Key
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
                title={apiKeyMasked ? 'Show API key' : 'Hide API key'}
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
                Save API Key
              </button>
              {apiKeySaved && (
                <span className="text-success text-sm flex items-center gap-1">
                  <Check className="w-4 h-4" /> Saved
                </span>
              )}
            </div>
            <p className="text-xs opacity-50">
              Your API key is encrypted with AES-GCM and stored locally in IndexedDB. 
              It never leaves your browser.
            </p>
          </div>
        </div>
      )}

      {/* Local Model Configuration */}
      {providerType === 'onnx' && (
        <div className="card card-bordered bg-base-200">
          <div className="card-body p-4 sm:p-6 gap-4">
            <h3 className="card-title text-base gap-2">
              <Cpu className="w-4 h-4" /> Local Model Configuration
            </h3>
            
            {/* Model Selection Dropdown */}
            <fieldset className="fieldset">
              <legend className="fieldset-legend">Select Model</legend>
              <select
                className="select select-bordered select-sm w-full"
                value={localModelId}
                onChange={(e) => handleLocalModelChange(e.target.value as LocalModelId)}
                disabled={modelLoading || modelReady}
              >
                {Object.entries(LOCAL_MODELS).map(([id, config]) => (
                  <option key={id} value={id}>
                    {config.name} — {config.size}
                  </option>
                ))}
              </select>
              <p className="fieldset-label opacity-60">
                {currentLocalModel.description}
              </p>
            </fieldset>

            {/* Model Specifications */}
            <div className="bg-base-300/50 rounded-lg p-3 text-sm space-y-2">
              <div className="flex justify-between items-center">
                <span className="opacity-60">Model ID:</span>
                <span className="font-mono text-xs truncate max-w-[220px]" title={currentLocalModel.id}>
                  {currentLocalModel.id}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="opacity-60">Context Window:</span>
                <span>{currentLocalModel.contextLength.toLocaleString()} tokens</span>
              </div>
              <div className="flex justify-between">
                <span className="opacity-60">Download Size:</span>
                <span>{currentLocalModel.size}</span>
              </div>
              <div className="flex justify-between">
                <span className="opacity-60">Capabilities:</span>
                <span className="text-warning text-xs">Chat only (no tools)</span>
              </div>
            </div>

            {/* Download Progress - Fixed integer percentage */}
            {modelLoading && (
              <div className="space-y-2 bg-base-300/30 rounded-lg p-3">
                <div className="flex justify-between text-sm items-center">
                  <span className="font-medium">{modelLoadStatus}</span>
                  <span className="font-mono text-primary">{Math.round(modelLoadProgress)}%</span>
                </div>
                <progress 
                  className="progress progress-primary w-full" 
                  value={modelLoadProgress} 
                  max={100}
                />
                <p className="text-xs opacity-60">
                  Downloading model files from Hugging Face... First load may take several minutes depending on your connection.
                </p>
              </div>
            )}

            {/* Status Indicators */}
            <div className="flex gap-2 flex-wrap">
              {webGPUStatus?.available && (
                <div className={`badge badge-sm gap-1.5 ${modelReady ? 'badge-success' : 'badge-ghost'}`}>
                  <Cpu className="w-3 h-3" /> 
                  {modelReady ? 'WebGPU Active' : 'WebGPU Ready'}
                </div>
              )}
              {!webGPUStatus?.available && (
                <div className="badge badge-warning badge-sm gap-1.5">
                  <AlertCircle className="w-3 h-3" /> CPU Fallback (Slow)
                </div>
              )}
              {modelReady && (
                <div className="badge badge-success badge-sm gap-1.5">
                  <Check className="w-3 h-3" /> Model Loaded
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2">
              {!modelReady && !modelLoading && webGPUStatus?.available && (
                <button 
                  className="btn btn-primary btn-sm flex-1"
                  onClick={handleInitializeLocalModel}
                >
                  <Download className="w-4 h-4" />
                  Download & Load Model
                </button>
              )}
              {!modelReady && !modelLoading && !webGPUStatus?.available && (
                <button 
                  className="btn btn-warning btn-sm flex-1"
                  onClick={handleInitializeLocalModel}
                >
                  <Download className="w-4 h-4" />
                  Load Model (CPU Mode)
                </button>
              )}
              {modelReady && (
                <button 
                  className="btn btn-outline btn-sm btn-error"
                  onClick={handleUnloadLocalModel}
                >
                  <Trash2 className="w-4 h-4" />
                  Unload Model
                </button>
              )}
              {modelLoading && (
                <button 
                  className="btn btn-ghost btn-sm flex-1"
                  disabled
                >
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading...
                </button>
              )}
            </div>

            {/* Privacy Notice */}
            <div className="alert alert-sm bg-info/10 border-info/20">
              <Info className="w-4 h-4 shrink-0 text-info" />
              <div className="text-xs">
                <p className="font-medium text-info">Privacy & Offline Capability</p>
                <p className="opacity-70">
                  This model runs entirely on your device using WebGPU/WebGL acceleration. 
                  Model files are cached in browser storage and reused across sessions. 
                  No conversation data is sent to external servers.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Claude Model Selection */}
      {providerType === 'claude' && (
        <div className="card card-bordered bg-base-200">
          <div className="card-body p-4 sm:p-6 gap-3">
            <h3 className="card-title text-base gap-2">
              <Bot className="w-4 h-4" /> Claude Model
            </h3>
            <select
              className="select select-bordered select-sm"
              value={claudeModel}
              onChange={(e) => handleClaudeModelChange(e.target.value)}
            >
              {CLAUDE_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="text-xs opacity-50">
              Select the Claude model for API calls. Opus is most capable, Haiku is fastest.
            </p>
          </div>
        </div>
      )}

      {/* Assistant Name Configuration */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2">
            <MessageSquare className="w-4 h-4" /> Assistant Name
          </h3>
          <div className="flex gap-2">
            <input
              type="text"
              className="input input-bordered input-sm flex-1"
              placeholder="Andy"
              value={assistantName}
              onChange={(e) => setAssistantName(e.target.value)}
              onBlur={handleAssistantNameSave}
            />
          </div>
          <p className="text-xs opacity-50">
            The name used to identify the assistant. Mention @{assistantName} in any message to trigger a response.
          </p>
        </div>
      </div>

      {/* Telegram Bot Configuration */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2">
            <Smartphone className="w-4 h-4" /> Telegram Bot
          </h3>
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Bot Token</legend>
            <input
              type="password"
              className="input input-bordered input-sm w-full font-mono"
              placeholder="123456:ABC-DEF..."
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
            />
            <p className="fieldset-label opacity-60">Get this from @BotFather on Telegram</p>
          </fieldset>
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Allowed Chat IDs</legend>
            <input
              type="text"
              className="input input-bordered input-sm w-full font-mono"
              placeholder="-1001234567890, 123456789"
              value={telegramChatIds}
              onChange={(e) => setTelegramChatIds(e.target.value)}
            />
            <p className="fieldset-label opacity-60">Comma-separated list of allowed chat or channel IDs</p>
          </fieldset>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleTelegramSave}
              disabled={!telegramToken.trim()}
            >
              Save Telegram Config
            </button>
            {telegramSaved && (
              <span className="text-success text-sm flex items-center gap-1">
                <Check className="w-4 h-4" /> Saved
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Storage Management */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2">
            <HardDrive className="w-4 h-4" /> Storage
          </h3>
          <div>
            <div className="flex items-center justify-between text-sm mb-1">
              <span>{formatBytes(storageUsage)} used</span>
              <span className="opacity-60">
                of {formatBytes(storageQuota)}
              </span>
            </div>
            <progress
              className="progress progress-primary w-full h-2"
              value={storagePercent}
              max={100}
            />
          </div>
          {!isPersistent && (
            <button
              className="btn btn-outline btn-sm"
              onClick={handleRequestPersistentStorage}
            >
              <Lock className="w-4 h-4" /> Request Persistent Storage
            </button>
          )}
          {isPersistent && (
            <div className="badge badge-success badge-sm gap-1.5">
              <Lock className="w-3 h-3" /> Persistent storage granted
            </div>
          )}
          <p className="text-xs opacity-50">
            Persistent storage prevents the browser from clearing your data when under storage pressure.
          </p>
        </div>
      </div>
    </div>
  );
}