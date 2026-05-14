/**
 * FTP adapter using the "basic-ftp" library.
 */

import * as ftp from 'basic-ftp';
import { Writable, Readable } from 'stream';
import { IAdapter } from './interface';
import { ConnectionConfig, RemoteDirectoryEntry, RemoteFileStat } from '../types';
import { normaliseRemotePath, joinRemotePath, logInfo } from '../utils';

interface DirectoryCacheEntry {
  expiresAt: number;
  entries?: RemoteDirectoryEntry[];
  promise?: Promise<RemoteDirectoryEntry[]>;
}

export class FtpAdapter implements IAdapter {
  private client: ftp.Client | null = null;
  private remoteRoot = '/';
  private lastConfig?: { config: ConnectionConfig; secrets: { password?: string; sshKeyPath?: string; sshPassphrase?: string } };
  private connectionPromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly directoryCache = new Map<string, DirectoryCacheEntry>();
  private readonly directoryCacheTtlMs = 15000;
  private readonly maxCachedDirectories = 50;

  async connect(
    config: ConnectionConfig,
    secrets: { password?: string; sshKeyPath?: string; sshPassphrase?: string }
  ): Promise<void> {
    this.lastConfig = { config, secrets };

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this._doConnect(config, secrets);
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  private async _doConnect(config: ConnectionConfig, secrets: { password?: string; sshKeyPath?: string; sshPassphrase?: string }): Promise<void> {
    if (this.client) {
      this.client.close();
    }
    this.directoryCache.clear();
    this.client = new ftp.Client(config.timeout);
    this.client.ftp.verbose = false;
    this.remoteRoot = normaliseRemotePath(config.remoteRoot || '/');

    try {
      await this.client.access({
        host: config.host,
        port: config.port,
        user: config.username,
        password: secrets.password || '',
        secure: config.useTls,
        secureOptions: config.useTls ? { rejectUnauthorized: false } : undefined,
      });

      // Navigate to the remote root
      if (this.remoteRoot !== '/') {
        await this.client.ensureDir(this.remoteRoot);
        await this.client.cd(this.remoteRoot);
      }

      logInfo(`FTP: Connected to ${config.host}:${config.port}`);
    } catch (err: any) {
      if (this.client) {
        this.client.close();
        this.client = null;
      }
      throw new Error(`FTP connection failed: ${err.message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = null;
      this.directoryCache.clear();
      logInfo('FTP: Disconnected');
    }
  }

  isConnected(): boolean {
    return this.client !== null && !this.client.closed;
  }

  async listDirectory(remotePath: string): Promise<RemoteDirectoryEntry[]> {
    const absPath = this.toAbsolute(remotePath);
    const entries = await this.getDirectoryEntries(absPath);
    return entries.map(entry => ({ ...entry, stat: { ...entry.stat } }));
  }

  async stat(remotePath: string): Promise<RemoteFileStat> {
    const absPath = this.toAbsolute(remotePath);
    const parentPath = absPath.substring(0, absPath.lastIndexOf('/')) || '/';
    const name = absPath.substring(absPath.lastIndexOf('/') + 1);

    if (parentPath === absPath) {
      return { type: 'directory', ctime: 0, mtime: 0, size: 0 };
    }

    const list = await this.getDirectoryEntries(parentPath);
    const found = list.find(item => item.name === name);

    if (!found) {
      try {
        const size = await this.runExclusive(client => client.size(absPath));
        return { type: 'file', ctime: 0, mtime: Date.now(), size };
      } catch {
        throw new Error(`File not found: ${absPath}`);
      }
    }

    return { ...found.stat };
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const absPath = this.toAbsolute(remotePath);
    return this.runExclusive(async client => {
      const chunks: Buffer[] = [];
      const writable = new Writable({
        write(chunk: Buffer, _enc: string, cb: () => void) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });

      await client.downloadTo(writable, absPath);
      return Buffer.concat(chunks);
    });
  }

  async writeFile(remotePath: string, data: Buffer): Promise<void> {
    const absPath = this.toAbsolute(remotePath);
    await this.runExclusive(async client => {
      const readable = Readable.from(data);
      await client.uploadFrom(readable, absPath);
    });
    this.invalidatePath(absPath);
  }

  async createDirectory(remotePath: string): Promise<void> {
    const absPath = this.toAbsolute(remotePath);
    await this.runExclusive(client => client.ensureDir(absPath));
    this.invalidatePath(absPath, true);
  }

  async deleteFile(remotePath: string): Promise<void> {
    const absPath = this.toAbsolute(remotePath);
    await this.runExclusive(client => client.remove(absPath));
    this.invalidatePath(absPath);
  }

  async deleteDirectory(remotePath: string): Promise<void> {
    const absPath = this.toAbsolute(remotePath);
    await this.runExclusive(client => client.removeDir(absPath));
    this.invalidatePath(absPath, true);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const absOld = this.toAbsolute(oldPath);
    const absNew = this.toAbsolute(newPath);
    await this.runExclusive(async client => {
      try {
        await client.rename(absOld, absNew);
      } catch (err: any) {
        throw new Error(`FTP rename failed: ${err.message}`);
      }
    });
    this.invalidatePath(absOld, true);
    this.invalidatePath(absNew, true);
  }

  getCurrentDirectory(): string {
    return this.remoteRoot;
  }

  dispose(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }

  // -- private helpers --

  private async getClient(): Promise<ftp.Client> {
    if (!this.client || this.client.closed) {
      if (this.lastConfig) {
        await this.connect(this.lastConfig.config, this.lastConfig.secrets);
      } else {
        throw new Error('FTP: Not connected');
      }
    }
    return this.client!;
  }

  private async runExclusive<T>(operation: (client: ftp.Client) => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>(resolve => {
      release = resolve;
    });

    await previous;
    try {
      const client = await this.getClient();
      return await operation(client);
    } catch (err) {
      if (this.isConnectionError(err)) {
        this.client?.close();
        this.client = null;
        this.directoryCache.clear();
        const client = await this.getClient();
        return await operation(client);
      }
      throw err;
    } finally {
      release();
    }
  }

  private isConnectionError(err: unknown): boolean {
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    return message.includes('closed') || message.includes('timeout') || message.includes('socket') || message.includes('econnreset');
  }

  private async getDirectoryEntries(absPath: string): Promise<RemoteDirectoryEntry[]> {
    const now = Date.now();
    const cached = this.directoryCache.get(absPath);
    if (cached?.entries && cached.expiresAt > now) {
      return cached.entries;
    }
    if (cached?.promise) {
      return cached.promise;
    }

    const promise = this.runExclusive(async client => {
      const raw = await client.list(absPath);
      const entries: RemoteDirectoryEntry[] = [];

      for (const item of raw) {
        if (item.name === '.' || item.name === '..') {
          continue;
        }
        const entryPath = joinRemotePath(absPath, item.name);
        entries.push({
          name: item.name,
          path: entryPath,
          stat: {
            type: item.isDirectory ? 'directory' : item.isSymbolicLink ? 'symlink' : 'file',
            ctime: 0,
            mtime: item.modifiedAt ? item.modifiedAt.getTime() : Date.now(),
            size: item.size || 0,
            permissions: item.permissions?.user && item.permissions?.group && item.permissions?.world
              ? `-${item.permissions.user}${item.permissions.group}${item.permissions.world}`
              : undefined,
          },
        });
      }

      return entries;
    });

    this.directoryCache.set(absPath, { expiresAt: now + this.directoryCacheTtlMs, promise });
    this.pruneDirectoryCache();
    try {
      const entries = await promise;
      this.directoryCache.set(absPath, { expiresAt: Date.now() + this.directoryCacheTtlMs, entries });
      this.pruneDirectoryCache();
      return entries;
    } catch (err) {
      this.directoryCache.delete(absPath);
      throw err;
    }
  }

  private invalidatePath(absPath: string, includeSelf = false): void {
    const parentPath = absPath.substring(0, absPath.lastIndexOf('/')) || '/';
    this.directoryCache.delete(parentPath);
    if (includeSelf) {
      this.directoryCache.delete(absPath);
      const prefix = absPath.endsWith('/') ? absPath : absPath + '/';
      for (const key of this.directoryCache.keys()) {
        if (key.startsWith(prefix)) {
          this.directoryCache.delete(key);
        }
      }
    }
  }

  private pruneDirectoryCache(): void {
    while (this.directoryCache.size > this.maxCachedDirectories) {
      const oldestKey = this.directoryCache.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.directoryCache.delete(oldestKey);
    }
  }

  private toAbsolute(p: string): string {
    const clean = normaliseRemotePath(p);
    if (clean.startsWith('/')) {
      return clean;
    }
    return joinRemotePath(this.remoteRoot, clean);
  }
}
