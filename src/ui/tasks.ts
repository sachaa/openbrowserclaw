// ---------------------------------------------------------------------------
// OpenBrowserClaw — Tasks UI Component
// ---------------------------------------------------------------------------

import { Orchestrator } from '../orchestrator.js';
import { getAllTasks, saveTask, deleteTask } from '../db.js';
import { DEFAULT_GROUP_ID } from '../config.js';
import type { Task } from '../types.js';
import { ulid } from '../ulid.js';
import { el } from './app.js';

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type ScheduleFrequency = 'every-minute' | 'every-5-min' | 'every-15-min' | 'every-30-min' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

interface SchedulePreset {
  label: string;
  value: ScheduleFrequency;
  description: string;
}

const PRESETS: SchedulePreset[] = [
  { label: 'Every minute', value: 'every-minute', description: 'Runs every minute' },
  { label: 'Every 5 minutes', value: 'every-5-min', description: 'Runs every 5 minutes' },
  { label: 'Every 15 minutes', value: 'every-15-min', description: 'Runs every 15 minutes' },
  { label: 'Every 30 minutes', value: 'every-30-min', description: 'Runs every 30 minutes' },
  { label: 'Every hour', value: 'hourly', description: 'Runs at the start of every hour' },
  { label: 'Every day', value: 'daily', description: 'Runs once every day' },
  { label: 'Weekdays only', value: 'weekdays', description: 'Mon–Fri' },
  { label: 'Every week', value: 'weekly', description: 'Runs once a week' },
  { label: 'Every month', value: 'monthly', description: 'Runs once a month' },
  { label: 'Custom (cron)', value: 'custom', description: 'Enter a cron expression' },
];

function buildCron(freq: ScheduleFrequency, hour: number, minute: number, dayOfWeek: number, dayOfMonth: number): string {
  switch (freq) {
    case 'every-minute': return '* * * * *';
    case 'every-5-min': return '*/5 * * * *';
    case 'every-15-min': return '*/15 * * * *';
    case 'every-30-min': return '*/30 * * * *';
    case 'hourly': return `${minute} * * * *`;
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': return `${minute} ${hour} * * ${dayOfWeek}`;
    case 'monthly': return `${minute} ${hour} ${dayOfMonth} * *`;
    case 'custom': return '* * * * *'; // placeholder — overridden
  }
}

/** Convert a cron expression to a human-readable description */
function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [min, hour, dom, _mon, dow] = parts;

  // Every minute
  if (cron === '* * * * *') return 'Every minute';

  // Step minutes
  if (min.startsWith('*/') && hour === '*' && dom === '*' && dow === '*') {
    const step = parseInt(min.slice(2), 10);
    return `Every ${step} minutes`;
  }

  // Hourly
  if (hour === '*' && dom === '*' && dow === '*' && !min.includes('*') && !min.includes('/')) {
    const m = parseInt(min, 10);
    return m === 0 ? 'Every hour' : `Every hour at :${String(m).padStart(2, '0')}`;
  }

  // Daily / Weekdays / Weekly / Monthly
  if (!hour.includes('*') && !min.includes('*') && !hour.includes('/') && !min.includes('/')) {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const timeStr = formatTime(h, m);

    if (dom === '*' && dow === '*') {
      return `Every day at ${timeStr}`;
    }
    if (dom === '*' && dow === '1-5') {
      return `Weekdays at ${timeStr}`;
    }
    if (dom === '*' && dow !== '*') {
      // Weekly on specific day(s)
      const dayNum = parseInt(dow, 10);
      if (!isNaN(dayNum) && dayNum >= 0 && dayNum <= 6) {
        return `Every ${DAYS_OF_WEEK[dayNum]} at ${timeStr}`;
      }
      // Could be a list like 1,3,5
      const dayNames = dow.split(',').map(d => {
        const n = parseInt(d.trim(), 10);
        return !isNaN(n) && n >= 0 && n <= 6 ? DAYS_SHORT[n] : d;
      });
      return `Every ${dayNames.join(', ')} at ${timeStr}`;
    }
    if (dow === '*' && dom !== '*') {
      const d = parseInt(dom, 10);
      if (!isNaN(d)) {
        return `Monthly on the ${ordinal(d)} at ${timeStr}`;
      }
    }
  }

  return cron;
}

function formatTime(h: number, m: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

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

    const headerBtns = el('div', 'tasks-header-btns');

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'settings-btn';
    refreshBtn.textContent = '↻ Refresh';
    refreshBtn.addEventListener('click', () => this.loadTasks());
    headerBtns.appendChild(refreshBtn);

    const addBtn = document.createElement('button');
    addBtn.className = 'settings-btn';
    addBtn.textContent = '+ New Task';
    addBtn.addEventListener('click', () => this.showAddForm());
    headerBtns.appendChild(addBtn);

    header.appendChild(headerBtns);

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
    const humanSchedule = cronToHuman(task.schedule);
    scheduleEl.textContent = `⏰ ${humanSchedule}`;
    // Show raw cron on hover if the human-readable differs
    if (humanSchedule !== task.schedule) {
      scheduleEl.title = `Cron: ${task.schedule}`;
    }
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

    // -- Schedule builder section --
    const scheduleSection = el('div', 'schedule-builder');

    const scheduleLabel = el('label', 'schedule-label');
    scheduleLabel.textContent = 'How often?';
    scheduleSection.appendChild(scheduleLabel);

    // Frequency selector
    const freqSelect = document.createElement('select');
    freqSelect.className = 'schedule-select';
    for (const preset of PRESETS) {
      const opt = document.createElement('option');
      opt.value = preset.value;
      opt.textContent = preset.label;
      freqSelect.appendChild(opt);
    }
    freqSelect.value = 'daily'; // sensible default
    scheduleSection.appendChild(freqSelect);

    // Time row (hour + minute) — shown for daily/weekdays/weekly/monthly/hourly
    const timeRow = el('div', 'schedule-time-row');

    // Minute at (for hourly)
    const minuteAtLabel = el('label', 'schedule-sub-label');
    minuteAtLabel.textContent = 'At minute:';
    minuteAtLabel.className = 'schedule-sub-label minute-at-label';

    const minuteAtSelect = document.createElement('select');
    minuteAtSelect.className = 'schedule-select schedule-select-sm';
    for (let i = 0; i < 60; i += 5) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `:${String(i).padStart(2, '0')}`;
      minuteAtSelect.appendChild(opt);
    }
    minuteAtSelect.value = '0';

    const timeLabel = el('label', 'schedule-sub-label');
    timeLabel.textContent = 'At time:';
    timeLabel.className = 'schedule-sub-label time-label';

    const hourSelect = document.createElement('select');
    hourSelect.className = 'schedule-select schedule-select-sm';
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = formatTime(h, 0).replace(/:00/, '');
      hourSelect.appendChild(opt);
    }
    hourSelect.value = '9'; // default 9 AM

    const sep = document.createElement('span');
    sep.textContent = ':';
    sep.className = 'schedule-time-sep';

    const minuteSelect = document.createElement('select');
    minuteSelect.className = 'schedule-select schedule-select-sm';
    for (let m = 0; m < 60; m += 5) {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = String(m).padStart(2, '0');
      minuteSelect.appendChild(opt);
    }
    minuteSelect.value = '0';

    timeRow.append(minuteAtLabel, minuteAtSelect, timeLabel, hourSelect, sep, minuteSelect);
    scheduleSection.appendChild(timeRow);

    // Day of week selector — shown for weekly
    const dowRow = el('div', 'schedule-dow-row');
    const dowLabel = el('label', 'schedule-sub-label');
    dowLabel.textContent = 'On:';
    const dowSelect = document.createElement('select');
    dowSelect.className = 'schedule-select';
    for (let d = 0; d < 7; d++) {
      const opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = DAYS_OF_WEEK[d];
      dowSelect.appendChild(opt);
    }
    dowSelect.value = '1'; // Monday
    dowRow.append(dowLabel, dowSelect);
    scheduleSection.appendChild(dowRow);

    // Day of month selector — shown for monthly
    const domRow = el('div', 'schedule-dom-row');
    const domLabel = el('label', 'schedule-sub-label');
    domLabel.textContent = 'On day:';
    const domSelect = document.createElement('select');
    domSelect.className = 'schedule-select';
    for (let d = 1; d <= 28; d++) {
      const opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = `${ordinal(d)}`;
      domSelect.appendChild(opt);
    }
    domSelect.value = '1';
    domRow.append(domLabel, domSelect);
    scheduleSection.appendChild(domRow);

    // Custom cron input — shown only for 'custom'
    const customRow = el('div', 'schedule-custom-row');
    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.className = 'settings-input';
    customInput.placeholder = 'e.g. 0 9 * * 1-5 (min hour day month weekday)';
    const customHint = el('div', 'schedule-hint');
    customHint.innerHTML =
      '<code>minute(0-59) hour(0-23) day(1-31) month(1-12) weekday(0-6, Sun=0)</code><br>' +
      'Use <code>*</code> for any, <code>*/N</code> for every N, <code>1-5</code> for range, <code>1,3,5</code> for list';
    customRow.append(customInput, customHint);
    scheduleSection.appendChild(customRow);

    // Schedule preview
    const preview = el('div', 'schedule-preview');
    scheduleSection.appendChild(preview);

    form.appendChild(scheduleSection);

    // -- Prompt input --
    const promptLabel = el('label', 'schedule-label');
    promptLabel.textContent = 'What should the assistant do?';
    form.appendChild(promptLabel);

    const promptInput = document.createElement('textarea');
    promptInput.className = 'settings-input task-prompt-input';
    promptInput.placeholder = 'e.g. Check the weather in Chicago and tell me if I need an umbrella';
    promptInput.rows = 3;
    form.appendChild(promptInput);

    // -- Buttons --
    const btnRow = el('div', 'task-form-btns');

    const createBtn = document.createElement('button');
    createBtn.className = 'settings-btn settings-btn-primary';
    createBtn.textContent = 'Create Task';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'settings-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => form.remove());

    btnRow.append(createBtn, cancelBtn);
    form.appendChild(btnRow);

    // -- Visibility & preview logic --
    const updateVisibility = () => {
      const freq = freqSelect.value as ScheduleFrequency;
      const needsTime = ['daily', 'weekdays', 'weekly', 'monthly'].includes(freq);
      const needsMinuteAt = freq === 'hourly';
      const needsDow = freq === 'weekly';
      const needsDom = freq === 'monthly';
      const isCustom = freq === 'custom';

      // Toggle visibility
      timeLabel.style.display = needsTime ? '' : 'none';
      hourSelect.style.display = needsTime ? '' : 'none';
      sep.style.display = needsTime ? '' : 'none';
      minuteSelect.style.display = needsTime ? '' : 'none';
      minuteAtLabel.style.display = needsMinuteAt ? '' : 'none';
      minuteAtSelect.style.display = needsMinuteAt ? '' : 'none';
      timeRow.style.display = (needsTime || needsMinuteAt) ? '' : 'none';
      dowRow.style.display = needsDow ? '' : 'none';
      domRow.style.display = needsDom ? '' : 'none';
      customRow.style.display = isCustom ? '' : 'none';

      // Build cron & preview
      let cron: string;
      if (isCustom) {
        cron = customInput.value.trim() || '* * * * *';
      } else {
        const h = parseInt(hourSelect.value, 10);
        const m = needsTime ? parseInt(minuteSelect.value, 10) : parseInt(minuteAtSelect.value, 10);
        const dw = parseInt(dowSelect.value, 10);
        const dm = parseInt(domSelect.value, 10);
        cron = buildCron(freq, h, m, dw, dm);
      }

      const human = cronToHuman(cron);
      preview.textContent = `📋 ${human}` + (human !== cron ? `  (${cron})` : '');
    };

    // Wire up change events
    freqSelect.addEventListener('change', updateVisibility);
    hourSelect.addEventListener('change', updateVisibility);
    minuteSelect.addEventListener('change', updateVisibility);
    minuteAtSelect.addEventListener('change', updateVisibility);
    dowSelect.addEventListener('change', updateVisibility);
    domSelect.addEventListener('change', updateVisibility);
    customInput.addEventListener('input', updateVisibility);

    // Create button handler
    createBtn.addEventListener('click', async () => {
      const freq = freqSelect.value as ScheduleFrequency;
      let schedule: string;

      if (freq === 'custom') {
        schedule = customInput.value.trim();
        if (!schedule || schedule.split(/\s+/).length !== 5) {
          customInput.classList.add('input-error');
          customInput.focus();
          return;
        }
      } else {
        const h = parseInt(hourSelect.value, 10);
        const m = ['daily', 'weekdays', 'weekly', 'monthly'].includes(freq)
          ? parseInt(minuteSelect.value, 10)
          : parseInt(minuteAtSelect.value, 10);
        const dw = parseInt(dowSelect.value, 10);
        const dm = parseInt(domSelect.value, 10);
        schedule = buildCron(freq, h, m, dw, dm);
      }

      const prompt = promptInput.value.trim();
      if (!prompt) {
        promptInput.classList.add('input-error');
        promptInput.focus();
        return;
      }

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

    // Initial state
    updateVisibility();

    this.listEl.prepend(form);
    promptInput.focus();
  }
}
