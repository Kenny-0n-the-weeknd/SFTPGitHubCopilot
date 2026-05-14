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
import { ConnectionConfig, ConnectionState } from '../types';
import { IAdapter } from '../adapters/interface';
import { RemoteFileSystemProvider } from '../fs/remoteFileSystemProvider';
import { RemoteTreeDataProvider } from '../ui/treeView';
export declare class ConnectionManager {
    private readonly context;
    private readonly treeProvider;
    /** Map connection id -> runtime state (config + status) */
    private states;
    /** Map connection id -> active IAdapter instance */
    private adapters;
    /** Map connection id -> active FileSystemProvider */
    private fsProviders;
    /** Registered filesystem scheme URIs per connection to enable workspace access */
    private registeredSchemes;
    /** Map connection id -> in-flight connection startup promise */
    private startPromises;
    /** Connection ids explicitly disconnected by the user; filesystem auto-start must not restart them. */
    private autoStartBlocked;
    /** Connection ids currently being stopped. */
    private stoppingConnections;
    constructor(context: vscode.ExtensionContext, treeProvider: RemoteTreeDataProvider);
    /**
     * Load all saved connections from extension storage.
     */
    loadConnections(): Promise<ConnectionConfig[]>;
    /**
     * Save all connections to extension storage.
     */
    saveConnections(): Promise<void>;
    /**
     * Create a new connection config and persist it.
     */
    addConnection(config: ConnectionConfig): Promise<void>;
    /**
     * Update an existing connection config.
     */
    updateConnection(id: string, partial: Partial<ConnectionConfig>): Promise<void>;
    /**
     * Delete a connection and all its stored data.
     */
    deleteConnection(id: string): Promise<void>;
    /**
     * Start / connect to a saved connection.
     */
    startConnection(id: string, isManualStart?: boolean): Promise<void>;
    private doStartConnection;
    /**
     * Stop / disconnect a connection.
     */
    stopConnection(id: string, isDeactivating?: boolean): Promise<void>;
    ensureConnectionForFileSystem(id: string): Promise<void>;
    /**
     * Disconnect all active connections.
     */
    disconnectAll(isDeactivating?: boolean): Promise<void>;
    /**
     * Attempt to reconnect a dropped connection.
     */
    reconnect(id: string): Promise<void>;
    /**
     * Open a remote file in a VS Code editor.
     * Uses the custom FileSystemProvider scheme so VS Code treats it like
     * a regular workspace file. This makes it available to GitHub Copilot.
     */
    openRemoteFile(connectionId: string, remotePath: string): Promise<void>;
    uploadFile(connectionId: string, remoteDir: string): Promise<void>;
    downloadFile(connectionId: string, remotePath: string): Promise<void>;
    deleteRemote(connectionId: string, remotePath: string, isDirectory: boolean): Promise<void>;
    renameRemote(connectionId: string, oldPath: string): Promise<void>;
    createRemoteFolder(connectionId: string, parentPath: string): Promise<void>;
    getStates(): Map<string, ConnectionState>;
    getState(id: string): ConnectionState | undefined;
    getAdapter(id: string): IAdapter | undefined;
    getFsProvider(id: string): RemoteFileSystemProvider | undefined;
    private ensureFsProvider;
    private createAdapter;
    private updateStatus;
    private secretKey;
    private loadSecrets;
    private saveSecrets;
    private deleteSecrets;
    /**
     * Remove the workspace folder associated with a connection.
     */
    private removeWorkspaceFolder;
}
//# sourceMappingURL=connectionManager.d.ts.map