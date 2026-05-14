/**
 * RemoteTreeDataProvider — powers the "Remote Explorer" sidebar tree view.
 *
 * Shows two top-level groups:
 *  1. Saved connections (with status icons)
 *  2. Remote files for each active connection
 */
import * as vscode from 'vscode';
import { ConnectionManager } from '../manager/connectionManager';
import { ConnectionState, RemoteDirectoryEntry } from '../types';
/** A union type for items that can appear in the tree. */
type TreeItem = ConnectionTreeItem | RemoteFileTreeItem | RemoteFolderTreeItem | InfoTreeItem;
/**
 * Top-level tree item representing a single connection.
 * Children are remote file entries (only when connected).
 */
declare class ConnectionTreeItem extends vscode.TreeItem {
    readonly state: ConnectionState;
    readonly collapsibleState: vscode.TreeItemCollapsibleState;
    constructor(state: ConnectionState, collapsibleState: vscode.TreeItemCollapsibleState);
}
/** Tree item representing a remote folder. */
declare class RemoteFolderTreeItem extends vscode.TreeItem {
    readonly connectionId: string;
    readonly entry: RemoteDirectoryEntry;
    readonly collapsibleState: vscode.TreeItemCollapsibleState;
    constructor(connectionId: string, entry: RemoteDirectoryEntry, collapsibleState: vscode.TreeItemCollapsibleState);
}
/** Tree item representing a remote file. */
declare class RemoteFileTreeItem extends vscode.TreeItem {
    readonly connectionId: string;
    readonly entry: RemoteDirectoryEntry;
    constructor(connectionId: string, entry: RemoteDirectoryEntry);
}
/** Placeholder item when no connections exist or a folder is empty. */
declare class InfoTreeItem extends vscode.TreeItem {
    constructor(label: string, icon?: string);
}
export declare class RemoteTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<void | TreeItem | undefined>;
    /** Cache of remote folder entries, keyed by connectionId:remotePath */
    private entryCache;
    /** In-flight directory requests, keyed by connectionId:remotePath */
    private pendingEntries;
    private readonly maxCachedDirectories;
    /** Connection manager — set after construction to break circular dependency. */
    private _connectionManager;
    /** Inject the connection manager after both objects exist. */
    setConnectionManager(cm: ConnectionManager): void;
    private get connectionManager();
    /**
     * Refresh the whole tree.
     */
    refresh(): void;
    /**
     * Refresh only the subtree for a specific connection.
     */
    refreshNode(connectionId: string): void;
    getTreeItem(element: TreeItem): vscode.TreeItem;
    getChildren(element?: TreeItem): Promise<TreeItem[]>;
    private getRemoteChildren;
    private getRemoteChildrenForPath;
    /**
     * Fetch and cache remote directory entries.
     */
    private getCachedEntries;
    private pruneEntryCache;
}
export {};
//# sourceMappingURL=treeView.d.ts.map