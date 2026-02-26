// ---------------------------------------------------------------------------
// OpenBrowserClaw — Chat actions (Compact + New Session)
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { Package, RefreshCw } from 'lucide-react';
import { useOrchestratorStore } from '../../stores/orchestrator-store.js';

interface Props {
  disabled: boolean;
}

export function ChatActions({ disabled }: Props) {
  const compactContext = useOrchestratorStore((s) => s.compactContext);
  const newSession = useOrchestratorStore((s) => s.newSession);
  const [confirmAction, setConfirmAction] = useState<'compact' | 'new-session' | null>(null);

  async function handleConfirm() {
    if (confirmAction === 'compact') {
      await compactContext();
    } else if (confirmAction === 'new-session') {
      await newSession();
    }
    setConfirmAction(null);
  }

  return (
    <>
      <div className="flex gap-1 px-4 py-2">
        <button
          className="btn btn-ghost btn-xs gap-1"
          disabled={disabled}
          onClick={() => setConfirmAction('compact')}
        >
          <Package className="w-3.5 h-3.5" /> Compact
        </button>
        <button
          className="btn btn-ghost btn-xs gap-1"
          disabled={disabled}
          onClick={() => setConfirmAction('new-session')}
        >
          <RefreshCw className="w-3.5 h-3.5" /> New Session
        </button>
      </div>

      {/* Confirmation modal */}
      {confirmAction && (
        <dialog className="modal modal-open">
          <div className="modal-box max-w-sm">
            <h3 className="font-bold text-lg">
              {confirmAction === 'compact' ? 'Compact Context' : 'New Session'}
            </h3>
            <p className="py-4">
              {confirmAction === 'compact'
                ? 'This will summarize the conversation to reduce token usage. The summary replaces the current history.'
                : 'This will clear all messages and start a fresh conversation. This cannot be undone.'}
            </p>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setConfirmAction(null)}>
                Cancel
              </button>
              <button
                className={`btn ${confirmAction === 'new-session' ? 'btn-error' : 'btn-primary'}`}
                onClick={handleConfirm}
              >
                {confirmAction === 'compact' ? 'Compact' : 'Clear & Start New'}
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setConfirmAction(null)}>close</button>
          </form>
        </dialog>
      )}
    </>
  );
}
