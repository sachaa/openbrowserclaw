// ---------------------------------------------------------------------------
// OpenBrowserClaw — Settings page
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import {
  Palette, KeyRound, Eye, EyeOff, Bot, MessageSquare,
  Smartphone, HardDrive, Lock, Check, MessageCircle,
} from 'lucide-react';
import { getConfig, setConfig } from '../../db.js';
import { CONFIG_KEYS } from '../../config.js';
import { getStorageEstimate, requestPersistentStorage } from '../../storage.js';
import { decryptValue } from '../../crypto.js';
import { getOrchestrator } from '../../stores/orchestrator-store.js';
import { useThemeStore, type ThemeChoice } from '../../stores/theme-store.js';
import type { IMessageMode } from '../../channels/imessage.js';

const MODELS = [
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

  // API Key
  const [apiKey, setApiKey] = useState('');
  const [apiKeyMasked, setApiKeyMasked] = useState(true);
  const [apiKeySaved, setApiKeySaved] = useState(false);

  // Model
  const [model, setModel] = useState(orch.getModel());

  // Assistant name
  const [assistantName, setAssistantName] = useState(orch.getAssistantName());

  // Telegram
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatIds, setTelegramChatIds] = useState('');
  const [telegramSaved, setTelegramSaved] = useState(false);

  // Photon iMessage
  const [imessageMode, setImessageMode] = useState<IMessageMode | ''>('');
  const [imessageServerUrl, setImessageServerUrl] = useState('');
  const [imessageApiKey, setImessageApiKey] = useState('');
  const [imessageApiKeyMasked, setImessageApiKeyMasked] = useState(true);
  const [imessageSaved, setImessageSaved] = useState(false);
  const [imessageDisabled, setImessageDisabled] = useState(false);

  // Storage
  const [storageUsage, setStorageUsage] = useState(0);
  const [storageQuota, setStorageQuota] = useState(0);
  const [isPersistent, setIsPersistent] = useState(false);

  // Theme
  const { theme, setTheme } = useThemeStore();

  // Load current values
  useEffect(() => {
    async function load() {
      // API key
      const encKey = await getConfig(CONFIG_KEYS.ANTHROPIC_API_KEY);
      if (encKey) {
        try {
          const dec = await decryptValue(encKey);
          setApiKey(dec);
        } catch {
          setApiKey('');
        }
      }

      // Telegram
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

      // Photon iMessage
      const storedMode = (await getConfig(CONFIG_KEYS.IMESSAGE_MODE)) as IMessageMode | '';
      if (storedMode) setImessageMode(storedMode);
      const storedServerUrl = await getConfig(CONFIG_KEYS.IMESSAGE_SERVER_URL);
      if (storedServerUrl) setImessageServerUrl(storedServerUrl);
      const storedImApiKey = await getConfig(CONFIG_KEYS.IMESSAGE_API_KEY);
      if (storedImApiKey) setImessageApiKey(storedImApiKey);

      // Storage
      const est = await getStorageEstimate();
      setStorageUsage(est.usage);
      setStorageQuota(est.quota);
      if (navigator.storage?.persisted) {
        setIsPersistent(await navigator.storage.persisted());
      }
    }
    load();
  }, []);

  async function handleSaveApiKey() {
    await orch.setApiKey(apiKey.trim());
    setApiKeySaved(true);
    setTimeout(() => setApiKeySaved(false), 2000);
  }

  async function handleModelChange(value: string) {
    setModel(value);
    await orch.setModel(value);
  }

  async function handleNameSave() {
    await orch.setAssistantName(assistantName.trim());
  }

  async function handleTelegramSave() {
    const ids = telegramChatIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    await orch.configureTelegram(telegramToken.trim(), ids);
    setTelegramSaved(true);
    setTimeout(() => setTelegramSaved(false), 2000);
  }

  async function handleIMessageSave() {
    if (!imessageMode) return;
    await orch.configureIMessage(
      imessageMode,
      imessageMode === 'remote' ? imessageServerUrl.trim() : undefined,
      imessageMode === 'remote' ? imessageApiKey.trim() : undefined,
    );
    setImessageSaved(true);
    setTimeout(() => setImessageSaved(false), 2000);
  }

  async function handleIMessageDisable() {
    await orch.disableIMessage();
    setImessageMode('');
    setImessageServerUrl('');
    setImessageApiKey('');
    setImessageDisabled(true);
    setTimeout(() => setImessageDisabled(false), 2000);
  }

  async function handleRequestPersistent() {
    const granted = await requestPersistentStorage();
    setIsPersistent(granted);
  }

  const storagePercent = storageQuota > 0 ? (storageUsage / storageQuota) * 100 : 0;
  const imessageRemoteValid =
    imessageMode === 'remote'
      ? imessageServerUrl.trim().length > 0 && imessageApiKey.trim().length > 0
      : true;
  const imessageSaveDisabled = !imessageMode || !imessageRemoteValid;

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 max-w-3xl mx-auto space-y-4">
      <h2 className="text-xl font-bold mb-4">Settings</h2>

      {/* ---- Theme ---- */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2"><Palette className="w-4 h-4" /> Appearance</h3>
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

      {/* ---- API Key ---- */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2"><KeyRound className="w-4 h-4" /> Anthropic API Key</h3>
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
              <span className="text-success text-sm flex items-center gap-1"><Check className="w-4 h-4" /> Saved</span>
            )}
          </div>
          <p className="text-xs opacity-50">
            Your API key is encrypted and stored locally. It never leaves your browser.
          </p>
        </div>
      </div>

      {/* ---- Model ---- */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2"><Bot className="w-4 h-4" /> Model</h3>
          <select
            className="select select-bordered select-sm"
            value={model}
            onChange={(e) => handleModelChange(e.target.value)}
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ---- Assistant Name ---- */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2"><MessageSquare className="w-4 h-4" /> Assistant Name</h3>
          <div className="flex gap-2">
            <input
              type="text"
              className="input input-bordered input-sm flex-1"
              placeholder="Andy"
              value={assistantName}
              onChange={(e) => setAssistantName(e.target.value)}
              onBlur={handleNameSave}
            />
          </div>
          <p className="text-xs opacity-50">
            The name used for the assistant. Mention @{assistantName} to trigger a response.
          </p>
        </div>
      </div>

      {/* ---- Telegram ---- */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2"><Smartphone className="w-4 h-4" /> Telegram Bot</h3>
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Bot Token</legend>
            <input
              type="password"
              className="input input-bordered input-sm w-full font-mono"
              placeholder="123456:ABC-DEF..."
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
            />
          </fieldset>
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Allowed Chat IDs</legend>
            <input
              type="text"
              className="input input-bordered input-sm w-full font-mono"
              placeholder="-100123456, 789012"
              value={telegramChatIds}
              onChange={(e) => setTelegramChatIds(e.target.value)}
            />
            <p className="fieldset-label opacity-60">Comma-separated chat IDs</p>
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
              <span className="text-success text-sm flex items-center gap-1"><Check className="w-4 h-4" /> Saved</span>
            )}
          </div>
        </div>
      </div>

      {/* ---- Photon iMessage ---- */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2">
            <MessageCircle className="w-4 h-4" /> Photon iMessage
          </h3>

          {/* Mode selector */}
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Mode</legend>
            <select
              className="select select-bordered select-sm w-full"
              value={imessageMode}
              onChange={(e) => setImessageMode(e.target.value as IMessageMode | '')}
            >
              <option value="">Disabled</option>
              <option value="local">
                Local — @photon-ai/imessage-kit (macOS, direct DB access)
              </option>
              <option value="remote">
                Remote — Photon server (socket.io)
              </option>
            </select>
            <p className="fieldset-label opacity-60">
              Local mode reads the iMessage database directly on macOS (no server needed).
              Remote mode connects to a Photon server and unlocks advanced features such as
              edit, unsend, tapbacks, effects, and typing indicators.
            </p>
          </fieldset>

          {/* Remote-only fields */}
          {imessageMode === 'remote' && (
            <>
              <fieldset className="fieldset">
                <legend className="fieldset-legend">Server URL</legend>
                <input
                  type="url"
                  className="input input-bordered input-sm w-full font-mono"
                  placeholder="https://your-photon-server.example.com"
                  value={imessageServerUrl}
                  onChange={(e) => setImessageServerUrl(e.target.value)}
                />
                <p className="fieldset-label opacity-60">
                  URL of your Photon iMessage server
                </p>
              </fieldset>
              <fieldset className="fieldset">
                <legend className="fieldset-legend">API Key</legend>
                <div className="flex gap-2">
                  <input
                    type={imessageApiKeyMasked ? 'password' : 'text'}
                    className="input input-bordered input-sm w-full flex-1 font-mono"
                    placeholder="your-api-key"
                    value={imessageApiKey}
                    onChange={(e) => setImessageApiKey(e.target.value)}
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setImessageApiKeyMasked(!imessageApiKeyMasked)}
                  >
                    {imessageApiKeyMasked ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </button>
                </div>
              </fieldset>
            </>
          )}

          {/* Local mode info */}
          {imessageMode === 'local' && (
            <div className="alert alert-info text-sm py-2 px-3">
              <span>
                Local mode requires macOS with Full Disk Access granted to your browser
                or the application running OpenBrowserClaw.
                Install <code className="font-mono">@photon-ai/imessage-kit</code> as a
                dependency before enabling.
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleIMessageSave}
              disabled={imessageSaveDisabled}
            >
              Save iMessage Config
            </button>
            {imessageMode && (
              <button
                className="btn btn-ghost btn-sm text-error"
                onClick={handleIMessageDisable}
              >
                Disable
              </button>
            )}
            {imessageSaved && (
              <span className="text-success text-sm flex items-center gap-1">
                <Check className="w-4 h-4" /> Saved
              </span>
            )}
            {imessageDisabled && (
              <span className="text-warning text-sm flex items-center gap-1">
                <Check className="w-4 h-4" /> Disabled
              </span>
            )}
          </div>

          <p className="text-xs opacity-50">
            Incoming iMessage conversations will appear as separate chat groups with the
            prefix <code className="font-mono">im:</code>.
            Trigger the assistant by mentioning <code className="font-mono">@{assistantName}</code> in any iMessage.
          </p>
        </div>
      </div>

      {/* ---- Storage ---- */}
      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-6 gap-3">
          <h3 className="card-title text-base gap-2"><HardDrive className="w-4 h-4" /> Storage</h3>
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
              onClick={handleRequestPersistent}
            >
              <Lock className="w-4 h-4" /> Request Persistent Storage
            </button>
          )}
          {isPersistent && (
            <div className="badge badge-success badge-sm gap-1.5">
              <Lock className="w-3 h-3" /> Persistent storage active
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
