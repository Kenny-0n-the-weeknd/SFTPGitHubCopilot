/**
 * RemoteFileSystemProvider — implements vscode.FileSystemProvider
 * so that remote files appear as first-class workspace files.
 *
 * When a connection is active, we register a provider for the scheme
 * `remote-<connectionId>://`. VS Code (and Copilot) can then read/write
 * these URIs as if they were local files.
 */

import * as vscode from 'vscode';
import { IAdapter } from '../adapters/interface';
import { ConnectionConfig, RemoteDirectoryEntry } from '../types';
import { absoluteRemotePath, remoteStatToFileStat } from '../utils';

interface CachedDirectory {
  expiresAt: number;
  entries?: RemoteDirectoryEntry[];
  promise?: Promise<RemoteDirectoryEntry[]>;
}

interface CachedStat {
  expiresAt: number;
  stat: vscode.FileStat;
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  /** Emitter for file change events */
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;
  private readonly operationQueues = new Map<string, Promise<void>>();
  private readonly directoryCache = new Map<string, CachedDirectory>();
  private readonly statCache = new Map<string, CachedStat>();
  private readonly cacheTtlMs = 10000;
  private readonly maxCachedDirectories = 50;
  private readonly maxCachedStats = 10000;

  constructor(
    private readonly getAdapter: () => IAdapter | undefined,
    private readonly ensureConnected: () => Promise<void>,
    private readonly config: ConnectionConfig,
    private readonly scheme: string,
  ) { }

  private async getAdapterForOperation(): Promise<IAdapter> {
    let a = this.getAdapter();
    if (!a || !a.isConnected()) {
      await this.ensureConnected();
      a = this.getAdapter();
    }
    if (!a) {
      throw vscode.FileSystemError.Unavailable(`Not connected to ${this.config.label}`);
    }
    return a;
  }

  /**
   * Convert a remote-connection URI to the adapter's absolute remote path.
   */
  private toRemotePath(uri: vscode.Uri): string {
    // The URI looks like: remote-<id>:///path/to/file
    // Recover authority too, so older malformed URIs like remote-<id>://path/to/file
    // do not lose their first path segment.
    const p = uri.authority ? `/${uri.authority}${uri.path}` : uri.path;
    return absoluteRemotePath(p);
  }

  watch(): vscode.Disposable {
    // We cannot efficiently watch remote directories, but we must
    // return a valid disposable to satisfy the interface.
    return new vscode.Disposable(() => { });
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const remotePath = this.toRemotePath(uri);
    try {
      return await this.getCachedStat(uri, remotePath);
    } catch (err) {
      throw this.toFileSystemError(err, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const remotePath = this.toRemotePath(uri);
    try {
      const entries = await this.getCachedDirectory(remotePath);
      const result: [string, vscode.FileType][] = [];
      for (const entry of entries) {
        const type = entry.stat.type === 'directory'
          ? vscode.FileType.Directory
          : entry.stat.type === 'symlink'
            ? vscode.FileType.SymbolicLink
            : vscode.FileType.File;
        result.push([entry.name, type]);
      }
      return result;
    } catch (err) {
      throw this.toFileSystemError(err, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.runQueued(uri, async () => {
      const remotePath = this.toRemotePath(uri);
      const adapter = await this.getAdapterForOperation();
      await adapter.createDirectory(remotePath);
      this.invalidateCaches(remotePath, true);
      this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
    });
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const remotePath = this.toRemotePath(uri);
    try {
      const adapter = await this.getAdapterForOperation();
      const buffer = await adapter.readFile(remotePath);
      return new Uint8Array(buffer);
    } catch (err: any) {
      if (err.message && (err.message.includes('timeout') || err.message.includes('closed') || err.message.includes('not connected'))) {
        throw vscode.FileSystemError.Unavailable(err.message);
      }
      throw err;
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean }): Promise<void> {
    await this.runQueued(uri, async () => {
      const remotePath = this.toRemotePath(uri);
      const adapter = await this.getAdapterForOperation();
      const exists = await this.exists(adapter, remotePath);

      if (!exists && !options.create) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (exists && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(uri);
      }

      await adapter.writeFile(remotePath, Buffer.from(content));
      this.invalidateCaches(remotePath);
      this._emitter.fire([{ type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
    });
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    await this.runQueued(uri, async () => {
      const remotePath = this.toRemotePath(uri);
      try {
        const adapter = await this.getAdapterForOperation();
        const stat = await adapter.stat(remotePath);
        if (stat.type === 'directory') {
          if (!options.recursive) {
            const entries = await adapter.listDirectory(remotePath);
            if (entries.length > 0) {
              throw vscode.FileSystemError.NoPermissions('Directory is not empty');
            }
          }
          await adapter.deleteDirectory(remotePath);
        } else {
          await adapter.deleteFile(remotePath);
        }
        this.invalidateCaches(remotePath, stat.type === 'directory');
        this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
      } catch (err: any) {
        throw this.toFileSystemError(err, uri);
      }
    });
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): Promise<void> {
    await this.runQueued([oldUri, newUri], async () => {
      const oldPath = this.toRemotePath(oldUri);
      const newPath = this.toRemotePath(newUri);
      const adapter = await this.getAdapterForOperation();
      const destinationExists = await this.exists(adapter, newPath);

      if (destinationExists && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(newUri);
      }
      if (destinationExists) {
        const stat = await adapter.stat(newPath);
        if (stat.type === 'directory') {
          await adapter.deleteDirectory(newPath);
        } else {
          await adapter.deleteFile(newPath);
        }
      }

      await adapter.rename(oldPath, newPath);
  this.invalidateCaches(oldPath, true);
  this.invalidateCaches(newPath, true);
      this._emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
    });
  }

  // -- Optional: copy (not supported) --
  async copy(): Promise<void> {
    throw vscode.FileSystemError.NoPermissions('Copy is not supported for remote files');
  }

  private async exists(adapter: IAdapter, remotePath: string): Promise<boolean> {
    try {
      await adapter.stat(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  private async getCachedDirectory(remotePath: string): Promise<RemoteDirectoryEntry[]> {
    const now = Date.now();
    const cached = this.directoryCache.get(remotePath);
    if (cached?.entries && cached.expiresAt > now) {
      return cached.entries;
    }
    if (cached?.promise) {
      return cached.promise;
    }

    const promise = this.getAdapterForOperation().then(adapter => adapter.listDirectory(remotePath));
    this.directoryCache.set(remotePath, { expiresAt: now + this.cacheTtlMs, promise });
    this.pruneCaches();

    try {
      const entries = await promise;
      const expiresAt = Date.now() + this.cacheTtlMs;
      this.directoryCache.set(remotePath, { expiresAt, entries });
      for (const entry of entries) {
        const [type, perms] = remoteStatToFileStat(entry.stat);
        this.statCache.set(entry.path, {
          expiresAt,
          stat: { type, ctime: perms.ctime, mtime: perms.mtime, size: perms.size },
        });
      }
      this.pruneCaches();
      return entries;
    } catch (err) {
      this.directoryCache.delete(remotePath);
      throw err;
    }
  }

  private async getCachedStat(uri: vscode.Uri, remotePath: string): Promise<vscode.FileStat> {
    const cached = this.statCache.get(remotePath);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.stat;
    }

    const adapter = await this.getAdapterForOperation();
    const stat = await adapter.stat(remotePath);
    const [type, perms] = remoteStatToFileStat(stat);
    const fileStat = { type, ctime: perms.ctime, mtime: perms.mtime, size: perms.size };
    this.statCache.set(remotePath, { expiresAt: Date.now() + this.cacheTtlMs, stat: fileStat });
    this.pruneCaches();
    return fileStat;
  }

  private invalidateCaches(remotePath: string, includeChildren = false): void {
    const parentPath = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
    this.directoryCache.delete(parentPath);
    this.directoryCache.delete(remotePath);
    this.statCache.delete(remotePath);

    if (includeChildren) {
      const prefix = remotePath.endsWith('/') ? remotePath : remotePath + '/';
      for (const key of this.directoryCache.keys()) {
        if (key.startsWith(prefix)) {
          this.directoryCache.delete(key);
        }
      }
      for (const key of this.statCache.keys()) {
        if (key.startsWith(prefix)) {
          this.statCache.delete(key);
        }
      }
    }
  }

  private pruneCaches(): void {
    while (this.directoryCache.size > this.maxCachedDirectories) {
      const oldestKey = this.directoryCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.directoryCache.delete(oldestKey);
    }
    while (this.statCache.size > this.maxCachedStats) {
      const oldestKey = this.statCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.statCache.delete(oldestKey);
    }
  }

  private async runQueued(uriOrUris: vscode.Uri | vscode.Uri[], operation: () => Promise<void>): Promise<void> {
    const uris = Array.isArray(uriOrUris) ? uriOrUris : [uriOrUris];
    const keys = Array.from(new Set(uris.map(uri => uri.toString()))).sort();
    const previous = Promise.all(keys.map(key => this.operationQueues.get(key) ?? Promise.resolve()));

    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const current = previous.then(() => gate);

    for (const key of keys) {
      this.operationQueues.set(key, current);
    }

    await previous;
    try {
      await operation();
    } catch (err) {
      throw this.toFileSystemError(err, uris[0]);
    } finally {
      release();
      for (const key of keys) {
        if (this.operationQueues.get(key) === current) {
          this.operationQueues.delete(key);
        }
      }
    }
  }

  private toFileSystemError(err: unknown, uri: vscode.Uri): vscode.FileSystemError {
    if (err instanceof vscode.FileSystemError) {
      return err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    if (lower.includes('not found') || lower.includes('no such file') || lower.includes('enoent')) {
      return vscode.FileSystemError.FileNotFound(uri);
    }
    if (lower.includes('permission') || lower.includes('access denied') || lower.includes('eacces')) {
      return vscode.FileSystemError.NoPermissions(message);
    }
    if (lower.includes('timeout') || lower.includes('closed') || lower.includes('not connected') || lower.includes('socket') || lower.includes('econnreset')) {
      return vscode.FileSystemError.Unavailable(message);
    }
    return vscode.FileSystemError.Unavailable(message);
  }
}
