// ---------------------------------------------------------------------------
// OpenBrowserClaw — File viewer modal
// ---------------------------------------------------------------------------

import { useEffect } from 'react';
import { ExternalLink, Download, X } from 'lucide-react';

interface Props {
  name: string;
  content: string;
  onClose: () => void;
}

function isRenderable(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ['html', 'htm', 'svg'].includes(ext);
}

export function FileViewerModal({ name, content, onClose }: Props) {
  // Close on ESC
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  function handleDownload() {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleOpenInTab() {
    const blob = new Blob([content], {
      type: isRenderable(name) ? 'text/html' : 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  }

  return (
    <dialog className="modal modal-open file-viewer-modal">
      <div className="modal-box w-11/12 max-w-5xl h-[85vh] flex flex-col p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-base-300">
          <h3 className="font-bold truncate">{name}</h3>
          <div className="flex gap-1">
            <button className="btn btn-ghost btn-sm" onClick={handleOpenInTab}>
              <ExternalLink className="w-4 h-4" /> Open in Tab
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleDownload}>
              <Download className="w-4 h-4" /> Download
            </button>
            <button className="btn btn-ghost btn-sm btn-square" onClick={onClose}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {isRenderable(name) ? (
            <iframe
              srcDoc={content}
              className="w-full h-full border-0 rounded bg-white"
              sandbox="allow-scripts"
              title={name}
            />
          ) : (
            <pre className="text-sm font-mono whitespace-pre-wrap break-all">{content}</pre>
          )}
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={onClose}>close</button>
      </form>
    </dialog>
  );
}
