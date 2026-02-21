// ---------------------------------------------------------------------------
// BrowserClaw — OPFS (Origin Private File System) helpers
// ---------------------------------------------------------------------------

import { OPFS_ROOT } from './config.js';

/**
 * Get a handle to a nested directory, creating intermediate dirs.
 */
async function getNestedDir(
  root: FileSystemDirectoryHandle,
  ...segments: string[]
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const seg of segments) {
    current = await current.getDirectoryHandle(seg, { create: true });
  }
  return current;
}

/**
 * Get the group workspace directory.
 */
async function getGroupDir(groupId: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  // Sanitize groupId for filesystem: replace colons with dashes
  const safeId = groupId.replace(/:/g, '-');
  return getNestedDir(root, OPFS_ROOT, 'groups', safeId);
}

/**
 * Get the workspace subdirectory for a group.
 */
async function getWorkspaceDir(groupId: string): Promise<FileSystemDirectoryHandle> {
  const groupDir = await getGroupDir(groupId);
  return groupDir.getDirectoryHandle('workspace', { create: true });
}

/**
 * Parse a path into directory segments and filename.
 */
function parsePath(filePath: string): { dirs: string[]; filename: string } {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error('Empty file path');
  const filename = parts.pop()!;
  return { dirs: parts, filename };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a file from a group's workspace.
 */
export async function readGroupFile(
  groupId: string,
  filePath: string,
): Promise<string> {
  const groupDir = await getGroupDir(groupId);
  const { dirs, filename } = parsePath(filePath);

  let dir = groupDir;
  for (const seg of dirs) {
    dir = await dir.getDirectoryHandle(seg);
  }

  const fileHandle = await dir.getFileHandle(filename);
  const file = await fileHandle.getFile();
  return file.text();
}

/**
 * Write content to a file in a group's workspace.
 * Creates intermediate directories as needed.
 */
export async function writeGroupFile(
  groupId: string,
  filePath: string,
  content: string,
): Promise<void> {
  const groupDir = await getGroupDir(groupId);
  const { dirs, filename } = parsePath(filePath);

  let dir = groupDir;
  for (const seg of dirs) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }

  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

/**
 * List files and directories in a group's workspace directory.
 */
export async function listGroupFiles(
  groupId: string,
  dirPath: string = '.',
): Promise<string[]> {
  const groupDir = await getGroupDir(groupId);

  let dir = groupDir;
  if (dirPath && dirPath !== '.') {
    const parts = dirPath.replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
    for (const seg of parts) {
      dir = await dir.getDirectoryHandle(seg);
    }
  }

  const entries: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    entries.push(handle.kind === 'directory' ? `${name}/` : name);
  }
  return entries.sort();
}

/**
 * Delete a file from a group's workspace.
 */
export async function deleteGroupFile(
  groupId: string,
  filePath: string,
): Promise<void> {
  const groupDir = await getGroupDir(groupId);
  const { dirs, filename } = parsePath(filePath);

  let dir = groupDir;
  for (const seg of dirs) {
    dir = await dir.getDirectoryHandle(seg);
  }

  await dir.removeEntry(filename);
}

/**
 * Check if a file exists in a group's workspace.
 */
export async function groupFileExists(
  groupId: string,
  filePath: string,
): Promise<boolean> {
  try {
    await readGroupFile(groupId, filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Request persistent storage so the browser doesn't evict our data.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage && navigator.storage.persist) {
    return navigator.storage.persist();
  }
  return false;
}

/**
 * Get storage usage estimate.
 */
export async function getStorageEstimate(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0,
    };
  }
  return { usage: 0, quota: 0 };
}
