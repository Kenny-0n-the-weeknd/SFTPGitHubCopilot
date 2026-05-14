/**
 * ConnectionSetupWebview — shows an HTML form for adding or editing
 * a remote connection (FTP/SFTP).
 *
 * We use a VS Code webview panel to present a user-friendly form
 * rather than chaining multiple InputBox dialogs.
 */
import * as vscode from 'vscode';
import { ConnectionConfig } from '../types';
/**
 * Show the connection form webview.
 *
 * @param context Extension context for URI resolution.
 * @param existing If provided, the form will be pre-filled for editing.
 * @returns The filled-out ConnectionConfig, or undefined if cancelled.
 */
export declare function showConnectionForm(context: vscode.ExtensionContext, existing?: ConnectionConfig): Promise<ConnectionConfig | undefined>;
//# sourceMappingURL=connectionForm.d.ts.map