/**
 * SFTP adapter using the "ssh2" library.
 */
import { IAdapter } from './interface';
import { ConnectionConfig, RemoteDirectoryEntry, RemoteFileStat } from '../types';
export declare class SftpAdapter implements IAdapter {
    private session;
    private remoteRoot;
    private lastConfig?;
    private connectionPromise;
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
    private getSession;
    private toAbsolute;
    private isDirectory;
    private isSymlink;
    private formatPermissions;
    private recursiveDelete;
}
//# sourceMappingURL=sftpAdapter.d.ts.map