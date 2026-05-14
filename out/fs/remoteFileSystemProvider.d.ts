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
import { ConnectionConfig } from '../types';
export declare class RemoteFileSystemProvider implements vscode.FileSystemProvider {
    private readonly getAdapter;
    private readonly ensureConnected;
    private readonly config;
    private readonly scheme;
    /** Emitter for file change events */
    private _emitter;
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
    private readonly operationQueues;
    private readonly directoryCache;
    private readonly statCache;
    private readonly cacheTtlMs;
    private readonly maxCachedDirectories;
    private readonly maxCachedStats;
    constructor(getAdapter: () => IAdapter | undefined, ensureConnected: () => Promise<void>, config: ConnectionConfig, scheme: string);
    private getAdapterForOperation;
    /**
     * Convert a remote-connection URI to the adapter's absolute remote path.
     */
    private toRemotePath;
    watch(): vscode.Disposable;
    stat(uri: vscode.Uri): Promise<vscode.FileStat>;
    readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]>;
    createDirectory(uri: vscode.Uri): Promise<void>;
    readFile(uri: vscode.Uri): Promise<Uint8Array>;
    writeFile(uri: vscode.Uri, content: Uint8Array, options: {
        readonly create: boolean;
        readonly overwrite: boolean;
    }): Promise<void>;
    delete(uri: vscode.Uri, options: {
        readonly recursive: boolean;
    }): Promise<void>;
    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: {
        readonly overwrite: boolean;
    }): Promise<void>;
    copy(): Promise<void>;
    private exists;
    private getCachedDirectory;
    private getCachedStat;
    private invalidateCaches;
    private pruneCaches;
    private runQueued;
    private toFileSystemError;
}
//# sourceMappingURL=remoteFileSystemProvider.d.ts.map