/**
 * RemoteTreeDataProvider — powers the "Remote Explorer" sidebar tree view.
 *
 * Shows two top-level groups:
 *  1. Saved connections (with status icons)
 *  2. Remote files for each active connection
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../manager/connectionManager';
import { ConnectionState, RemoteDirectoryEntry } from '../types';
import { CONNECTIONS_VIEW_ID } from '../constants';

/** A union type for items that can appear in the tree. */
type TreeItem =
  | ConnectionTreeItem
  | RemoteFileTreeItem
  | RemoteFolderTreeItem
  | InfoTreeItem;

/**
 * Top-level tree item representing a single connection.
 * Children are remote file entries (only when connected).
 */
class ConnectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly state: ConnectionState,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(state.config.label, collapsibleState);

    this.id = `conn:${state.config.id}`;
    this.description = `${state.config.protocol.toUpperCase()} — ${state.config.host}:${state.config.port}`;
    this.tooltip = `Status: ${state.status}\nHost: ${state.config.host}:${state.config.port}\nRoot: ${state.config.remoteRoot}`;

    // Status-dependent icon and context value
    switch (state.status) {
      case 'running':
        this.iconPath = new vscode.ThemeIcon('vm-connect', new vscode.ThemeColor('charts.green'));
        this.contextValue = 'connection_running';
        break;
      case 'connecting':
        this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
        this.contextValue = 'connection_connecting';
        break;
      case 'error':
        this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        this.contextValue = 'connection_error';
        this.tooltip += `\nError: ${state.errorMessage || 'Unknown error'}`;
        break;
      case 'stopped':
      default:
        this.iconPath = new vscode.ThemeIcon('vm-outline');
        this.contextValue = 'connection_stopped';
        break;
    }
  }
}

/** Tree item representing a remote folder. */
class RemoteFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly entry: RemoteDirectoryEntry,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(entry.name, collapsibleState);
    this.id = `folder:${connectionId}:${entry.path}`;
    this.iconPath = vscode.ThemeIcon.Folder;
    this.contextValue = 'remote_folder';
    this.tooltip = `Remote path: ${entry.path}\nModified: ${new Date(entry.stat.mtime).toLocaleString()}`;
    this.resourceUri = vscode.Uri.parse(`remote-${connectionId}://${entry.path.replace(/^\/+/, '')}`);
  }
}

/** Tree item representing a remote file. */
class RemoteFileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly entry: RemoteDirectoryEntry,
  ) {
    super(entry.name);
    this.id = `file:${connectionId}:${entry.path}`;
    this.iconPath = vscode.ThemeIcon.File;
    this.contextValue = 'remote_file';
    this.tooltip = `Remote path: ${entry.path}\nSize: ${entry.stat.size} bytes\nModified: ${new Date(entry.stat.mtime).toLocaleString()}`;
    this.resourceUri = vscode.Uri.parse(`remote-${connectionId}://${entry.path.replace(/^\/+/, '')}`);

    // Clicking a file opens it in the editor
    this.command = {
      title: 'Open Remote File',
      command: 'remoteExplorer.openRemoteFile',
      arguments: [connectionId, entry.path],
    };
  }
}

/** Placeholder item when no connections exist or a folder is empty. */
class InfoTreeItem extends vscode.TreeItem {
  constructor(label: string, icon?: string) {
    super(label);
    this.contextValue = 'info';
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
  }
}

export class RemoteTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cache of remote folder entries, keyed by connectionId:remotePath */
  private entryCache = new Map<string, RemoteDirectoryEntry[]>();

  /** In-flight directory requests, keyed by connectionId:remotePath */
  private pendingEntries = new Map<string, Promise<RemoteDirectoryEntry[]>>();

  private readonly maxCachedDirectories = 50;

  /** Connection manager — set after construction to break circular dependency. */
  private _connectionManager!: ConnectionManager;

  /** Inject the connection manager after both objects exist. */
  setConnectionManager(cm: ConnectionManager): void {
    this._connectionManager = cm;
  }

  private get connectionManager(): ConnectionManager {
    if (!this._connectionManager) {
      throw new Error('ConnectionManager not yet set on RemoteTreeDataProvider');
    }
    return this._connectionManager;
  }

  /**
   * Refresh the whole tree.
   */
  refresh(): void {
    this.entryCache.clear();
    this.pendingEntries.clear();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Refresh only the subtree for a specific connection.
   */
  refreshNode(connectionId: string): void {
    // Clear cache entries for this connection
    for (const key of this.entryCache.keys()) {
      if (key.startsWith(connectionId + ':')) {
        this.entryCache.delete(key);
      }
    }
    for (const key of this.pendingEntries.keys()) {
      if (key.startsWith(connectionId + ':')) {
        this.pendingEntries.delete(key);
      }
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element) {
      // Root level: show all saved connections
      const states = this.connectionManager.getStates();
      if (states.size === 0) {
        return [new InfoTreeItem('No connections saved. Click + to add one.', 'info')];
      }

      const items: TreeItem[] = [];
      for (const [id, state] of states) {
        items.push(
          new ConnectionTreeItem(
            state,
            vscode.TreeItemCollapsibleState.Collapsed,
          ),
        );
      }
      return items;
    }

    if (element instanceof ConnectionTreeItem) {
      // Children of a connection: remote files/folders
      return this.getRemoteChildren(element.state);
    }

    if (element instanceof RemoteFolderTreeItem) {
      // Children of a remote folder
      return this.getRemoteChildrenForPath(element.connectionId, element.entry.path, element);
    }

    return [];
  }

  private async getRemoteChildren(state: ConnectionState): Promise<TreeItem[]> {
    if (state.status !== 'running') {
      const statusLabel = state.status === 'error'
        ? `Error: ${state.errorMessage || 'Connection failed'}`
        : state.status === 'connecting'
          ? 'Connecting…'
          : 'Not connected';
      return [new InfoTreeItem(statusLabel, state.status === 'error' ? 'error' : 'info')];
    }

    const adapter = this.connectionManager.getAdapter(state.config.id);
    if (!adapter) {
      return [new InfoTreeItem('No active adapter', 'warning')];
    }

    try {
      const entries = await this.getCachedEntries(state.config.id, state.config.remoteRoot || '/');
      return entries.map(entry =>
        entry.stat.type === 'directory'
          ? new RemoteFolderTreeItem(state.config.id, entry, vscode.TreeItemCollapsibleState.Collapsed)
          : new RemoteFileTreeItem(state.config.id, entry),
      );
    } catch (err: any) {
      return [new InfoTreeItem(`Failed to list directory: ${err.message}`, 'error')];
    }
  }

  private async getRemoteChildrenForPath(
    connectionId: string,
    remotePath: string,
    _parent: RemoteFolderTreeItem,
  ): Promise<TreeItem[]> {
    const adapter = this.connectionManager.getAdapter(connectionId);
    if (!adapter) {
      return [new InfoTreeItem('Adapter not available', 'warning')];
    }

    try {
      const entries = await this.getCachedEntries(connectionId, remotePath);
      if (entries.length === 0) {
        return [new InfoTreeItem('Empty folder', 'folder-opened')];
      }
      return entries.map(entry =>
        entry.stat.type === 'directory'
          ? new RemoteFolderTreeItem(connectionId, entry, vscode.TreeItemCollapsibleState.Collapsed)
          : new RemoteFileTreeItem(connectionId, entry),
      );
    } catch (err: any) {
      return [new InfoTreeItem(`Error: ${err.message}`, 'error')];
    }
  }

  /**
   * Fetch and cache remote directory entries.
   */
  private async getCachedEntries(
    connectionId: string,
    remotePath: string,
  ): Promise<RemoteDirectoryEntry[]> {
    const key = `${connectionId}:${remotePath}`;
    if (this.entryCache.has(key)) {
      return this.entryCache.get(key)!;
    }

    const pending = this.pendingEntries.get(key);
    if (pending) {
      return pending;
    }

    const adapter = this.connectionManager.getAdapter(connectionId);
    if (!adapter) {
      throw new Error('No active connection');
    }

    const pendingRequest = adapter.listDirectory(remotePath).then(entries => {
      // Sort: directories first, then files, both alphabetically
      entries.sort((a, b) => {
        if (a.stat.type !== b.stat.type) {
          return a.stat.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      this.entryCache.set(key, entries);
  this.pruneEntryCache();
      return entries;
    }).finally(() => {
      this.pendingEntries.delete(key);
    });

    this.pendingEntries.set(key, pendingRequest);
    return pendingRequest;
  }

  private pruneEntryCache(): void {
    while (this.entryCache.size > this.maxCachedDirectories) {
      const oldestKey = this.entryCache.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.entryCache.delete(oldestKey);
    }
  }
}
