// ---------------------------------------------------------------------------
// OpenBrowserClaw — Chat page
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react';
import { X, MessageSquare, Globe, FileText, MessageCircle, HelpCircle } from 'lucide-react';
import { useOrchestratorStore } from '../../stores/orchestrator-store.js';
import { MessageList } from './MessageList.js';
import { ChatInput } from './ChatInput.js';
import { TypingIndicator } from './TypingIndicator.js';
import { ToolActivity } from './ToolActivity.js';
import { ActivityLog } from './ActivityLog.js';
import { ContextBar } from './ContextBar.js';
import { ChatActions } from './ChatActions.js';

const LineGraphIcon = ({ className }: { className?: string }) => (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
    >
        <path d="M3 3v18h18" />
        <path d="m7 15 4-4 3 3 5-7" />
    </svg>
);

// Prompt starters for Claude (with tool access)
const CLAUDE_PROMPT_STARTERS = [
    {
        icon: Globe,
        title: 'Latest news',
        prompt: 'Get me the top trending posts from HackerNews.',
    },
    {
        icon: LineGraphIcon,
        title: 'Generate a report',
        prompt: 'Show me a graph with the Ethereum price over the last 6 months.',
    },
    {
        icon: FileText,
        title: 'Create a file',
        prompt: 'Create a simple HTML file with a hello world page.',
    },
];

// Prompt starters for local model (chat only, no tools)
const LOCAL_PROMPT_STARTERS = [
    {
        icon: MessageCircle,
        title: 'Have a conversation',
        prompt: 'Tell me about yourself and what you can help with.',
    },
    {
        icon: HelpCircle,
        title: 'Ask a question',
        prompt: 'What are the main differences between JavaScript and TypeScript?',
    },
    {
        icon: FileText,
        title: 'Get help with code',
        prompt: 'Explain how async/await works in JavaScript with a simple example.',
    },
];

export function ChatPage() {
  const messages = useOrchestratorStore((s) => s.messages);
  const isTyping = useOrchestratorStore((s) => s.isTyping);
  const isStreaming = useOrchestratorStore((s) => s.isStreaming);
  const toolActivity = useOrchestratorStore((s) => s.toolActivity);
  const activityLog = useOrchestratorStore((s) => s.activityLog);
  const orchState = useOrchestratorStore((s) => s.state);
  const tokenUsage = useOrchestratorStore((s) => s.tokenUsage);
  const error = useOrchestratorStore((s) => s.error);
  const providerType = useOrchestratorStore((s) => s.providerType);
  const sendMessage = useOrchestratorStore((s) => s.sendMessage);
  const loadHistory = useOrchestratorStore((s) => s.loadHistory);

  const bottomRef = useRef<HTMLDivElement>(null);

  // Choose prompt starters based on provider type
  const promptStarters = providerType === 'onnx' ? LOCAL_PROMPT_STARTERS : CLAUDE_PROMPT_STARTERS;
  const starterTitle = providerType === 'onnx' 
    ? 'Chat with the local AI' 
    : 'Start a conversation';
  const starterDesc = providerType === 'onnx'
    ? 'This is a lightweight local model. It can chat and answer questions, but cannot execute commands or access files.'
    : 'Try one of these to get started';

  // Scroll to bottom on new messages or streaming content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  // Load history on mount
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Determine if we should show typing indicator
  // Show for: Claude thinking, or local model loading (before streaming starts)
  const showTyping = isTyping && !isStreaming;

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-1">
        {messages.length === 0 && !isTyping && !isStreaming && (
          <div className="hero min-h-full">
            <div className="hero-content text-center">
              <div className="max-w-md">
                <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-30" />
                <h2 className="text-2xl font-bold">{starterTitle}</h2>
                <p className="mt-2 opacity-60 mb-6">{starterDesc}</p>
                <div className="grid gap-3">
                  {promptStarters.map(({ icon: Icon, title, prompt }) => (
                    <button
                      key={title}
                      className="card card-bordered bg-base-200 hover:bg-base-300 transition-colors cursor-pointer text-left"
                      onClick={() => sendMessage(prompt)}
                    >
                      <div className="card-body p-4 flex-row items-center gap-3">
                        <Icon className="w-5 h-5 opacity-60 shrink-0" />
                        <div className="min-w-0">
                          <div className="font-medium text-sm">{title}</div>
                          <div className="text-xs opacity-50 truncate">{prompt}</div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
                {providerType === 'onnx' && (
                  <p className="mt-4 text-xs opacity-40">
                    💡 Switch to Claude mode in Settings for file operations, web access, and command execution.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        <MessageList messages={messages} />

        {/* Show typing indicator during thinking/loading phase */}
        {showTyping && <TypingIndicator />}
        
        {toolActivity && (
          <ToolActivity tool={toolActivity.tool} status={toolActivity.status} />
        )}

        <div ref={bottomRef} />
      </div>

      {/* Bottom bar */}
      <div className="border-t border-base-300 bg-base-100">
        {/* Activity log (collapsible) */}
        {activityLog.length > 0 && <ActivityLog entries={activityLog} />}

        {/* Context / token usage bar */}
        {tokenUsage && <ContextBar usage={tokenUsage} />}

        {/* Compact / New Session actions */}
        <ChatActions disabled={orchState !== 'idle'} />

        {/* Error display */}
        {error && (
          <div className="px-4 pb-2">
            <div role="alert" className="alert alert-error">
              <span>{error}</span>
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => useOrchestratorStore.getState().clearError()}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Input */}
        <ChatInput
          onSend={sendMessage}
          disabled={orchState !== 'idle'}
        />
      </div>
    </div>
  );
}