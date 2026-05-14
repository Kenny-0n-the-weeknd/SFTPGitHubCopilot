/**
 * SFTP adapter using the "ssh2" library.
 */

import { Client, ConnectConfig } from 'ssh2';
import { IAdapter } from './interface';
import { ConnectionConfig, RemoteDirectoryEntry, RemoteFileStat } from '../types';
import { normaliseRemotePath, joinRemotePath, logInfo } from '../utils';
import * as fs from 'fs';

/** Internal type for an open SFTP session channel */
interface SftpSession {
  client: Client;
  sftp: any; // ssh2's SFTPStream
}

export class SftpAdapter implements IAdapter {
  private session: SftpSession | null = null;
  private remoteRoot = '/';
  private lastConfig?: { config: ConnectionConfig; secrets: { password?: string; sshKeyPath?: string; sshPassphrase?: string } };
  private connectionPromise: Promise<void> | null = null;

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

  private _doConnect(config: ConnectionConfig, secrets: { password?: string; sshKeyPath?: string; sshPassphrase?: string }): Promise<void> {
    if (this.session) {
      this.session.sftp.end();
      this.session.client.end();
      this.session = null;
    }
    const client = new Client();
    this.remoteRoot = normaliseRemotePath(config.remoteRoot || '/');

    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: config.timeout,
    };

    if (config.authMethod === 'key') {
      if (!secrets.sshKeyPath) {
        throw new Error('SSH key path is required for key authentication');
      }
      const keyPath = secrets.sshKeyPath;
      if (!fs.existsSync(keyPath)) {
        throw new Error(`SSH key file not found: ${keyPath}`);
      }
      connectConfig.privateKey = fs.readFileSync(keyPath);
      if (secrets.sshPassphrase) {
        connectConfig.passphrase = secrets.sshPassphrase;
      }
    } else {
      connectConfig.password = secrets.password;
    }

    return new Promise<void>((resolve, reject) => {
      client.on('ready', () => {
        logInfo(`SSH: Authenticated to ${config.host}:${config.port}`);
        client.sftp((err, sftpStream) => {
          if (err) {
            client.end();
            reject(new Error(`SFTP session error: ${err.message}`));
            return;
          }
          this.session = { client, sftp: sftpStream };
          const clearSession = () => {
            if (this.session?.client === client) {
              this.session = null;
            }
          };
          client.on('close', clearSession);
          client.on('end', clearSession);
          sftpStream.on?.('close', clearSession);
          sftpStream.on?.('end', clearSession);
          resolve();
        });
      });

      client.on('error', (err: Error) => {
        reject(new Error(`SFTP connection failed: ${err.message}`));
      });

      client.connect(connectConfig);
    });
  }

  async disconnect(): Promise<void> {
    if (this.session) {
      this.session.sftp.end();
      this.session.client.end();
      this.session = null;
      logInfo('SFTP: Disconnected');
    }
  }

  isConnected(): boolean {
    return this.session !== null;
  }

  async listDirectory(remotePath: string): Promise<RemoteDirectoryEntry[]> {
    const session = await this.getSession();
    const absPath = this.toAbsolute(remotePath);

    const items: any[] = await new Promise((resolve, reject) => {
      session.sftp.readdir(absPath, (err: any, list: any[]) => {
        if (err) { reject(err); } else { resolve(list); }
      });
    });

    const entries: RemoteDirectoryEntry[] = [];
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') { continue; }
      const entryPath = joinRemotePath(absPath, item.filename);
      entries.push({
        name: item.filename,
        path: entryPath,
        stat: {
          type: this.isDirectory(item.attrs)
            ? 'directory' : this.isSymlink(item.attrs) ? 'symlink' : 'file',
          ctime: item.attrs.atime * 1000,
          mtime: item.attrs.mtime * 1000,
          size: item.attrs.size,
          permissions: this.formatPermissions(item.attrs),
        },
      });
    }
    return entries;
  }

  async stat(remotePath: string): Promise<RemoteFileStat> {
    const session = await this.getSession();
    const absPath = this.toAbsolute(remotePath);

    const attrs: any = await new Promise((resolve, reject) => {
      session.sftp.stat(absPath, (err: any, stats: any) => {
        if (err) { reject(err); } else { resolve(stats); }
      });
    });

    return {
      type: this.isDirectory(attrs) ? 'directory' : this.isSymlink(attrs) ? 'symlink' : 'file',
      ctime: attrs.atime * 1000,
      mtime: attrs.mtime * 1000,
      size: attrs.size,
      permissions: this.formatPermissions(attrs),
    };
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const session = await this.getSession();
    const absPath = this.toAbsolute(remotePath);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = session.sftp.createReadStream(absPath);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  async writeFile(remotePath: string, data: Buffer): Promise<void> {
    const session = await this.getSession();
    const absPath = this.toAbsolute(remotePath);

    return new Promise((resolve, reject) => {
      const stream = session.sftp.createWriteStream(absPath);
      stream.on('finish', resolve);
      stream.on('error', reject);
      stream.end(data);
    });
  }

  async createDirectory(remotePath: string): Promise<void> {
    const session = await this.getSession();
    const absPath = this.toAbsolute(remotePath);

    return new Promise((resolve, reject) => {
      session.sftp.mkdir(absPath, { mode: 0o755 }, (err: any) => {
        if (err && !err.message?.includes('already exists')) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async deleteFile(remotePath: string): Promise<void> {
    const session = await this.getSession();
    const absPath = this.toAbsolute(remotePath);

    return new Promise((resolve, reject) => {
      session.sftp.unlink(absPath, (err: any) => {
        if (err) { reject(err); } else { resolve(); }
      });
    });
  }

  async deleteDirectory(remotePath: string): Promise<void> {
    const absPath = this.toAbsolute(remotePath);
    await this.recursiveDelete(absPath);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const session = await this.getSession();
    const absOld = this.toAbsolute(oldPath);
    const absNew = this.toAbsolute(newPath);

    return new Promise((resolve, reject) => {
      session.sftp.rename(absOld, absNew, (err: any) => {
        if (err) { reject(err); } else { resolve(); }
      });
    });
  }

  getCurrentDirectory(): string {
    return this.remoteRoot;
  }

  dispose(): void {
    if (this.session) {
      this.session.sftp.end();
      this.session.client.end();
      this.session = null;
    }
  }

  // -- private helpers --

  private async getSession(): Promise<SftpSession> {
    if (!this.session) {
      if (this.lastConfig) {
        await this.connect(this.lastConfig.config, this.lastConfig.secrets);
      } else {
        throw new Error('SFTP: Not connected');
      }
    }
    return this.session!;
  }

  private toAbsolute(p: string): string {
    const clean = normaliseRemotePath(p);
    if (clean.startsWith('/')) { return clean; }
    return joinRemotePath(this.remoteRoot, clean);
  }

  private isDirectory(attrs: any): boolean {
    return attrs?.mode != null && (attrs.mode & 0o040000) !== 0;
  }

  private isSymlink(attrs: any): boolean {
    return attrs?.mode != null && (attrs.mode & 0o120000) !== 0;
  }

  private formatPermissions(attrs: any): string | undefined {
    if (attrs?.mode == null) { return undefined; }
    const mode = attrs.mode;
    const typeChar = this.isDirectory(attrs) ? 'd' : this.isSymlink(attrs) ? 'l' : '-';
    const rwx = (bits: number) => {
      const r = (bits & 4) ? 'r' : '-';
      const w = (bits & 2) ? 'w' : '-';
      const x = (bits & 1) ? 'x' : '-';
      return r + w + x;
    };
    const owner = rwx((mode >> 6) & 7);
    const group = rwx((mode >> 3) & 7);
    const other = rwx(mode & 7);
    return typeChar + owner + group + other;
  }

  private async recursiveDelete(remotePath: string): Promise<void> {
    const entries = await this.listDirectory(remotePath);
    for (const entry of entries) {
      const entryPath = joinRemotePath(remotePath, entry.name);
      if (entry.stat.type === 'directory') {
        await this.recursiveDelete(entryPath);
      } else {
        await this.deleteFile(entryPath);
      }
    }
    const session = await this.getSession();
    return new Promise((resolve, reject) => {
      session.sftp.rmdir(remotePath, (err: any) => {
        if (err) { reject(err); } else { resolve(); }
      });
    });
  }
}
