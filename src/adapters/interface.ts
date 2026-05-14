/**
 * Abstract base class for remote protocol adapters (FTP / SFTP).
 * Each adapter wraps a third-party client library and exposes a uniform API.
 */

import * as vscode from 'vscode';
import { ConnectionConfig, RemoteDirectoryEntry, RemoteFileStat } from '../types';

export interface IAdapter extends vscode.Disposable {
  /** Open a connection to the remote server. Throws on failure. */
  connect(config: ConnectionConfig, secrets: { password?: string; sshKeyPath?: string; sshPassphrase?: string }): Promise<void>;
  /** Gracefully close the connection. */
  disconnect(): Promise<void>;
  /** Check if the connection is currently active. */
  isConnected(): boolean;
  /** List the contents of a remote directory. */
  listDirectory(remotePath: string): Promise<RemoteDirectoryEntry[]>;
  /** Stat a single remote file or directory. */
  stat(remotePath: string): Promise<RemoteFileStat>;
  /** Read the full contents of a remote file as a Buffer. */
  readFile(remotePath: string): Promise<Buffer>;
  /** Write a Buffer to a remote file, overwriting if it exists. */
  writeFile(remotePath: string, data: Buffer): Promise<void>;
  /** Create a directory (and parents if needed). */
  createDirectory(remotePath: string): Promise<void>;
  /** Delete a file. */
  deleteFile(remotePath: string): Promise<void>;
  /** Delete a directory (recursively). */
  deleteDirectory(remotePath: string): Promise<void>;
  /** Rename / move a remote file or directory. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Get the current working directory (usually remoteRoot). */
  getCurrentDirectory(): string;
}
