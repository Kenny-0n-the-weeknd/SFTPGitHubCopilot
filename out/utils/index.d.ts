/**
 * Utilities: logging, path helpers, and secret storage wrapper.
 */
import * as vscode from 'vscode';
/**
 * Write an info-level message to the Remote Explorer output channel.
 */
export declare function logInfo(message: string): void;
/**
 * Write a warning-level message to the Remote Explorer output channel.
 */
export declare function logWarn(message: string): void;
/**
 * Write an error-level message to the Remote Explorer output channel.
 */
export declare function logError(message: string): void;
/**
 * Show an error popup to the user.
 */
export declare function showError(message: string): void;
/**
 * Show a warning popup to the user.
 */
export declare function showWarning(message: string): void;
/**
 * Show an info popup to the user.
 */
export declare function showInfo(message: string): void;
/**
 * Normalise a remote path to always use forward slashes and no trailing slash
 * (except for the root '/').
 */
export declare function normaliseRemotePath(input: string): string;
/**
 * Join two remote path segments with a forward slash.
 */
export declare function joinRemotePath(base: string, ...segments: string[]): string;
/**
 * Return the parent remote directory path.
 */
export declare function dirnameRemote(path: string): string;
/**
 * Return the basename of a remote path.
 */
export declare function basenameRemote(path: string): string;
/**
 * Convert a remote stat to vscode.FileStat.
 */
import { RemoteFileStat } from '../types';
import { FileType } from 'vscode';
export declare function remoteStatToFileStat(stat: RemoteFileStat): [FileType, {
    ctime: number;
    mtime: number;
    size: number;
}];
/**
 * Safely store a secret using VS Code SecretStorage.
 */
export declare function storeSecret(context: vscode.ExtensionContext, key: string, value: string): Promise<void>;
/**
 * Retrieve a secret.
 */
export declare function getSecret(context: vscode.ExtensionContext, key: string): Promise<string | undefined>;
/**
 * Delete a secret.
 */
export declare function deleteSecret(context: vscode.ExtensionContext, key: string): Promise<void>;
/**
 * Generate a short unique ID for a new connection.
 */
export declare function generateId(): string;
/** Dispose the output channel when extension deactivates */
export declare function disposeOutputChannel(): void;
//# sourceMappingURL=index.d.ts.map