// ---------------------------------------------------------------------------
// BrowserClaw — Main UI Application
// ---------------------------------------------------------------------------

import { Orchestrator } from '../orchestrator.js';
import { ChatUI } from './chat.js';
import { SettingsUI } from './settings.js';
import { TasksUI } from './tasks.js';
import type { StoredMessage, ThinkingLogEntry } from '../types.js';

export type View = 'chat' | 'settings' | 'tasks';

/**
 * Top-level UI controller. Manages the app shell, navigation,
 * and coordinates between sub-views.
 */
export class AppUI {
  private orchestrator: Orchestrator;
  private chatUI: ChatUI;
  private settingsUI: SettingsUI;
  private tasksUI: TasksUI;
  private currentView: View = 'chat';
  private root: HTMLElement;

  constructor(rootElement: HTMLElement) {
    this.root = rootElement;
    this.orchestrator = new Orchestrator();
    this.chatUI = new ChatUI(this.orchestrator);
    this.settingsUI = new SettingsUI(this.orchestrator, () => this.navigate('chat'));
    this.tasksUI = new TasksUI(this.orchestrator);
  }

  /**
   * Initialize the app and render.
   */
  async init(): Promise<void> {
    this.render();

    // Wire up orchestrator events
    this.orchestrator.events.on('message', (msg: StoredMessage) => {
      this.chatUI.addMessage(msg);
    });

    this.orchestrator.events.on('typing', ({ groupId, typing }) => {
      this.chatUI.setTyping(groupId, typing);
    });

    this.orchestrator.events.on('tool-activity', ({ tool, status }) => {
      this.chatUI.setToolActivity(tool, status);
    });

    this.orchestrator.events.on('thinking-log', (entry: ThinkingLogEntry) => {
      this.chatUI.addThinkingLog(entry);
    });

    this.orchestrator.events.on('state-change', (state) => {
      this.chatUI.setState(state);
    });

    this.orchestrator.events.on('error', ({ error }) => {
      this.chatUI.showError(error);
    });

    this.orchestrator.events.on('session-reset', () => {
      this.chatUI.clearMessages();
    });

    this.orchestrator.events.on('context-compacted', () => {
      this.chatUI.clearMessages();
      this.chatUI.loadHistory();
    });

    this.orchestrator.events.on('token-usage', (usage) => {
      this.chatUI.updateTokenUsage(usage);
    });

    // Initialize orchestrator
    try {
      await this.orchestrator.init();
    } catch (err) {
      console.error('Failed to initialize:', err);
    }

    // Show settings if not configured
    if (!this.orchestrator.isConfigured()) {
      this.navigate('settings');
    }

    // Load chat history
    await this.chatUI.loadHistory();
  }

  /**
   * Navigate to a view.
   */
  navigate(view: View): void {
    this.currentView = view;
    this.updateView();
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private render(): void {
    this.root.innerHTML = '';
    this.root.className = 'app';

    // Header
    const header = el('header', 'app-header');
    const logo = el('div', 'app-logo');
    logo.innerHTML = '<span class="app-logo-icon">🦀</span> BrowserClaw';
    header.appendChild(logo);

    const nav = el('nav', 'app-nav');
    const chatBtn = this.navButton('💬', 'Chat', 'chat');
    const tasksBtn = this.navButton('⏰', 'Tasks', 'tasks');
    const settingsBtn = this.navButton('⚙️', 'Settings', 'settings');
    nav.append(chatBtn, tasksBtn, settingsBtn);
    header.appendChild(nav);

    this.root.appendChild(header);

    // Content area
    const content = el('main', 'app-content');
    content.id = 'app-content';

    const chatView = el('div', 'view');
    chatView.id = 'view-chat';
    this.chatUI.mount(chatView);

    const settingsView = el('div', 'view');
    settingsView.id = 'view-settings';
    this.settingsUI.mount(settingsView);

    const tasksView = el('div', 'view');
    tasksView.id = 'view-tasks';
    this.tasksUI.mount(tasksView);

    content.append(chatView, settingsView, tasksView);
    this.root.appendChild(content);

    this.updateView();
  }

  private navButton(icon: string, label: string, view: View): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'nav-btn';
    btn.dataset.view = view;
    btn.innerHTML = `<span class="nav-icon">${icon}</span><span class="nav-label">${label}</span>`;
    btn.addEventListener('click', () => this.navigate(view));
    return btn;
  }

  private updateView(): void {
    // Toggle view visibility
    const views = ['chat', 'settings', 'tasks'] as const;
    for (const v of views) {
      const viewEl = document.getElementById(`view-${v}`);
      if (viewEl) {
        viewEl.style.display = v === this.currentView ? 'flex' : 'none';
      }
    }

    // Update nav active state
    const navBtns = this.root.querySelectorAll('.nav-btn');
    navBtns.forEach((btn) => {
      const bv = (btn as HTMLElement).dataset.view;
      btn.classList.toggle('active', bv === this.currentView);
    });
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

export function el(tag: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}
