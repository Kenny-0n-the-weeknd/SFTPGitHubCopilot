/**
 * FTP adapter using the "basic-ftp" library.
 */
import { IAdapter } from './interface';
import { ConnectionConfig, RemoteDirectoryEntry, RemoteFileStat } from '../types';
export declare class FtpAdapter implements IAdapter {
    private client;
    private remoteRoot;
    private lastConfig?;
    private connectionPromise;
    private operationQueue;
    private readonly directoryCache;
    private readonly directoryCacheTtlMs;
    private readonly maxCachedDirectories;
    connect(config: ConnectionConfig, secrets: {
        password?: string;
        sshKeyPath?: string;
        sshPassphrase?: string;
    }): Promise<void>;
    private _doConnect;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    listDirectory(remotePath: string): Promise<RemoteDirectoryEntry[]>;
    stat(remotePath: string): Promise<RemoteFileStat>;
    readFile(remotePath: string): Promise<Buffer>;
    writeFile(remotePath: string, data: Buffer): Promise<void>;
    createDirectory(remotePath: string): Promise<void>;
    deleteFile(remotePath: string): Promise<void>;
    deleteDirectory(remotePath: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    getCurrentDirectory(): string;
    dispose(): void;
    private getClient;
    private runExclusive;
    private isConnectionError;
    private getDirectoryEntries;
    private invalidatePath;
    private pruneDirectoryCache;
    private toAbsolute;
}
//# sourceMappingURL=ftpAdapter.d.ts.map