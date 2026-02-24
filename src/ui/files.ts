// ---------------------------------------------------------------------------
// OpenBrowserClaw — Files UI Component (OPFS browser + download)
// ---------------------------------------------------------------------------

import { DEFAULT_GROUP_ID, OPFS_ROOT } from '../config.js';
import { listGroupFiles, readGroupFile, deleteGroupFile } from '../storage.js';
import { el } from './app.js';

/**
 * File browser UI. Browse the OPFS workspace, view file contents,
 * and download files to disk.
 */
export class FilesUI {
  private container: HTMLElement | null = null;
  private breadcrumbEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private groupId: string = DEFAULT_GROUP_ID;
  private currentPath: string[] = []; // path segments from group root

  /**
   * Mount into a container element.
   */
  mount(parent: HTMLElement): void {
    this.container = parent;
    this.container.classList.add('files-container');
    this.render();
    this.loadDirectory();
  }

  // -----------------------------------------------------------------------
  // Private — rendering
  // -----------------------------------------------------------------------

  private render(): void {
    if (!this.container) return;
    this.container.innerHTML = '';

    const wrapper = el('div', 'files-wrapper');

    // Header
    const header = el('div', 'files-header');
    const title = el('h2', 'files-title');
    title.textContent = 'Files';
    header.appendChild(title);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'settings-btn';
    refreshBtn.textContent = '↻ Refresh';
    refreshBtn.addEventListener('click', () => this.loadDirectory());
    header.appendChild(refreshBtn);

    wrapper.appendChild(header);

    // Breadcrumb
    this.breadcrumbEl = el('nav', 'files-breadcrumb');
    wrapper.appendChild(this.breadcrumbEl);

    // File list
    this.listEl = el('div', 'files-list');
    wrapper.appendChild(this.listEl);

    // Preview pane (hidden by default)
    this.previewEl = el('div', 'files-preview');
    this.previewEl.style.display = 'none';
    wrapper.appendChild(this.previewEl);

    this.container.appendChild(wrapper);
  }

  // -----------------------------------------------------------------------
  // Breadcrumb
  // -----------------------------------------------------------------------

  private renderBreadcrumb(): void {
    if (!this.breadcrumbEl) return;
    this.breadcrumbEl.innerHTML = '';

    // Root
    const rootLink = document.createElement('button');
    rootLink.className = 'files-crumb';
    rootLink.textContent = '🏠 workspace';
    rootLink.addEventListener('click', () => {
      this.currentPath = [];
      this.loadDirectory();
    });
    this.breadcrumbEl.appendChild(rootLink);

    // Segments
    this.currentPath.forEach((seg, i) => {
      const sep = el('span', 'files-crumb-sep');
      sep.textContent = '/';
      this.breadcrumbEl!.appendChild(sep);

      const link = document.createElement('button');
      link.className = 'files-crumb';
      link.textContent = seg;
      link.addEventListener('click', () => {
        this.currentPath = this.currentPath.slice(0, i + 1);
        this.loadDirectory();
      });
      this.breadcrumbEl!.appendChild(link);
    });
  }

  // -----------------------------------------------------------------------
  // Directory listing
  // -----------------------------------------------------------------------

  private async loadDirectory(): Promise<void> {
    if (!this.listEl) return;
    this.hidePreview();
    this.renderBreadcrumb();
    this.listEl.innerHTML = '<div class="files-loading">Loading…</div>';

    try {
      const dirPath = this.currentPath.length > 0
        ? this.currentPath.join('/')
        : '.';
      const entries = await listGroupFiles(this.groupId, dirPath);

      if (entries.length === 0) {
        this.listEl.innerHTML = '<div class="files-empty">This directory is empty.</div>';
        return;
      }

      this.listEl.innerHTML = '';

      // Parent dir link (if not at root)
      if (this.currentPath.length > 0) {
        const upEl = this.createEntryEl('📁', '..', true);
        upEl.addEventListener('click', () => {
          this.currentPath.pop();
          this.loadDirectory();
        });
        this.listEl.appendChild(upEl);
      }

      // Sort: dirs first, then files
      const dirs = entries.filter(e => e.endsWith('/'));
      const files = entries.filter(e => !e.endsWith('/'));

      for (const dir of dirs) {
        const name = dir.replace(/\/$/, '');
        const entryEl = this.createEntryEl('📁', name, true);
        entryEl.addEventListener('click', () => {
          this.currentPath.push(name);
          this.loadDirectory();
        });
        this.listEl.appendChild(entryEl);
      }

      for (const file of files) {
        const entryEl = this.createEntryEl(this.fileIcon(file), file, false);
        entryEl.addEventListener('click', () => this.previewFile(file));
        this.listEl.appendChild(entryEl);
      }
    } catch (err) {
      this.listEl.innerHTML = `<div class="files-empty">Could not list directory: ${(err as Error).message}</div>`;
    }
  }

  private createEntryEl(icon: string, name: string, isDir: boolean): HTMLElement {
    const row = el('div', 'files-entry');
    if (isDir) row.classList.add('files-entry-dir');

    const iconEl = el('span', 'files-entry-icon');
    iconEl.textContent = icon;
    row.appendChild(iconEl);

    const nameEl = el('span', 'files-entry-name');
    nameEl.textContent = name;
    row.appendChild(nameEl);

    return row;
  }

  // -----------------------------------------------------------------------
  // File preview & actions
  // -----------------------------------------------------------------------

  private async previewFile(filename: string): Promise<void> {
    if (!this.previewEl) return;

    const fullPath = this.currentPath.length > 0
      ? this.currentPath.join('/') + '/' + filename
      : filename;

    this.previewEl.innerHTML = '<div class="files-loading">Loading…</div>';
    this.previewEl.style.display = 'block';

    try {
      const content = await readGroupFile(this.groupId, fullPath);
      this.previewEl.innerHTML = '';

      // Action bar
      const actions = el('div', 'files-preview-actions');

      const pathLabel = el('span', 'files-preview-path');
      pathLabel.textContent = fullPath;
      actions.appendChild(pathLabel);

      const btnGroup = el('div', 'files-preview-btns');

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'settings-btn files-action-btn';
      downloadBtn.textContent = '⬇ Download';
      downloadBtn.addEventListener('click', () => this.downloadFile(filename, content));
      btnGroup.appendChild(downloadBtn);

      // Open in new tab (useful for HTML files)
      if (this.isPreviewableInBrowser(filename)) {
        const openBtn = document.createElement('button');
        openBtn.className = 'settings-btn files-action-btn';
        openBtn.textContent = '↗ Open in tab';
        openBtn.addEventListener('click', () => this.openInNewTab(filename, content));
        btnGroup.appendChild(openBtn);
      }

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'settings-btn files-action-btn files-action-btn-danger';
      deleteBtn.textContent = '✕ Delete';
      deleteBtn.addEventListener('click', () => this.confirmDelete(fullPath, filename));
      btnGroup.appendChild(deleteBtn);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'settings-btn files-action-btn';
      closeBtn.textContent = '✕ Close';
      closeBtn.addEventListener('click', () => this.hidePreview());
      btnGroup.appendChild(closeBtn);

      actions.appendChild(btnGroup);
      this.previewEl.appendChild(actions);

      // Content preview
      const contentEl = el('pre', 'files-preview-content');
      const codeEl = document.createElement('code');

      // Truncate very long files for display
      const MAX_PREVIEW = 50_000;
      if (content.length > MAX_PREVIEW) {
        codeEl.textContent = content.slice(0, MAX_PREVIEW) + `\n\n… (${content.length - MAX_PREVIEW} more characters, download to see full file)`;
      } else {
        codeEl.textContent = content;
      }
      contentEl.appendChild(codeEl);
      this.previewEl.appendChild(contentEl);
    } catch (err) {
      this.previewEl.innerHTML = `<div class="files-empty">Cannot read file: ${(err as Error).message}</div>`;
    }
  }

  private hidePreview(): void {
    if (this.previewEl) {
      this.previewEl.style.display = 'none';
      this.previewEl.innerHTML = '';
    }
  }

  // -----------------------------------------------------------------------
  // Download & open
  // -----------------------------------------------------------------------

  private downloadFile(filename: string, content: string): void {
    const mimeType = this.guessMimeType(filename);
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private openInNewTab(filename: string, content: string): void {
    const mimeType = this.guessMimeType(filename);
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Revoke after a short delay to let the tab load
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  private async confirmDelete(fullPath: string, filename: string): Promise<void> {
    if (!confirm(`Delete "${filename}"? This cannot be undone.`)) return;
    try {
      await deleteGroupFile(this.groupId, fullPath);
      this.hidePreview();
      await this.loadDirectory();
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private fileIcon(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const icons: Record<string, string> = {
      html: '🌐', htm: '🌐',
      css: '🎨',
      js: '📜', ts: '📜', mjs: '📜',
      json: '📋',
      md: '📝', txt: '📝',
      svg: '🖼️', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️',
      py: '🐍',
      sh: '⚙️', bash: '⚙️',
      xml: '📄',
      csv: '📊',
      yaml: '📄', yml: '📄',
    };
    return icons[ext] ?? '📄';
  }

  private isPreviewableInBrowser(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return ['html', 'htm', 'svg'].includes(ext);
  }

  private guessMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const types: Record<string, string> = {
      html: 'text/html', htm: 'text/html',
      css: 'text/css',
      js: 'text/javascript', mjs: 'text/javascript',
      ts: 'text/typescript',
      json: 'application/json',
      md: 'text/markdown',
      txt: 'text/plain',
      svg: 'image/svg+xml',
      xml: 'application/xml',
      csv: 'text/csv',
      yaml: 'text/yaml', yml: 'text/yaml',
      py: 'text/x-python',
      sh: 'text/x-shellscript',
    };
    return types[ext] ?? 'text/plain';
  }
}
