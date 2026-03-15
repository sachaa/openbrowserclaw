// ---------------------------------------------------------------------------
// OpenBrowserClaw — Message list with streaming support
// ---------------------------------------------------------------------------

import type { StoredMessage } from '../../types.js';
import { MessageBubble } from './MessageBubble.js';
import { StreamingMessage } from './StreamingMessage.js';
import { useOrchestratorStore } from '../../stores/orchestrator-store.js';

interface Props {
  messages: StoredMessage[];
}

export function MessageList({ messages }: Props) {
  const streamingContent = useOrchestratorStore((s) => s.streamingContent);
  const isStreaming = useOrchestratorStore((s) => s.isStreaming);
  const orchState = useOrchestratorStore((s) => s.state);
  const providerType = useOrchestratorStore((s) => s.providerType);

  // Filter out any streaming placeholder messages from the array
  const realMessages = messages.filter(m => !String(m.id).startsWith('streaming-'));

  // Show streaming only for local model when in responding state
  const showStreaming = isStreaming && providerType === 'onnx' && orchState === 'responding';

  return (
    <>
      {realMessages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {/* Show streaming message for local model */}
      {showStreaming && <StreamingMessage content={streamingContent} />}
    </>
  );
}