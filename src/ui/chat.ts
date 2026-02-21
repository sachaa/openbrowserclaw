// ---------------------------------------------------------------------------
// BrowserClaw — Chat UI Component
// ---------------------------------------------------------------------------

import { Orchestrator } from '../orchestrator.js';
import { getRecentMessages } from '../db.js';
import { DEFAULT_GROUP_ID, CONTEXT_WINDOW_SIZE } from '../config.js';
import type { StoredMessage, OrchestratorState, ThinkingLogEntry } from '../types.js';
import { renderMarkdown } from '../markdown.js';
import { el } from './app.js';

/**
 * Chat UI component. Renders the message list, input area,
 * typing indicator, tool activity display, and thinking activity log.
 */
export class ChatUI {
  private orchestrator: Orchestrator;
  private container: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private typingEl: HTMLElement | null = null;
  private toolEl: HTMLElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private activeGroupId: string = DEFAULT_GROUP_ID;
  private isTyping = false;

  // Activity log
  private activityLogEl: HTMLElement | null = null;
  private activityListEl: HTMLElement | null = null;
  private activityToggleEl: HTMLElement | null = null;
  private activityExpanded = false;
  private activityEntries: ThinkingLogEntry[] = [];

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  /**
   * Mount the chat UI into a container element.
   */
  mount(parent: HTMLElement): void {
    this.container = parent;
    this.container.classList.add('chat-container');
    this.render();
  }

  /**
   * Add a message to the chat display.
   */
  addMessage(msg: StoredMessage): void {
    if (msg.groupId !== this.activeGroupId) return;
    this.appendMessageEl(msg);
    this.scrollToBottom();
  }

  /**
   * Show/hide the typing indicator.
   */
  setTyping(groupId: string, typing: boolean): void {
    if (groupId !== this.activeGroupId) return;
    this.isTyping = typing;
    if (this.typingEl) {
      this.typingEl.style.display = typing ? 'flex' : 'none';
    }
    if (this.activityLogEl) {
      if (typing) {
        // Show the activity log container when thinking starts
        this.activityLogEl.style.display = 'block';
      } else {
        // Collapse when done — keep entries visible until next invocation
        this.activityLogEl.style.display = 'none';
      }
    }
    if (typing) this.scrollToBottom();
  }

  /**
   * Show tool activity.
   */
  setToolActivity(tool: string, status: string): void {
    if (this.toolEl) {
      if (status === 'running') {
        this.toolEl.textContent = `Using ${tool}...`;
        this.toolEl.style.display = 'block';
      } else {
        this.toolEl.style.display = 'none';
      }
    }
  }

  /**
   * Add a thinking log entry.
   */
  addThinkingLog(entry: ThinkingLogEntry): void {
    if (entry.groupId !== this.activeGroupId) return;

    // If this is the first entry of a new invocation, clear previous entries
    if (entry.kind === 'info' && entry.label === 'Starting') {
      this.activityEntries = [];
      if (this.activityListEl) this.activityListEl.innerHTML = '';
    }

    this.activityEntries.push(entry);
    this.renderLogEntry(entry);
    this.scrollToBottom();
  }

  /**
   * Update state display (e.g., disable input while thinking).
   */
  setState(state: OrchestratorState): void {
    if (this.inputEl) {
      this.inputEl.disabled = state === 'thinking';
    }
    if (this.sendBtn) {
      this.sendBtn.disabled = state === 'thinking';
    }
  }

  /**
   * Show an error message.
   */
  showError(error: string): void {
    const msgEl = el('div', 'message message-error');
    msgEl.textContent = `⚠️ ${error}`;
    this.messagesEl?.appendChild(msgEl);
    this.scrollToBottom();
  }

  /**
   * Load and display message history.
   */
  async loadHistory(): Promise<void> {
    try {
      const messages = await getRecentMessages(this.activeGroupId, CONTEXT_WINDOW_SIZE);
      if (this.messagesEl) {
        this.messagesEl.innerHTML = '';
      }
      for (const msg of messages) {
        this.appendMessageEl(msg);
      }
      this.scrollToBottom();
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private render(): void {
    if (!this.container) return;
    this.container.innerHTML = '';

    // Messages area
    this.messagesEl = el('div', 'messages');
    this.container.appendChild(this.messagesEl);

    // Typing indicator
    this.typingEl = el('div', 'typing-indicator');
    this.typingEl.innerHTML = `
      <div class="typing-dots">
        <span></span><span></span><span></span>
      </div>
      <span class="typing-text">Thinking...</span>
    `;
    this.typingEl.style.display = 'none';
    this.container.appendChild(this.typingEl);

    // Tool activity
    this.toolEl = el('div', 'tool-activity');
    this.toolEl.style.display = 'none';
    this.container.appendChild(this.toolEl);

    // Activity log (collapsible)
    this.activityLogEl = el('div', 'activity-log');
    this.activityLogEl.style.display = 'none';

    this.activityToggleEl = el('div', 'activity-toggle');
    this.activityToggleEl.innerHTML = '<span class="activity-toggle-icon">▶</span> Activity';
    this.activityToggleEl.addEventListener('click', () => {
      this.activityExpanded = !this.activityExpanded;
      if (this.activityListEl) {
        this.activityListEl.style.display = this.activityExpanded ? 'block' : 'none';
      }
      if (this.activityToggleEl) {
        const icon = this.activityToggleEl.querySelector('.activity-toggle-icon');
        if (icon) icon.textContent = this.activityExpanded ? '▼' : '▶';
      }
      if (this.activityExpanded) this.scrollToBottom();
    });
    this.activityLogEl.appendChild(this.activityToggleEl);

    this.activityListEl = el('div', 'activity-list');
    this.activityListEl.style.display = 'none';
    this.activityLogEl.appendChild(this.activityListEl);

    this.container.appendChild(this.activityLogEl);

    // Input area
    const inputArea = el('div', 'input-area');

    this.inputEl = document.createElement('textarea');
    this.inputEl.className = 'chat-input';
    this.inputEl.placeholder = 'Type a message...';
    this.inputEl.rows = 1;
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
    this.inputEl.addEventListener('input', () => {
      // Auto-resize
      if (this.inputEl) {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + 'px';
      }
    });

    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'send-btn';
    this.sendBtn.textContent = '→';
    this.sendBtn.addEventListener('click', () => this.handleSend());

    inputArea.append(this.inputEl, this.sendBtn);
    this.container.appendChild(inputArea);
  }

  private handleSend(): void {
    if (!this.inputEl) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.orchestrator.submitMessage(text, this.activeGroupId);
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this.inputEl.focus();
  }

  private appendMessageEl(msg: StoredMessage): void {
    if (!this.messagesEl) return;

    const wrapper = el('div', `message ${msg.isFromMe ? 'message-assistant' : 'message-user'}`);

    const senderEl = el('div', 'message-sender');
    senderEl.textContent = msg.isFromMe ? this.orchestrator.getAssistantName() : msg.sender;
    wrapper.appendChild(senderEl);

    const contentEl = el('div', 'message-content');
    if (msg.isFromMe) {
      // Assistant messages: render as markdown
      contentEl.classList.add('md');
      contentEl.innerHTML = renderMarkdown(msg.content);
    } else {
      // User messages: plain text
      contentEl.textContent = msg.content;
    }
    wrapper.appendChild(contentEl);

    const timeEl = el('div', 'message-time');
    timeEl.textContent = formatTime(msg.timestamp);
    wrapper.appendChild(timeEl);

    this.messagesEl.appendChild(wrapper);
  }

  private renderLogEntry(entry: ThinkingLogEntry): void {
    if (!this.activityListEl) return;

    const row = el('div', `activity-entry activity-${entry.kind}`);

    const kindIcons: Record<ThinkingLogEntry['kind'], string> = {
      'api-call': '🔗',
      'tool-call': '🔧',
      'tool-result': '📋',
      'text': '💬',
      'info': 'ℹ️',
    };

    const time = new Date(entry.timestamp).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const header = el('div', 'activity-entry-header');
    header.innerHTML = `<span class="activity-icon">${kindIcons[entry.kind] || '•'}</span>`
      + `<span class="activity-label">${escapeHtmlText(entry.label)}</span>`
      + `<span class="activity-time">${time}</span>`;
    row.appendChild(header);

    if (entry.detail) {
      const detail = el('div', 'activity-detail');
      detail.textContent = entry.detail;

      // Make detail expandable if long
      if (entry.detail.length > 120) {
        detail.classList.add('activity-detail-collapsed');
        detail.addEventListener('click', () => {
          detail.classList.toggle('activity-detail-collapsed');
          detail.classList.toggle('activity-detail-expanded');
          this.scrollToBottom();
        });
      }

      row.appendChild(detail);
    }

    this.activityListEl.appendChild(row);

    // Update toggle label with entry count
    if (this.activityToggleEl) {
      const icon = this.activityToggleEl.querySelector('.activity-toggle-icon');
      const arrow = icon?.textContent || '▶';
      this.activityToggleEl.innerHTML = `<span class="activity-toggle-icon">${arrow}</span> Activity (${this.activityEntries.length})`;
    }
  }

  private scrollToBottom(): void {
    if (this.messagesEl) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
