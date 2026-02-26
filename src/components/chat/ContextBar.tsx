// ---------------------------------------------------------------------------
// OpenBrowserClaw — Context / token usage bar
// ---------------------------------------------------------------------------

import type { TokenUsage } from '../../types.js';

interface Props {
  usage: TokenUsage;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ContextBar({ usage }: Props) {
  const total = usage.inputTokens + usage.outputTokens;
  const pct = Math.min((total / usage.contextLimit) * 100, 100);

  let colorClass = 'progress-success';
  if (pct >= 80) colorClass = 'progress-error';
  else if (pct >= 60) colorClass = 'progress-warning';

  const cacheInfo =
    usage.cacheReadTokens > 0 ? ` (${formatTokens(usage.cacheReadTokens)} cached)` : '';

  return (
    <div className="px-4 py-1.5 flex items-center gap-3">
      <progress className={`progress ${colorClass} flex-1 h-1.5`} value={pct} max={100} />
      <span className="text-xs opacity-60 whitespace-nowrap hidden sm:inline">
        {formatTokens(total)} / {formatTokens(usage.contextLimit)} tokens{cacheInfo}
      </span>
    </div>
  );
}
