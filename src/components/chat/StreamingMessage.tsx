// ---------------------------------------------------------------------------
// OpenBrowserClaw — Streaming message with typewriter effect and stop button
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { Square } from 'lucide-react';
import { getOrchestrator } from '../../stores/orchestrator-store.js';
import { useOrchestratorStore } from '../../stores/orchestrator-store.js';
import { CodeBlock } from './CodeBlock.js';

// Allow SVG elements and common attributes through sanitization
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
    'ellipse', 'g', 'defs', 'use', 'text', 'tspan',
    'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask',
  ],
  attributes: {
    ...defaultSchema.attributes,
    svg: ['xmlns', 'viewBox', 'width', 'height', 'fill', 'stroke', 'class', 'style', 'role', 'aria-*'],
    path: ['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'transform', 'class'],
    circle: ['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'class'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'class'],
    line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'class'],
    polyline: ['points', 'fill', 'stroke', 'stroke-width', 'class'],
    polygon: ['points', 'fill', 'stroke', 'stroke-width', 'class'],
    ellipse: ['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'class'],
    g: ['transform', 'fill', 'stroke', 'class', 'opacity'],
    text: ['x', 'y', 'dx', 'dy', 'text-anchor', 'font-size', 'font-family', 'fill', 'class', 'transform'],
    tspan: ['x', 'y', 'dx', 'dy', 'fill', 'class'],
    linearGradient: ['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform'],
    radialGradient: ['id', 'cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits'],
    stop: ['offset', 'stop-color', 'stop-opacity'],
    clipPath: ['id'],
    mask: ['id'],
    defs: [],
    use: ['href', 'x', 'y', 'width', 'height'],
  },
};

interface StreamingMessageProps {
  content: string;
}

export function StreamingMessage({ content }: StreamingMessageProps) {
  const [displayedContent, setDisplayedContent] = useState('');
  const contentRef = useRef(content);
  const animationRef = useRef<number | null>(null);
  const isCompleteRef = useRef(false);
  const abortStreaming = useOrchestratorStore((s) => s.abortStreaming);

  // Smooth typewriter effect
  useEffect(() => {
    contentRef.current = content;
    
    if (isCompleteRef.current) {
      setDisplayedContent(content);
      return;
    }

    let currentIndex = displayedContent.length;
    
    // Cancel previous animation
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    // Animate to catch up with received content
    const animate = () => {
      const targetIndex = contentRef.current.length;
      
      if (currentIndex < targetIndex) {
        // Add multiple characters per frame for smoothness
        const remaining = targetIndex - currentIndex;
        const charsToAdd = Math.max(1, Math.min(remaining, Math.ceil(remaining / 10)));
        currentIndex += charsToAdd;
        setDisplayedContent(contentRef.current.slice(0, currentIndex));
        animationRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayedContent(contentRef.current);
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [content, displayedContent.length]);

  // Mark complete when streaming ends (detected by content not changing)
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (content === contentRef.current && content.length > 0) {
        isCompleteRef.current = true;
        setDisplayedContent(content);
      }
    }, 500);

    return () => clearTimeout(timeout);
  }, [content]);

  const assistantName = getOrchestrator().getAssistantName();

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const handleStop = () => {
    abortStreaming();
  };

  return (
    <div className="chat chat-start">
      <div className="chat-header opacity-60 mb-0.5 flex items-center gap-2">
        {assistantName}
        <time className="text-xs">{formatTime(Date.now())}</time>
        <span className="text-xs text-primary animate-pulse">● writing</span>
        {/* Stop button */}
        <button 
          onClick={handleStop}
          className="btn btn-xs btn-error btn-square ml-2"
          title="Stop generation"
        >
          <Square className="w-3 h-3 fill-current" />
        </button>
      </div>
      <div className="chat-bubble chat-bubble-neutral">
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
                return (
                  <code className="bg-base-300/40 px-1 py-0.5 rounded text-sm font-mono" {...props}>
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
                  <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:opacity-80">
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
            {displayedContent}
          </ReactMarkdown>
          {/* Cursor indicator at end */}
          {!isCompleteRef.current && (
            <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5 align-middle" />
          )}
        </div>
      </div>
    </div>
  );
}