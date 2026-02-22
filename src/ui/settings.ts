// ---------------------------------------------------------------------------
// OpenBrowserClaw — Settings UI Component
// ---------------------------------------------------------------------------

import { Orchestrator } from '../orchestrator.js';
import { getConfig, setConfig } from '../db.js';
import { CONFIG_KEYS } from '../config.js';
import { getStorageEstimate, requestPersistentStorage } from '../storage.js';
import { el } from './app.js';

/**
 * Settings panel for configuring API keys, Telegram, model, etc.
 */
export class SettingsUI {
  private orchestrator: Orchestrator;
  private container: HTMLElement | null = null;
  private onDone: () => void;

  constructor(orchestrator: Orchestrator, onDone: () => void) {
    this.orchestrator = orchestrator;
    this.onDone = onDone;
  }

  /**
   * Mount into a container element.
   */
  mount(parent: HTMLElement): void {
    this.container = parent;
    this.container.classList.add('settings-container');
    this.render();
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private render(): void {
    if (!this.container) return;
    this.container.innerHTML = '';

    const wrapper = el('div', 'settings-wrapper');

    // Title
    const title = el('h2', 'settings-title');
    title.textContent = 'Settings';
    wrapper.appendChild(title);

    // API Key section
    wrapper.appendChild(this.createSection('Anthropic API Key', (section) => {
      const input = document.createElement('input');
      input.type = 'password';
      input.className = 'settings-input';
      input.placeholder = 'sk-ant-...';
      input.id = 'api-key-input';

      // Load current value
      getConfig(CONFIG_KEYS.ANTHROPIC_API_KEY).then((val) => {
        if (val) input.value = val;
      });

      const saveBtn = document.createElement('button');
      saveBtn.className = 'settings-btn';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async () => {
        const key = input.value.trim();
        if (key) {
          await this.orchestrator.setApiKey(key);
          this.showStatus(section, '✓ API key saved');
        }
      });

      const hint = el('p', 'settings-hint');
      const link = document.createElement('a');
      link.href = 'https://platform.claude.com/settings/keys';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Get your API key here';
      hint.append(link, '. Stored locally in your browser.');

      section.append(input, saveBtn, hint);
    }));

    // Model section
    wrapper.appendChild(this.createSection('Model', (section) => {
      const select = document.createElement('select');
      select.className = 'settings-select';
      select.id = 'model-select';

      const models = [
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
      ];

      const currentModel = this.orchestrator.getModel();
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        opt.selected = m === currentModel;
        select.appendChild(opt);
      }

      select.addEventListener('change', async () => {
        await this.orchestrator.setModel(select.value);
        this.showStatus(section, '✓ Model updated');
      });

      section.appendChild(select);
    }));

    // Assistant Name section
    wrapper.appendChild(this.createSection('Assistant Name', (section) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'settings-input';
      input.placeholder = 'Andy';
      input.value = this.orchestrator.getAssistantName();

      const saveBtn = document.createElement('button');
      saveBtn.className = 'settings-btn';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async () => {
        const name = input.value.trim();
        if (name) {
          await this.orchestrator.setAssistantName(name);
          this.showStatus(section, `✓ Assistant name set to ${name}`);
        }
      });

      const hint = el('p', 'settings-hint');
      hint.textContent = `Trigger pattern: @${input.value || 'Andy'}. In the main chat, no trigger is needed.`;
      input.addEventListener('input', () => {
        hint.textContent = `Trigger pattern: @${input.value || 'Andy'}. In the main chat, no trigger is needed.`;
      });

      section.append(input, saveBtn, hint);
    }));

    // Telegram section
    wrapper.appendChild(this.createSection('Telegram (Optional)', (section) => {
      const tokenInput = document.createElement('input');
      tokenInput.type = 'password';
      tokenInput.className = 'settings-input';
      tokenInput.placeholder = 'Bot token from @BotFather';
      tokenInput.id = 'tg-token-input';

      const chatIdsInput = document.createElement('input');
      chatIdsInput.type = 'text';
      chatIdsInput.className = 'settings-input';
      chatIdsInput.placeholder = 'Chat IDs (comma-separated)';
      chatIdsInput.id = 'tg-chatids-input';

      // Load current values
      getConfig(CONFIG_KEYS.TELEGRAM_BOT_TOKEN).then((val) => {
        if (val) tokenInput.value = val;
      });
      getConfig(CONFIG_KEYS.TELEGRAM_CHAT_IDS).then((val) => {
        if (val) {
          try {
            chatIdsInput.value = JSON.parse(val).join(', ');
          } catch { /* ignore */ }
        }
      });

      const saveBtn = document.createElement('button');
      saveBtn.className = 'settings-btn';
      saveBtn.textContent = 'Connect Telegram';
      saveBtn.addEventListener('click', async () => {
        const token = tokenInput.value.trim();
        const chatIds = chatIdsInput.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

        if (token) {
          await this.orchestrator.configureTelegram(token, chatIds);
          this.showStatus(section, '✓ Telegram connected');
        }
      });

      const hint = el('p', 'settings-hint');
      hint.innerHTML =
        'Create a bot with <code>@BotFather</code> on Telegram. ' +
        'Send <code>/chatid</code> to your bot to get the chat ID.';

      section.append(tokenInput, chatIdsInput, saveBtn, hint);
    }));

    // Storage section
    wrapper.appendChild(this.createSection('Storage', (section) => {
      const info = el('div', 'storage-info');
      info.id = 'storage-info';
      info.textContent = 'Loading...';
      section.appendChild(info);

      const persistBtn = document.createElement('button');
      persistBtn.className = 'settings-btn';
      persistBtn.textContent = 'Request Persistent Storage';
      persistBtn.addEventListener('click', async () => {
        const granted = await requestPersistentStorage();
        this.showStatus(section, granted ? '✓ Persistent storage granted' : '✗ Browser denied persistent storage');
      });
      section.appendChild(persistBtn);

      // Load storage info
      getStorageEstimate().then(({ usage, quota }) => {
        const usageMB = (usage / 1024 / 1024).toFixed(1);
        const quotaMB = (quota / 1024 / 1024).toFixed(0);
        info.textContent = `Using ${usageMB} MB of ${quotaMB} MB (${((usage / quota) * 100).toFixed(1)}%)`;
      });
    }));

    // Done button
    const doneBtn = document.createElement('button');
    doneBtn.className = 'settings-btn settings-btn-primary';
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', () => this.onDone());
    wrapper.appendChild(doneBtn);

    this.container.appendChild(wrapper);
  }

  private createSection(
    title: string,
    builder: (section: HTMLElement) => void,
  ): HTMLElement {
    const section = el('div', 'settings-section');
    const heading = el('h3', 'settings-section-title');
    heading.textContent = title;
    section.appendChild(heading);
    builder(section);
    return section;
  }

  private showStatus(section: HTMLElement, message: string): void {
    let status = section.querySelector('.settings-status') as HTMLElement;
    if (!status) {
      status = el('div', 'settings-status');
      section.appendChild(status);
    }
    status.textContent = message;
    setTimeout(() => {
      status.textContent = '';
    }, 3000);
  }
}
