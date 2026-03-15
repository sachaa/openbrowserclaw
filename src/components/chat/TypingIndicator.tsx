// ---------------------------------------------------------------------------
// OpenBrowserClaw — Typing indicator
// ---------------------------------------------------------------------------

import { useOrchestratorStore } from '../../stores/orchestrator-store.js';

export function TypingIndicator() {
  const providerType = useOrchestratorStore((s) => s.providerType);
  const providerLoading = useOrchestratorStore((s) => s.providerLoading);
  
  // For local model, show "Loading model" during initialization
  const isLocalLoading = providerType === 'onnx' && providerLoading;
  
  return (
    <div className="chat chat-start">
      <div className="chat-bubble chat-bubble-neutral flex items-center gap-2 py-3 px-4">
        <div className="flex gap-1">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </div>
        <span className="text-sm opacity-60">
          {isLocalLoading ? 'Loading model...' : 'Thinking...'}
        </span>
      </div>
    </div>
  );
}