/**
 * Core type definitions for the Remote Explorer extension.
 */
/** Supported remote protocols */
export type Protocol = 'ftp' | 'sftp';
/** Authentication method */
export type AuthMethod = 'password' | 'key';
/** Connection status */
export type ConnectionStatus = 'stopped' | 'connecting' | 'running' | 'error';
/**
 * Full configuration for a single remote connection.
 * Stored securely via VS Code's SecretStorage and a settings JSON file.
 */
export interface ConnectionConfig {
    /** Unique identifier for this connection */
    id: string;
    /** Human-readable label shown in the tree view */
    label: string;
    /** Protocol: 'ftp' or 'sftp' */
    protocol: Protocol;
    /** Remote server hostname or IP */
    host: string;
    /** Remote server port (21 for FTP, 22 for SFTP) */
    port: number;
    /** Authentication username */
    username: string;
    /** Authentication method */
    authMethod: AuthMethod;
    /** Remote root directory to browse from (e.g. /home/user) */
    remoteRoot: string;
    /** Optional local cache folder path */
    localCachePath?: string;
    /** Connection timeout in milliseconds */
    timeout: number;
    /** Use passive mode (FTP only) */
    passiveMode: boolean;
    /** Use explicit TLS (FTP only) */
    useTls: boolean;
    /** Additional custom settings map */
    customSettings?: Record<string, string>;
}
/**
 * Runtime connection state (not persisted — maintained in memory).
 */
export interface ConnectionState {
    config: ConnectionConfig;
    status: ConnectionStatus;
    /** Error message from last connect attempt, if any */
    errorMessage?: string;
    /** Timestamp of last status change */
    lastStatusChange: number;
}
/**
 * Secrets stored separately via SecretStorage.
 * Only the password or SSH key path/passphrase are stored as secrets.
 */
export interface ConnectionSecrets {
    connectionId: string;
    /** Password when authMethod === 'password' */
    password?: string;
    /** Path to SSH private key when authMethod === 'key' */
    sshKeyPath?: string;
    /** Passphrase for SSH key, if required */
    sshPassphrase?: string;
}
/**
 * Minimal stat result for a remote file system entry.
 * Mirrors vscode.FileStat with remote-friendly fields.
 */
export interface RemoteFileStat {
    type: 'file' | 'directory' | 'symlink';
    ctime: number;
    mtime: number;
    size: number;
    /** Original permissions string (e.g. '-rw-r--r--') */
    permissions?: string;
}
/**
 * A single entry in a remote directory listing.
 */
export interface RemoteDirectoryEntry {
    name: string;
    /** Full remote path */
    path: string;
    stat: RemoteFileStat;
}
//# sourceMappingURL=index.d.ts.map