// ---------------------------------------------------------------------------
// OpenBrowserClaw — Files page
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react';
import {
  Folder,
  Globe,
  Image,
  FileText,
  FileCode,
  FileJson,
  FileSpreadsheet,
  File,
  Home,
  Search,
  Download,
  Trash2,
  X,
  FolderOpen,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DEFAULT_GROUP_ID } from '../../config.js';
import { listGroupFiles, readGroupFile, deleteGroupFile } from '../../storage.js';
import { FileViewerModal } from './FileViewerModal.js';

interface FileEntry {
  name: string;
  isDir: boolean;
}

function getFileIcon(name: string, isDir: boolean): LucideIcon {
  if (isDir) return Folder;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const icons: Record<string, LucideIcon> = {
    html: Globe,
    htm: Globe,
    svg: Globe,
    png: Image,
    jpg: Image,
    jpeg: Image,
    gif: Image,
    md: FileText,
    txt: FileText,
    json: FileJson,
    js: FileCode,
    ts: FileCode,
    css: FileCode,
    xml: FileCode,
    csv: FileSpreadsheet,
  };
  return icons[ext] ?? File;
}

export function FilesPage() {
  const [path, setPath] = useState<string[]>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [viewerFile, setViewerFile] = useState<{ name: string; content: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const groupId = DEFAULT_GROUP_ID;
  const currentDir = path.length > 0 ? path.join('/') : '.';

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const raw = await listGroupFiles(groupId, currentDir);
      const parsed: FileEntry[] = raw.map((name) => ({
        name: name.replace(/\/$/, ''),
        isDir: name.endsWith('/'),
      }));
      setEntries(parsed);
    } catch (err) {
      if ((err as Error)?.name === 'NotFoundError') {
        setEntries([]);
      } else {
        setError('Failed to load files');
      }
    } finally {
      setLoading(false);
    }
  }, [groupId, currentDir]);

  useEffect(() => {
    loadEntries();
    setPreviewFile(null);
    setPreviewContent(null);
  }, [loadEntries]);

  async function handlePreview(name: string) {
    setPreviewFile(name);
    try {
      const filePath = path.length > 0 ? `${path.join('/')}/${name}` : name;
      const content = await readGroupFile(groupId, filePath);
      setPreviewContent(content);
    } catch {
      setPreviewContent('[Unable to read file]');
    }
  }

  async function handleDelete(name: string) {
    try {
      const filePath = path.length > 0 ? `${path.join('/')}/${name}` : name;
      await deleteGroupFile(groupId, filePath);
      setDeleteConfirm(null);
      setPreviewFile(null);
      setPreviewContent(null);
      loadEntries();
    } catch {
      setError('Failed to delete file');
    }
  }

  function handleOpenViewer(name: string, content: string) {
    setViewerFile({ name, content });
  }

  function handleDownload(name: string, content: string) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Breadcrumbs */}
      <div className="px-4 py-2 bg-base-200 border-b border-base-300">
        <div className="breadcrumbs text-sm">
          <ul>
            <li>
              <button
                className="link link-hover flex items-center gap-1"
                onClick={() => setPath([])}
              >
                <Home className="w-4 h-4" /> workspace
              </button>
            </li>
            {path.map((segment, i) => (
              <li key={i}>
                <button className="link link-hover" onClick={() => setPath(path.slice(0, i + 1))}>
                  {segment}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* File list */}
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="loading loading-spinner loading-md" />
            </div>
          ) : error ? (
            <div role="alert" className="alert alert-error m-4">
              {error}
            </div>
          ) : entries.length === 0 ? (
            <div className="hero py-12">
              <div className="hero-content text-center">
                <div>
                  <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="font-medium">No files yet</p>
                  <p className="text-sm opacity-60 mt-1">
                    Files created by the assistant will appear here
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <table className="table table-sm">
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.name}
                    className={`hover cursor-pointer ${previewFile === entry.name ? 'active' : ''}`}
                    onClick={() =>
                      entry.isDir ? setPath([...path, entry.name]) : handlePreview(entry.name)
                    }
                  >
                    <td className="w-8 text-center">
                      {(() => {
                        const Icon = getFileIcon(entry.name, entry.isDir);
                        return <Icon className="w-4 h-4 inline-block" />;
                      })()}
                    </td>
                    <td className="font-medium">
                      {entry.name}
                      {entry.isDir && <span className="opacity-30 ml-1">/</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Preview pane (hidden on mobile, shown as modal instead) */}
        {previewFile && previewContent !== null && (
          <div className="hidden md:flex flex-col w-1/2 border-l border-base-300 bg-base-200">
            <div className="flex items-center justify-between px-4 py-2 border-b border-base-300">
              <span className="font-medium text-sm truncate flex items-center gap-1.5">
                {(() => {
                  const Icon = getFileIcon(previewFile, false);
                  return <Icon className="w-4 h-4" />;
                })()}
                {previewFile}
              </span>
              <div className="flex gap-1">
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => handleOpenViewer(previewFile, previewContent)}
                  title="Open in viewer"
                >
                  <Search className="w-4 h-4" />
                </button>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => handleDownload(previewFile, previewContent)}
                  title="Download"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button
                  className="btn btn-ghost btn-xs text-error"
                  onClick={() => setDeleteConfirm(previewFile)}
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {isRenderable(previewFile) ? (
                <iframe
                  srcDoc={previewContent}
                  className="w-full h-full border-0 rounded bg-white"
                  sandbox="allow-scripts"
                  title="File preview"
                />
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                  {previewContent}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mobile: preview shows as a bottom sheet / full modal */}
      {previewFile && previewContent !== null && (
        <div className="md:hidden fixed inset-0 z-50 bg-base-100 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-base-300">
            <span className="font-medium truncate flex items-center gap-1.5">
              {(() => {
                const Icon = getFileIcon(previewFile, false);
                return <Icon className="w-4 h-4" />;
              })()}
              {previewFile}
            </span>
            <div className="flex gap-1">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => handleOpenViewer(previewFile, previewContent)}
              >
                <Search className="w-4 h-4" />
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => handleDownload(previewFile, previewContent)}
              >
                <Download className="w-4 h-4" />
              </button>
              <button
                className="btn btn-ghost btn-sm text-error"
                onClick={() => setDeleteConfirm(previewFile)}
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setPreviewFile(null);
                  setPreviewContent(null);
                }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {isRenderable(previewFile) ? (
              <iframe
                srcDoc={previewContent}
                className="w-full h-full border-0 rounded bg-white"
                sandbox="allow-scripts"
                title="File preview"
              />
            ) : (
              <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                {previewContent}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <dialog className="modal modal-open">
          <div className="modal-box max-w-sm">
            <h3 className="font-bold text-lg">Delete file?</h3>
            <p className="py-4">
              Are you sure you want to delete <strong>{deleteConfirm}</strong>? This cannot be
              undone.
            </p>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </button>
              <button className="btn btn-error" onClick={() => handleDelete(deleteConfirm)}>
                Delete
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setDeleteConfirm(null)}>close</button>
          </form>
        </dialog>
      )}

      {/* File viewer modal */}
      {viewerFile && (
        <FileViewerModal
          name={viewerFile.name}
          content={viewerFile.content}
          onClose={() => setViewerFile(null)}
        />
      )}
    </div>
  );
}

function isRenderable(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ['html', 'htm', 'svg'].includes(ext);
}
