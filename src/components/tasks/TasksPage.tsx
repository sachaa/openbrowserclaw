// ---------------------------------------------------------------------------
// OpenBrowserClaw — Tasks page
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react';
import { Plus, X, Calendar, Clock, Trash2 } from 'lucide-react';
import { getAllTasks, saveTask, deleteTask } from '../../db.js';
import { DEFAULT_GROUP_ID } from '../../config.js';
import type { Task } from '../../types.js';
import { ulid } from '../../ulid.js';

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type ScheduleFrequency =
  | 'every-minute'
  | 'every-5-min'
  | 'every-15-min'
  | 'every-30-min'
  | 'hourly'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'custom';

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

function buildCron(
  freq: ScheduleFrequency,
  hour: number,
  minute: number,
  dayOfWeek: number,
  dayOfMonth: number,
): string {
  switch (freq) {
    case 'every-minute':
      return '* * * * *';
    case 'every-5-min':
      return '*/5 * * * *';
    case 'every-15-min':
      return '*/15 * * * *';
    case 'every-30-min':
      return '*/30 * * * *';
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case 'monthly':
      return `${minute} ${hour} ${dayOfMonth} * *`;
    case 'custom':
      return '* * * * *';
  }
}

function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts;

  if (cron === '* * * * *') return 'Every minute';
  if (min.startsWith('*/') && hour === '*' && dom === '*' && dow === '*') {
    return `Every ${min.slice(2)} minutes`;
  }
  if (hour === '*' && dom === '*' && dow === '*' && !min.includes('*') && !min.includes('/')) {
    const m = parseInt(min, 10);
    return m === 0 ? 'Every hour' : `Every hour at :${String(m).padStart(2, '0')}`;
  }
  if (!hour.includes('*') && !min.includes('*') && !hour.includes('/') && !min.includes('/')) {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const ts = formatTime12(h, m);
    if (dom === '*' && dow === '*') return `Every day at ${ts}`;
    if (dom === '*' && dow === '1-5') return `Weekdays at ${ts}`;
    if (dom === '*' && dow !== '*') {
      const d = parseInt(dow, 10);
      if (!isNaN(d) && d >= 0 && d <= 6) return `Every ${DAYS_OF_WEEK[d]} at ${ts}`;
      const names = dow.split(',').map((x) => {
        const n = parseInt(x.trim(), 10);
        return !isNaN(n) && n >= 0 && n <= 6 ? DAYS_SHORT[n] : x;
      });
      return `Every ${names.join(', ')} at ${ts}`;
    }
    if (dow === '*' && dom !== '*') {
      const d = parseInt(dom, 10);
      if (!isNaN(d)) return `Monthly on the ${ordinal(d)} at ${ts}`;
    }
  }
  return cron;
}

function formatTime12(h: number, m: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function needsTimePicker(freq: ScheduleFrequency): boolean {
  return ['daily', 'weekdays', 'weekly', 'monthly'].includes(freq);
}

function needsDayOfWeek(freq: ScheduleFrequency): boolean {
  return freq === 'weekly';
}

function needsDayOfMonth(freq: ScheduleFrequency): boolean {
  return freq === 'monthly';
}

function needsMinutePicker(freq: ScheduleFrequency): boolean {
  return freq === 'hourly';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Form state
  const [prompt, setPrompt] = useState('');
  const [frequency, setFrequency] = useState<ScheduleFrequency>('daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [customCron, setCustomCron] = useState('');

  const loadTasks = useCallback(async () => {
    setLoading(true);
    const all = await getAllTasks();
    setTasks(all);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  async function handleCreate() {
    const schedule =
      frequency === 'custom'
        ? customCron.trim() || '* * * * *'
        : buildCron(frequency, hour, minute, dayOfWeek, dayOfMonth);

    const task: Task = {
      id: ulid(),
      groupId: DEFAULT_GROUP_ID,
      schedule,
      prompt: prompt.trim(),
      enabled: true,
      lastRun: null,
      createdAt: Date.now(),
    };

    await saveTask(task);
    setPrompt('');
    setShowForm(false);
    loadTasks();
  }

  async function handleToggle(task: Task) {
    await saveTask({ ...task, enabled: !task.enabled });
    loadTasks();
  }

  async function handleDelete(id: string) {
    await deleteTask(id);
    setDeleteConfirm(null);
    loadTasks();
  }

  const previewCron =
    frequency === 'custom'
      ? customCron.trim() || '* * * * *'
      : buildCron(frequency, hour, minute, dayOfWeek, dayOfMonth);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Scheduled Tasks</h2>
        <button className="btn btn-primary btn-sm gap-1.5" onClick={() => setShowForm(!showForm)}>
          {showForm ? (
            <>
              <X className="w-4 h-4" /> Cancel
            </>
          ) : (
            <>
              <Plus className="w-4 h-4" /> New Task
            </>
          )}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="card card-bordered bg-base-200 mb-6">
          <div className="card-body p-4 sm:p-6 gap-4">
            <h3 className="card-title text-base">Create Scheduled Task</h3>

            {/* Prompt */}
            <div className="form-control">
              <label className="label">
                <span className="label-text">Prompt</span>
              </label>
              <textarea
                className="textarea textarea-bordered h-24"
                placeholder="What should the assistant do on this schedule?"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>

            {/* Frequency */}
            <div className="form-control">
              <label className="label">
                <span className="label-text">Frequency</span>
              </label>
              <select
                className="select select-bordered"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)}
              >
                {PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Time picker */}
            {needsTimePicker(frequency) && (
              <div className="flex gap-3">
                <div className="form-control flex-1">
                  <label className="label">
                    <span className="label-text">Hour</span>
                  </label>
                  <select
                    className="select select-bordered select-sm"
                    value={hour}
                    onChange={(e) => setHour(Number(e.target.value))}
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {formatTime12(i, 0).replace(/:00/, '')}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-control flex-1">
                  <label className="label">
                    <span className="label-text">Minute</span>
                  </label>
                  <select
                    className="select select-bordered select-sm"
                    value={minute}
                    onChange={(e) => setMinute(Number(e.target.value))}
                  >
                    {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                      <option key={m} value={m}>
                        :{String(m).padStart(2, '0')}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Minute picker for hourly */}
            {needsMinutePicker(frequency) && (
              <div className="form-control">
                <label className="label">
                  <span className="label-text">At minute</span>
                </label>
                <select
                  className="select select-bordered select-sm"
                  value={minute}
                  onChange={(e) => setMinute(Number(e.target.value))}
                >
                  {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                    <option key={m} value={m}>
                      :{String(m).padStart(2, '0')}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Day of week picker */}
            {needsDayOfWeek(frequency) && (
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Day of week</span>
                </label>
                <select
                  className="select select-bordered select-sm"
                  value={dayOfWeek}
                  onChange={(e) => setDayOfWeek(Number(e.target.value))}
                >
                  {DAYS_OF_WEEK.map((day, i) => (
                    <option key={i} value={i}>
                      {day}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Day of month picker */}
            {needsDayOfMonth(frequency) && (
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Day of month</span>
                </label>
                <select
                  className="select select-bordered select-sm"
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(Number(e.target.value))}
                >
                  {Array.from({ length: 28 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {ordinal(i + 1)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Custom cron input */}
            {frequency === 'custom' && (
              <div className="form-control">
                <label className="label">
                  <span className="label-text">Cron expression</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered font-mono"
                  placeholder="* * * * *"
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                />
                <label className="label">
                  <span className="label-text-alt opacity-60">
                    Format: minute hour day-of-month month day-of-week
                  </span>
                </label>
              </div>
            )}

            {/* Preview */}
            <div className="bg-base-200 rounded-lg px-3 py-2 text-sm">
              <span className="opacity-60">Schedule preview: </span>
              <span className="font-medium">{cronToHuman(previewCron)}</span>
              <span className="opacity-50 ml-2 font-mono text-xs">({previewCron})</span>
            </div>

            {/* Submit */}
            <div className="card-actions justify-end">
              <button className="btn btn-primary" disabled={!prompt.trim()} onClick={handleCreate}>
                Create Task
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <span className="loading loading-spinner loading-md" />
        </div>
      ) : tasks.length === 0 ? (
        <div className="hero py-12">
          <div className="hero-content text-center">
            <div>
              <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No scheduled tasks</p>
              <p className="text-xs opacity-60 mt-1">Create a task to run on a schedule</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`card card-bordered bg-base-200 ${!task.enabled ? 'opacity-50' : ''}`}
            >
              <div className="card-body p-4 sm:p-6 gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium line-clamp-2">{task.prompt}</p>
                    <p className="text-sm opacity-70 mt-1 flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5 inline" /> {cronToHuman(task.schedule)}
                      <span className="opacity-50 ml-2 font-mono text-xs">({task.schedule})</span>
                    </p>
                    {task.lastRun && (
                      <p className="text-xs opacity-50 mt-0.5">
                        Last run: {new Date(task.lastRun).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="checkbox"
                      className="toggle toggle-primary toggle-sm"
                      checked={task.enabled}
                      onChange={() => handleToggle(task)}
                    />
                    <button
                      className="btn btn-ghost btn-xs text-error"
                      onClick={() => setDeleteConfirm(task.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <dialog className="modal modal-open">
          <div className="modal-box max-w-sm">
            <h3 className="font-bold text-lg">Delete task?</h3>
            <p className="py-4">This scheduled task will be permanently removed.</p>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </button>
              <button className="btn btn-error" onClick={() => handleDelete(deleteConfirm)}>
                Delete
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setDeleteConfirm(null)}>close</button>
          </form>
        </dialog>
      )}
    </div>
  );
}
