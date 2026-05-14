/**
 * Remote Explorer — VS Code Extension Entry Point
 *
 * This extension allows users to connect to remote FTP/SFTP servers
 * and browse/edit files directly within the VS Code workspace.
 *
 * Workspace integration is achieved by:
 *  - Registering a custom FileSystemProvider per connection (scheme: remote-<id>://)
 *  - Adding the remote root as a workspace folder so it appears in the Explorer
 *  - This makes remote files accessible to GitHub Copilot for reading and editing
 */
import * as vscode from 'vscode';
export declare function activate(context: vscode.ExtensionContext): void;
export declare function deactivate(): Promise<void>;
//# sourceMappingURL=extension.d.ts.map