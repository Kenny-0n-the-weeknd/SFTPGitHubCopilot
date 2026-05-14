/**
 * ConnectionManager: the central orchestrator for all remote connections.
 *
 * Responsibilities:
 * - Persist connection configs to workspace/global storage
 * - Store/retrieve secrets (passwords, SSH keys) via VS Code SecretStorage
 * - Create and dispose FTP/SFTP adapters
 * - Track per-connection state (status, error, etc.)
 * - Expose the currently active FileSystemProvider for a connection
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionConfig, ConnectionState, ConnectionSecrets } from '../types';
import { IAdapter } from '../adapters/interface';
import { FtpAdapter } from '../adapters/ftpAdapter';
import { SftpAdapter } from '../adapters/sftpAdapter';
import { RemoteFileSystemProvider } from '../fs/remoteFileSystemProvider';
import {
  generateId,
  storeSecret,
  getSecret,
  deleteSecret,
  logInfo,
  logError,
  showError,
  absoluteRemotePath,
  remoteUriForPath,
} from '../utils';
import { RemoteTreeDataProvider } from '../ui/treeView';

const CONNECTIONS_STORAGE_KEY = 'remoteExplorer.connections';
const SECRET_PREFIX = 'remoteExplorer.secret.';

export class ConnectionManager {
  /** Map connection id -> runtime state (config + status) */
  private states = new Map<string, ConnectionState>();

  /** Map connection id -> active IAdapter instance */
  private adapters = new Map<string, IAdapter>();

  /** Map connection id -> active FileSystemProvider */
  private fsProviders = new Map<string, RemoteFileSystemProvider>();

  /** Registered filesystem scheme URIs per connection to enable workspace access */
  private registeredSchemes = new Set<string>();

  /** Map connection id -> in-flight connection startup promise */
  private startPromises = new Map<string, Promise<void>>();

  /** Connection ids explicitly disconnected by the user; filesystem auto-start must not restart them. */
  private autoStartBlocked = new Set<string>();

  /** Connection ids currently being stopped. */
  private stoppingConnections = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly treeProvider: RemoteTreeDataProvider,
  ) { }

  // ---- Persistence ----

  /**
   * Load all saved connections from extension storage.
   */
  async loadConnections(): Promise<ConnectionConfig[]> {
    const raw = this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_STORAGE_KEY, []);
    const configs: ConnectionConfig[] = Array.isArray(raw) ? raw : [];

    // Populate runtime state map
    for (const config of configs) {
      // Sanitize any host that was accidentally saved with a URL scheme
      config.host = config.host.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, '').split('/')[0];
      config.remoteRoot = absoluteRemotePath(config.remoteRoot || '/');
      this.states.set(config.id, {
        config,
        status: 'stopped',
        lastStatusChange: Date.now(),
      });
      this.ensureFsProvider(config);
    }

    logInfo(`Loaded ${configs.length} saved connection(s)`);
    return configs;
  }

  /**
   * Save all connections to extension storage.
   */
  async saveConnections(): Promise<void> {
    const configs: ConnectionConfig[] = [];
    for (const state of this.states.values()) {
      configs.push(state.config);
    }
    await this.context.globalState.update(CONNECTIONS_STORAGE_KEY, configs);
    logInfo(`Saved ${configs.length} connection(s)`);
  }

  // ---- CRUD ----

  /**
   * Create a new connection config and persist it.
   */
  async addConnection(config: ConnectionConfig): Promise<void> {
    config.id = config.id || generateId();
    // Strip any URL scheme the user may have typed into the host field
    config.host = config.host.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, '').split('/')[0];
    config.remoteRoot = absoluteRemotePath(config.remoteRoot || '/');
    this.states.set(config.id, {
      config,
      status: 'stopped',
      lastStatusChange: Date.now(),
    });
    this.ensureFsProvider(config);
    await this.saveConnections();
  }

  /**
   * Update an existing connection config.
   */
  async updateConnection(id: string, partial: Partial<ConnectionConfig>): Promise<void> {
    const state = this.states.get(id);
    if (!state) {
      throw new Error(`Connection not found: ${id}`);
    }
    // Sanitize host in case it contains a URL scheme
    if (partial.host) {
      partial.host = partial.host.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, '').split('/')[0];
    }
    if (partial.remoteRoot) {
      partial.remoteRoot = absoluteRemotePath(partial.remoteRoot);
    }
    Object.assign(state.config, partial);
    await this.saveConnections();
    logInfo(`Updated connection: ${state.config.label} (host: ${state.config.host})`);
  }

  /**
   * Delete a connection and all its stored data.
   */
  async deleteConnection(id: string): Promise<void> {
    // Disconnect if currently running
    if (this.adapters.has(id)) {
      await this.stopConnection(id); // removes workspace folder
    }

    // Dispose FileSystemProvider since the connection is permanently deleted
    const fsProvider = this.fsProviders.get(id);
    if (fsProvider) {
      const disposable = (fsProvider as any)._disposable as vscode.Disposable;
      if (disposable) {
        disposable.dispose();
      }
      this.fsProviders.delete(id);
      this.registeredSchemes.delete(`remote-${id}`);
    }

    this.states.delete(id);
    await this.deleteSecrets(id);
    await this.saveConnections();
  }

  // ---- Connection lifecycle ----

  /**
   * Start / connect to a saved connection.
   */
  async startConnection(id: string, isManualStart = true): Promise<void> {
    const state = this.states.get(id);
    if (!state) {
      throw new Error(`Connection not found: ${id}`);
    }

    if (isManualStart) {
      this.autoStartBlocked.delete(id);
    } else if (this.autoStartBlocked.has(id) || this.stoppingConnections.has(id)) {
      throw new Error(`Connection ${state.config.label} is disconnected`);
    }

    const activeAdapter = this.adapters.get(id);
    if (state.status === 'running' && activeAdapter?.isConnected()) {
      return;
    }

    const existingStart = this.startPromises.get(id);
    if (existingStart) {
      return existingStart;
    }

    const startPromise = this.doStartConnection(id, state);
    this.startPromises.set(id, startPromise);
    try {
      await startPromise;
    } finally {
      this.startPromises.delete(id);
    }
  }

  private async doStartConnection(id: string, state: ConnectionState): Promise<void> {
    const existingAdapter = this.adapters.get(id);
    if (existingAdapter?.isConnected()) {
      this.updateStatus(id, 'running');
      return;
    }

    if (existingAdapter) {
      try {
        await existingAdapter.disconnect();
      } catch {
        // Ignore cleanup errors from a stale socket.
      }
      existingAdapter.dispose();
      this.adapters.delete(id);
    }

    this.updateStatus(id, 'connecting');

    try {
      const secrets = await this.loadSecrets(id);
      const adapter = this.createAdapter(state.config.protocol);
      await adapter.connect(state.config, secrets);

      if (this.autoStartBlocked.has(id) || this.stoppingConnections.has(id)) {
        await adapter.disconnect().catch(() => undefined);
        adapter.dispose();
        this.updateStatus(id, 'stopped');
        return;
      }

      this.adapters.set(id, adapter);

      this.ensureFsProvider(state.config);

      // Add the remote root as a workspace folder so it appears in the Explorer sidebar
      // and becomes available to Copilot. If it already exists, this does nothing.
      const scheme = `remote-${id}`;
      const remoteRootUri = remoteUriForPath(scheme, state.config.remoteRoot);
      const wf = vscode.workspace.workspaceFolders;
      const exists = wf?.some(f => f.uri.scheme === scheme);
      if (!exists) {
        vscode.workspace.updateWorkspaceFolders(
          wf?.length ?? 0,
          0,
          { uri: remoteRootUri, name: `${state.config.label} (${state.config.protocol.toUpperCase()})` }
        );
      }

      this.updateStatus(id, 'running');
      logInfo(`Connected: ${state.config.label} (${state.config.protocol}://${state.config.host})`);
    } catch (err: any) {
      if (this.autoStartBlocked.has(id) || this.stoppingConnections.has(id)) {
        this.updateStatus(id, 'stopped');
        return;
      }
      this.updateStatus(id, 'error', err.message);
      throw err;
    }
  }

  /**
   * Stop / disconnect a connection.
   */
  async stopConnection(id: string, isDeactivating = false): Promise<void> {
    const state = this.states.get(id);
    if (!state) {
      return;
    }

    if (!isDeactivating) {
      this.autoStartBlocked.add(id);
    }
    this.stoppingConnections.add(id);
    this.updateStatus(id, 'stopped');

    try {
      // Dispose the adapter
      const adapter = this.adapters.get(id);
      if (adapter) {
        try {
          await adapter.disconnect();
        } catch {
          // Swallow disconnect errors
        }
        adapter.dispose();
        this.adapters.delete(id);
      }

      // We no longer dispose the FileSystemProvider, because it acts as a permanent 
      // bridge that throws "Unavailable" if the adapter is offline, avoiding workspace errors.

      // Remove workspace folder only if the user explicitly clicked Disconnect,
      // NOT when VS Code is shutting down (so their remote folders stay in their workspace layout for next time).
      if (!isDeactivating) {
        this.removeWorkspaceFolder(id);
      }

      logInfo(`Disconnected: ${state.config.label}`);
    } finally {
      this.stoppingConnections.delete(id);
    }
  }

  async ensureConnectionForFileSystem(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) {
      throw new Error(`Connection not found: ${id}`);
    }
    if (this.autoStartBlocked.has(id) || this.stoppingConnections.has(id)) {
      throw new Error(`Connection ${state.config.label} is disconnected`);
    }
    await this.startConnection(id, false);
  }

  /**
   * Disconnect all active connections.
   */
  async disconnectAll(isDeactivating = false): Promise<void> {
    const ids = Array.from(this.states.keys());
    for (const id of ids) {
      await this.stopConnection(id, isDeactivating);
    }
  }

  /**
   * Attempt to reconnect a dropped connection.
   */
  async reconnect(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) {
      return;
    }
    if (state.status === 'error') {
      await this.stopConnection(id);
      await this.startConnection(id, false);
    }
  }

  // ---- File operations (delegated to active adapter) ----

  /**
   * Open a remote file in a VS Code editor.
   * Uses the custom FileSystemProvider scheme so VS Code treats it like
   * a regular workspace file. This makes it available to GitHub Copilot.
   */
  async openRemoteFile(connectionId: string, remotePath: string): Promise<void> {
    const state = this.states.get(connectionId);
    if (!state) {
      throw new Error(`Connection ${connectionId} not found`);
    }
    if (state.status !== 'running') {
      await this.startConnection(connectionId, false);
    }
    const scheme = `remote-${connectionId}`;
    const uri = remoteUriForPath(scheme, remotePath);

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async uploadFile(connectionId: string, remoteDir: string): Promise<void> {
    const adapter = this.adapters.get(connectionId);
    if (!adapter) {
      throw new Error('Connection is not active');
    }

    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Upload',
      title: 'Select files to upload',
    });
    if (!files || files.length === 0) {
      return;
    }

    for (const fileUri of files) {
      const localPath = fileUri.fsPath;
      const fileName = path.basename(localPath);
      const remotePath = `${remoteDir}/${fileName}`.replace(/\/+/g, '/');
      const data = await vscode.workspace.fs.readFile(fileUri);
      await adapter.writeFile(remotePath, Buffer.from(data));
      logInfo(`Uploaded: ${localPath} -> ${remotePath}`);
    }

    vscode.window.showInformationMessage(`Uploaded ${files.length} file(s)`);
    this.treeProvider.refreshNode(connectionId);
  }

  async downloadFile(connectionId: string, remotePath: string): Promise<void> {
    const adapter = this.adapters.get(connectionId);
    if (!adapter) {
      throw new Error('Connection is not active');
    }

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.basename(remotePath)),
      saveLabel: 'Download',
      title: 'Save remote file as',
    });
    if (!saveUri) {
      return;
    }

    const data = await adapter.readFile(remotePath);
    await vscode.workspace.fs.writeFile(saveUri, data);
    vscode.window.showInformationMessage(`Downloaded: ${path.basename(remotePath)}`);
  }

  async deleteRemote(connectionId: string, remotePath: string, isDirectory: boolean): Promise<void> {
    const adapter = this.adapters.get(connectionId);
    if (!adapter) {
      throw new Error('Connection is not active');
    }

    const confirm = await vscode.window.showWarningMessage(
      `Delete ${isDirectory ? 'directory' : 'file'} "${path.basename(remotePath)}" from remote server?`,
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') {
      return;
    }

    if (isDirectory) {
      await adapter.deleteDirectory(remotePath);
    } else {
      await adapter.deleteFile(remotePath);
    }

    logInfo(`Deleted remote: ${remotePath}`);
    this.treeProvider.refreshNode(connectionId);
  }

  async renameRemote(connectionId: string, oldPath: string): Promise<void> {
    const adapter = this.adapters.get(connectionId);
    if (!adapter) {
      throw new Error('Connection is not active');
    }

    const newName = await vscode.window.showInputBox({
      prompt: 'New name:',
      value: path.basename(oldPath),
    });
    if (!newName || newName === path.basename(oldPath)) {
      return;
    }

    const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
    const newPath = `${parentPath}/${newName}`.replace(/\/+/g, '/');

    await adapter.rename(oldPath, newPath);
    logInfo(`Renamed: ${oldPath} -> ${newPath}`);
    this.treeProvider.refreshNode(connectionId);
  }

  async createRemoteFolder(connectionId: string, parentPath: string): Promise<void> {
    const adapter = this.adapters.get(connectionId);
    if (!adapter) {
      throw new Error('Connection is not active');
    }

    const folderName = await vscode.window.showInputBox({
      prompt: 'Folder name:',
      value: 'new-folder',
    });
    if (!folderName) {
      return;
    }

    const fullPath = `${parentPath}/${folderName}`.replace(/\/+/g, '/');
    await adapter.createDirectory(fullPath);
    logInfo(`Created remote folder: ${fullPath}`);
    this.treeProvider.refreshNode(connectionId);
  }

  // ---- Accessors ----

  getStates(): Map<string, ConnectionState> {
    return this.states;
  }

  getState(id: string): ConnectionState | undefined {
    return this.states.get(id);
  }

  getAdapter(id: string): IAdapter | undefined {
    return this.adapters.get(id);
  }

  getFsProvider(id: string): RemoteFileSystemProvider | undefined {
    return this.fsProviders.get(id);
  }

  // ---- Private helpers ----

  private ensureFsProvider(config: ConnectionConfig): void {
    const scheme = `remote-${config.id}`;
    if (!this.registeredSchemes.has(scheme)) {
      const fsProvider = new RemoteFileSystemProvider(
        () => this.adapters.get(config.id),
        () => this.ensureConnectionForFileSystem(config.id),
        config,
        scheme
      );
      this.fsProviders.set(config.id, fsProvider);

      const disposable = vscode.workspace.registerFileSystemProvider(scheme, fsProvider, {
        isCaseSensitive: true,
        isReadonly: false,
      });
      // Store the disposable on the fsProvider so we can dispose if needed (e.g. deletion)
      (fsProvider as any)._disposable = disposable;
      this.registeredSchemes.add(scheme);
    }
  }

  private createAdapter(protocol: string): IAdapter {
    if (protocol === 'sftp') {
      return new SftpAdapter();
    }
    return new FtpAdapter();
  }

  private updateStatus(id: string, status: ConnectionState['status'], errorMessage?: string): void {
    const state = this.states.get(id);
    if (!state) {
      return;
    }
    state.status = status;
    state.errorMessage = errorMessage;
    state.lastStatusChange = Date.now();
    this.treeProvider.refresh();
  }

  private secretKey(connectionId: string): string {
    return `${SECRET_PREFIX}${connectionId}`;
  }

  private async loadSecrets(id: string): Promise<{ password?: string; sshKeyPath?: string; sshPassphrase?: string }> {
    const raw = await getSecret(this.context, this.secretKey(id));
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async saveSecrets(id: string, secrets: ConnectionSecrets): Promise<void> {
    await storeSecret(this.context, this.secretKey(id), JSON.stringify(secrets));
  }

  private async deleteSecrets(id: string): Promise<void> {
    await deleteSecret(this.context, this.secretKey(id));
  }

  /**
   * Remove the workspace folder associated with a connection.
   */
  private removeWorkspaceFolder(connectionId: string): void {
    const wf = vscode.workspace.workspaceFolders;
    if (!wf) {
      return;
    }
    const scheme = `remote-${connectionId}`;
    for (let i = 0; i < wf.length; i++) {
      if (wf[i].uri.scheme === scheme) {
        vscode.workspace.updateWorkspaceFolders(i, 1);
        break;
      }
    }
  }
}
