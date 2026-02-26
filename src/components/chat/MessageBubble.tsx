// ---------------------------------------------------------------------------
// OpenBrowserClaw — Message bubble
// ---------------------------------------------------------------------------

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { FileText } from 'lucide-react';
import type { StoredMessage } from '../../types.js';
import { getOrchestrator } from '../../stores/orchestrator-store.js';
import { useFileViewerStore } from '../../stores/file-viewer-store.js';
import { CodeBlock } from './CodeBlock.js';

// Matches strings that look like file paths (with extension)
const FILE_PATH_RE = /^[\w./-]+\.\w{1,10}$/;

// Allow SVG elements and common attributes through sanitization
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'svg',
    'path',
    'circle',
    'rect',
    'line',
    'polyline',
    'polygon',
    'ellipse',
    'g',
    'defs',
    'use',
    'text',
    'tspan',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
    'mask',
    'pattern',
    'marker',
    'foreignObject',
  ],
  attributes: {
    ...defaultSchema.attributes,
    svg: [
      'xmlns',
      'viewBox',
      'width',
      'height',
      'fill',
      'stroke',
      'class',
      'style',
      'role',
      'aria-*',
    ],
    path: [
      'd',
      'fill',
      'stroke',
      'stroke-width',
      'stroke-linecap',
      'stroke-linejoin',
      'opacity',
      'transform',
      'class',
    ],
    circle: ['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'class'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'class'],
    line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'class'],
    polyline: ['points', 'fill', 'stroke', 'stroke-width', 'class'],
    polygon: ['points', 'fill', 'stroke', 'stroke-width', 'class'],
    ellipse: ['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'class'],
    g: ['transform', 'fill', 'stroke', 'class', 'opacity'],
    text: [
      'x',
      'y',
      'dx',
      'dy',
      'text-anchor',
      'font-size',
      'font-family',
      'fill',
      'class',
      'transform',
    ],
    tspan: ['x', 'y', 'dx', 'dy', 'fill', 'class'],
    linearGradient: ['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform'],
    radialGradient: ['id', 'cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits'],
    stop: ['offset', 'stop-color', 'stop-opacity'],
    clipPath: ['id'],
    mask: ['id'],
    defs: [],
    use: ['href', 'x', 'y', 'width', 'height'],
    marker: ['id', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient'],
    foreignObject: ['x', 'y', 'width', 'height'],
    img: ['src', 'alt', 'width', 'height', 'title', 'class'],
  },
};

interface Props {
  message: StoredMessage;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MessageBubble({ message }: Props) {
  const isAssistant = message.isFromMe;
  const senderName = isAssistant ? getSenderName(message) : 'You';

  return (
    <div className={`chat ${isAssistant ? 'chat-start' : 'chat-end'}`}>
      <div className="chat-header opacity-60 mb-0.5">
        {senderName}
        <time className="ml-2 text-xs">{formatTime(message.timestamp)}</time>
      </div>
      <div className={`chat-bubble ${isAssistant ? '' : 'chat-bubble-primary'}`}>
        {isAssistant ? (
          <div className="chat-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
              components={{
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const codeStr = String(children).replace(/\n$/, '');
                  if (match) {
                    return <CodeBlock language={match[1]} code={codeStr} />;
                  }
                  // Detect inline file paths and make them clickable
                  if (FILE_PATH_RE.test(codeStr)) {
                    return <FileLink path={codeStr} />;
                  }
                  return (
                    <code
                      className="bg-base-300/40 px-1 py-0.5 rounded text-sm font-mono"
                      {...props}
                    >
                      {children}
                    </code>
                  );
                },
                pre({ children }) {
                  return <>{children}</>;
                },
                blockquote({ children }) {
                  return (
                    <blockquote className="border-l-4 border-current/20 pl-3 my-1.5 opacity-80 italic">
                      {children}
                    </blockquote>
                  );
                },
                table({ children }) {
                  return (
                    <div className="overflow-x-auto my-2">
                      <table className="table table-xs">{children}</table>
                    </div>
                  );
                },
                p({ children }) {
                  return <p className="my-1 leading-relaxed">{children}</p>;
                },
                ul({ children }) {
                  return <ul className="my-1 pl-5 list-disc space-y-0.5">{children}</ul>;
                },
                ol({ children }) {
                  return <ol className="my-1 pl-5 list-decimal space-y-0.5">{children}</ol>;
                },
                li({ children }) {
                  return <li className="pl-0.5">{children}</li>;
                },
                a({ href, children }) {
                  return (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2 hover:opacity-80"
                    >
                      {children}
                    </a>
                  );
                },
                h1({ children }) {
                  return <h1 className="text-lg font-bold mt-3 mb-1">{children}</h1>;
                },
                h2({ children }) {
                  return <h2 className="text-base font-bold mt-2.5 mb-1">{children}</h2>;
                },
                h3({ children }) {
                  return <h3 className="text-sm font-bold mt-2 mb-0.5">{children}</h3>;
                },
                hr() {
                  return <hr className="my-2 border-current/20" />;
                },
                img({ src, alt }) {
                  return (
                    <img
                      src={src}
                      alt={alt || ''}
                      className="max-w-full rounded my-2"
                      loading="lazy"
                    />
                  );
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        ) : (
          <span className="whitespace-pre-wrap">{message.content}</span>
        )}
      </div>
    </div>
  );
}

// Clickable inline file link that opens the global file viewer
function FileLink({ path }: { path: string }) {
  const openFile = useFileViewerStore((s) => s.openFile);
  return (
    <button
      type="button"
      onClick={() => openFile(path)}
      className="inline-flex items-center gap-1 bg-base-300/40 px-1.5 py-0.5 rounded text-sm font-mono cursor-pointer hover:bg-base-300/70 transition-colors"
      title={`Open ${path}`}
    >
      <FileText className="w-3.5 h-3.5 shrink-0" />
      {path}
    </button>
  );
}

function getSenderName(msg: StoredMessage): string {
  try {
    return getOrchestrator().getAssistantName();
  } catch {
    return msg.sender || 'Assistant';
  }
}
