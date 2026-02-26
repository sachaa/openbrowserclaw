// ---------------------------------------------------------------------------
// OpenBrowserClaw — Theme toggle component
// ---------------------------------------------------------------------------

import { useThemeStore, type ThemeChoice } from '../../stores/theme-store.js';
import { Sun, Moon, Monitor } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const options: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function ThemeToggle() {
  const { theme, setTheme } = useThemeStore();
  const ActiveIcon = options.find((o) => o.value === theme)?.icon ?? Monitor;

  return (
    <div className="dropdown dropdown-end">
      <div tabIndex={0} role="button" className="btn btn-ghost btn-sm btn-square">
        <ActiveIcon className="w-5 h-5" />
      </div>
      <ul
        tabIndex={0}
        className="dropdown-content menu bg-base-200 rounded-box shadow-lg z-50 w-36 p-2 mt-2"
      >
        {options.map((opt) => (
          <li key={opt.value}>
            <button
              className={theme === opt.value ? 'active' : ''}
              onClick={() => setTheme(opt.value)}
            >
              <opt.icon className="w-4 h-4" /> {opt.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
