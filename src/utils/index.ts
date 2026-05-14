/**
 * Utilities: logging, path helpers, and secret storage wrapper.
 */

import * as vscode from 'vscode';

/** Dedicated output channel for Remote Explorer logs */
const outputChannel = vscode.window.createOutputChannel('Remote Explorer', { log: true });

/**
 * Write an info-level message to the Remote Explorer output channel.
 */
export function logInfo(message: string): void {
  outputChannel.info(`[INFO] ${message}`);
}

/**
 * Write a warning-level message to the Remote Explorer output channel.
 */
export function logWarn(message: string): void {
  outputChannel.warn(`[WARN] ${message}`);
}

/**
 * Write an error-level message to the Remote Explorer output channel.
 */
export function logError(message: string): void {
  outputChannel.error(`[ERROR] ${message}`);
}

/**
 * Show an error popup to the user.
 */
export function showError(message: string): void {
  logError(message);
  vscode.window.showErrorMessage(`Remote Explorer: ${message}`);
}

/**
 * Show a warning popup to the user.
 */
export function showWarning(message: string): void {
  logWarn(message);
  vscode.window.showWarningMessage(`Remote Explorer: ${message}`);
}

/**
 * Show an info popup to the user.
 */
export function showInfo(message: string): void {
  logInfo(message);
  vscode.window.showInformationMessage(`Remote Explorer: ${message}`);
}

/**
 * Normalise a remote path to always use forward slashes and no trailing slash
 * (except for the root '/').
 */
export function normaliseRemotePath(input: string): string {
  let path = input.replace(/\\/g, '/');
  // Collapse multiple slashes
  path = path.replace(/\/+/g, '/');
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path || '/';
}

/**
 * Join two remote path segments with a forward slash.
 */
export function joinRemotePath(base: string, ...segments: string[]): string {
  let result = normaliseRemotePath(base);
  for (const seg of segments) {
    if (seg) {
      result = result.replace(/\/$/, '') + '/' + normaliseRemotePath(seg).replace(/^\//, '');
    }
  }
  return result || '/';
}

/**
 * Return the parent remote directory path.
 */
export function dirnameRemote(path: string): string {
  const p = normaliseRemotePath(path);
  if (p === '/') {
    return '/';
  }
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.substring(0, idx);
}

/**
 * Return the basename of a remote path.
 */
export function basenameRemote(path: string): string {
  const p = normaliseRemotePath(path);
  if (p === '/') {
    return '/';
  }
  const idx = p.lastIndexOf('/');
  return p.substring(idx + 1);
}

/**
 * Convert a remote stat to vscode.FileStat.
 */
import { RemoteFileStat } from '../types';
import { FileType } from 'vscode';

export function remoteStatToFileStat(stat: RemoteFileStat): [FileType, { ctime: number; mtime: number; size: number }] {
  const type = stat.type === 'directory'
    ? FileType.Directory
    : stat.type === 'symlink'
      ? FileType.SymbolicLink
      : FileType.File;
  return [type, { ctime: stat.ctime, mtime: stat.mtime, size: stat.size }];
}

/**
 * Safely store a secret using VS Code SecretStorage.
 */
export async function storeSecret(context: vscode.ExtensionContext, key: string, value: string): Promise<void> {
  await context.secrets.store(key, value);
}

/**
 * Retrieve a secret.
 */
export async function getSecret(context: vscode.ExtensionContext, key: string): Promise<string | undefined> {
  return context.secrets.get(key);
}

/**
 * Delete a secret.
 */
export async function deleteSecret(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.delete(key);
}

/**
 * Generate a short unique ID for a new connection.
 */
export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
}

/** Dispose the output channel when extension deactivates */
export function disposeOutputChannel(): void {
  outputChannel.dispose();
}
