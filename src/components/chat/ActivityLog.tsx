// ---------------------------------------------------------------------------
// OpenBrowserClaw — Activity log (collapsible)
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { Link, Wrench, ClipboardList, MessageSquare, Info } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ThinkingLogEntry } from '../../types.js';

interface Props {
  entries: ThinkingLogEntry[];
}

const kindIcons: Record<string, LucideIcon> = {
  'api-call': Link,
  'tool-call': Wrench,
  'tool-result': ClipboardList,
  text: MessageSquare,
  info: Info,
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function ActivityLog({ entries }: Props) {
  const [open, setOpen] = useState(false);
  const [expandedDetails, setExpandedDetails] = useState<Set<number>>(new Set());

  function toggleDetail(idx: number) {
    setExpandedDetails((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  return (
    <div className="px-4 pt-2">
      <div className="collapse collapse-arrow bg-base-200">
        <input type="checkbox" checked={open} onChange={() => setOpen(!open)} />
        <div className="collapse-title text-sm font-medium py-2 min-h-0">
          Activity <span className="badge badge-sm badge-primary ml-1">{entries.length}</span>
        </div>
        <div className="collapse-content">
          <div className="max-h-48 overflow-y-auto space-y-1 text-xs">
            {entries.map((entry, idx) => {
              const KindIcon = kindIcons[entry.kind];
              return (
                <div key={idx} className="flex items-start gap-1.5">
                  {KindIcon ? <KindIcon className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <span>•</span>}
                  <span className="opacity-50 shrink-0">{formatTime(entry.timestamp)}</span>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium">{entry.label}</span>
                    {entry.detail && (
                      <>
                        {entry.detail.length > 120 && (
                          <button
                            className="ml-1 link link-primary text-xs"
                            onClick={() => toggleDetail(idx)}
                          >
                            {expandedDetails.has(idx) ? 'collapse' : 'expand'}
                          </button>
                        )}
                        <div
                          className={`mt-0.5 opacity-50 break-all ${
                            entry.detail.length > 120 && !expandedDetails.has(idx)
                              ? 'line-clamp-1'
                              : ''
                          }`}
                        >
                          {entry.detail}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
