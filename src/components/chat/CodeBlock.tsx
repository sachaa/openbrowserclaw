// ---------------------------------------------------------------------------
// OpenBrowserClaw — Code block with copy button
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface Props {
  language: string;
  code: string;
}

export function CodeBlock({ language, code }: Props) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative my-2 rounded-lg bg-base-300/50 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 text-xs opacity-60 border-b border-base-content/10">
        <span>{language}</span>
        <button onClick={handleCopy} className="btn btn-ghost btn-xs gap-1">
          {copied ? (
            <>
              <Check className="w-3 h-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-sm">
        <code>{code}</code>
      </pre>
    </div>
  );
}
