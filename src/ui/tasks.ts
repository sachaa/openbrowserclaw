// ---------------------------------------------------------------------------
// BrowserClaw — Tasks UI Component
// ---------------------------------------------------------------------------

import { Orchestrator } from '../orchestrator.js';
import { getAllTasks, saveTask, deleteTask } from '../db.js';
import { DEFAULT_GROUP_ID } from '../config.js';
import type { Task } from '../types.js';
import { ulid } from '../ulid.js';
import { el } from './app.js';

/**
 * Task manager UI. View, create, and manage scheduled tasks.
 */
export class TasksUI {
  private orchestrator: Orchestrator;
  private container: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  /**
   * Mount into a container element.
   */
  mount(parent: HTMLElement): void {
    this.container = parent;
    this.container.classList.add('tasks-container');
    this.render();
    this.loadTasks();
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private render(): void {
    if (!this.container) return;
    this.container.innerHTML = '';

    const wrapper = el('div', 'tasks-wrapper');

    const header = el('div', 'tasks-header');
    const title = el('h2', 'tasks-title');
    title.textContent = 'Scheduled Tasks';
    header.appendChild(title);

    const addBtn = document.createElement('button');
    addBtn.className = 'settings-btn';
    addBtn.textContent = '+ New Task';
    addBtn.addEventListener('click', () => this.showAddForm());
    header.appendChild(addBtn);

    wrapper.appendChild(header);

    // Task list
    this.listEl = el('div', 'tasks-list');
    wrapper.appendChild(this.listEl);

    this.container.appendChild(wrapper);
  }

  private async loadTasks(): Promise<void> {
    if (!this.listEl) return;

    const tasks = await getAllTasks();

    if (tasks.length === 0) {
      this.listEl.innerHTML = '<div class="tasks-empty">No scheduled tasks yet. Create one with the button above, or ask your assistant to schedule something.</div>';
      return;
    }

    this.listEl.innerHTML = '';
    for (const task of tasks) {
      this.listEl.appendChild(this.renderTask(task));
    }
  }

  private renderTask(task: Task): HTMLElement {
    const taskEl = el('div', 'task-item');

    const infoEl = el('div', 'task-info');

    const scheduleEl = el('div', 'task-schedule');
    scheduleEl.textContent = `⏰ ${task.schedule}`;
    infoEl.appendChild(scheduleEl);

    const promptEl = el('div', 'task-prompt');
    promptEl.textContent = task.prompt;
    infoEl.appendChild(promptEl);

    const metaEl = el('div', 'task-meta');
    metaEl.textContent = `Group: ${task.groupId} · ${task.enabled ? '✅ Active' : '⏸ Paused'}`;
    if (task.lastRun) {
      metaEl.textContent += ` · Last run: ${new Date(task.lastRun).toLocaleString()}`;
    }
    infoEl.appendChild(metaEl);

    taskEl.appendChild(infoEl);

    // Actions
    const actionsEl = el('div', 'task-actions');

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'task-btn';
    toggleBtn.textContent = task.enabled ? 'Pause' : 'Resume';
    toggleBtn.addEventListener('click', async () => {
      task.enabled = !task.enabled;
      await saveTask(task);
      await this.loadTasks();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'task-btn task-btn-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      await deleteTask(task.id);
      await this.loadTasks();
    });

    actionsEl.append(toggleBtn, deleteBtn);
    taskEl.appendChild(actionsEl);

    return taskEl;
  }

  private showAddForm(): void {
    if (!this.listEl) return;

    // Remove existing form if any
    const existing = this.listEl.querySelector('.task-form');
    if (existing) {
      existing.remove();
      return;
    }

    const form = el('div', 'task-form');

    const scheduleInput = document.createElement('input');
    scheduleInput.type = 'text';
    scheduleInput.className = 'settings-input';
    scheduleInput.placeholder = 'Cron: 0 9 * * 1-5 (9am weekdays)';

    const promptInput = document.createElement('textarea');
    promptInput.className = 'settings-input task-prompt-input';
    promptInput.placeholder = 'What should the assistant do?';
    promptInput.rows = 3;

    const btnRow = el('div', 'task-form-btns');

    const createBtn = document.createElement('button');
    createBtn.className = 'settings-btn settings-btn-primary';
    createBtn.textContent = 'Create';
    createBtn.addEventListener('click', async () => {
      const schedule = scheduleInput.value.trim();
      const prompt = promptInput.value.trim();
      if (!schedule || !prompt) return;

      const task: Task = {
        id: ulid(),
        groupId: DEFAULT_GROUP_ID,
        schedule,
        prompt,
        enabled: true,
        lastRun: null,
        createdAt: Date.now(),
      };

      await saveTask(task);
      form.remove();
      await this.loadTasks();
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'settings-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => form.remove());

    btnRow.append(createBtn, cancelBtn);
    form.append(scheduleInput, promptInput, btnRow);
    this.listEl.prepend(form);
  }
}
