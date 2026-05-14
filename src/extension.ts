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
import { ConnectionManager } from './manager/connectionManager';
import { RemoteTreeDataProvider } from './ui/treeView';
import { showConnectionForm } from './ui/connectionForm';
import { CONNECTIONS_VIEW_ID } from './constants';
import { ConnectionConfig, ConnectionSecrets } from './types';
import {
  logInfo,
  logWarn,
  showError,
  showInfo,
  storeSecret,
  getSecret,
  deleteSecret,
  disposeOutputChannel,
} from './utils';

// Globals held for the lifetime of the extension
let connectionManager: ConnectionManager;
let treeProvider: RemoteTreeDataProvider;

const SECRET_PREFIX = 'remoteExplorer.secret.';

export function activate(context: vscode.ExtensionContext): void {
  logInfo('Remote Explorer extension activating…');

  // 1. Create the tree data provider and register the tree view
  treeProvider = new RemoteTreeDataProvider();
  const treeView = vscode.window.createTreeView(CONNECTIONS_VIEW_ID, {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // 2. Create the connection manager and wire up the circular dependency
  connectionManager = new ConnectionManager(context, treeProvider);
  treeProvider.setConnectionManager(connectionManager);

  // 3. Load persisted connections
  connectionManager.loadConnections().then(async () => {
    treeProvider.refresh();
    await ensureRemoteWorkspaceEditorBehavior();
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void ensureRemoteWorkspaceEditorBehavior();
    }),
  );

  // 4. Register commands

  // Add a new connection
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.addConnection', async () => {
      try {
        logInfo('Opening add connection form...');
        const config = await showConnectionForm(context);
        logInfo(`Add form returned: ${config ? `config for "${config.label}"` : 'undefined (cancelled)'}`);
        if (!config) {
          return;
        }

        const secrets: any = (config as any)._secrets;
        delete (config as any)._secrets;

        await connectionManager.addConnection(config);

        // Store secrets
        if (secrets) {
          const secretPayload: ConnectionSecrets = {
            connectionId: config.id,
          };
          if (config.authMethod === 'password' && secrets.password) {
            secretPayload.password = secrets.password;
          }
          if (config.authMethod === 'key') {
            if (secrets.sshKeyPath) {
              secretPayload.sshKeyPath = secrets.sshKeyPath;
            }
            if (secrets.sshPassphrase) {
              secretPayload.sshPassphrase = secrets.sshPassphrase;
            }
          }
          await storeSecret(context, `${SECRET_PREFIX}${config.id}`, JSON.stringify(secretPayload));
        }

        treeProvider.refresh();
        showInfo(`Connection "${config.label}" added.`);
      } catch (err: any) {
        showError(`Failed to add connection: ${err.message}`);
      }
    }),
  );

  // Start / connect
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.startConnection', async (arg?: any) => {
      try {
        const id = await resolveConnectionIdAsync(arg);
        if (!id) {
          return;
        }
        await connectionManager.startConnection(id);
        await ensureRemoteWorkspaceEditorBehavior();
        treeProvider.refresh();
      } catch (err: any) {
        showError(`Failed to connect: ${err.message}`);
        treeProvider.refresh();
      }
    }),
  );

  // Stop / disconnect
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.stopConnection', async (arg?: any) => {
      try {
        const id = await resolveConnectionIdAsync(arg);
        if (!id) {
          return;
        }
        await connectionManager.stopConnection(id);
        treeProvider.refresh();
      } catch (err: any) {
        showError(`Failed to disconnect: ${err.message}`);
      }
    }),
  );

  // Edit connection
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.editConnection', async (arg?: any) => {
      try {
        const id = await resolveConnectionIdAsync(arg);
        if (!id) {
          return;
        }

        const state = connectionManager.getState(id);
        if (!state) {
          throw new Error('Connection not found');
        }

        // Load existing secrets for pre-filling
        const raw = await getSecret(context, `${SECRET_PREFIX}${id}`);
        let secrets: ConnectionSecrets = { connectionId: id };
        if (raw) {
          try {
            secrets = JSON.parse(raw);
          } catch { /* ignore */ }
        }

        logInfo(`Opening edit form for connection: ${id}`);
        const updated = await showConnectionForm(context, { ...state.config });
        logInfo(`Edit form returned: ${updated ? `config for "${updated.label}"` : 'undefined (cancelled)'}`);
        if (!updated) {
          return;
        }

        const newSecrets: any = (updated as any)._secrets;
        delete (updated as any)._secrets;

        await connectionManager.updateConnection(id, updated);

        // Update secrets if new values provided
        if (newSecrets) {
          const secretPayload: ConnectionSecrets = { connectionId: id };
          if (updated.authMethod === 'password') {
            if (newSecrets.password) {
              secretPayload.password = newSecrets.password;
            } else {
              secretPayload.password = secrets.password;
            }
          }
          if (updated.authMethod === 'key') {
            if (newSecrets.sshKeyPath) {
              secretPayload.sshKeyPath = newSecrets.sshKeyPath;
            } else {
              secretPayload.sshKeyPath = secrets.sshKeyPath;
            }
            if (newSecrets.sshPassphrase) {
              secretPayload.sshPassphrase = newSecrets.sshPassphrase;
            } else {
              secretPayload.sshPassphrase = secrets.sshPassphrase;
            }
          }
          await storeSecret(context, `${SECRET_PREFIX}${id}`, JSON.stringify(secretPayload));
        }

        treeProvider.refresh();
        showInfo(`Connection "${updated.label}" updated.`);
      } catch (err: any) {
        showError(`Failed to edit connection: ${err.message}`);
      }
    }),
  );

  // Delete connection
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.deleteConnection', async (arg?: any) => {
      try {
        const id = await resolveConnectionIdAsync(arg);
        if (!id) {
          return;
        }

        const state = connectionManager.getState(id);
        const label = state?.config.label || id;

        const confirm = await vscode.window.showWarningMessage(
          `Delete connection "${label}"? This cannot be undone.`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') {
          return;
        }

        await connectionManager.deleteConnection(id);
        await deleteSecret(context, `${SECRET_PREFIX}${id}`);
        treeProvider.refresh();
        showInfo(`Connection "${label}" deleted.`);
      } catch (err: any) {
        showError(`Failed to delete connection: ${err.message}`);
      }
    }),
  );

  // Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.refreshConnections', () => {
      treeProvider.refresh();
    }),
  );

  // Disconnect all
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.disconnectAll', async () => {
      try {
        await connectionManager.disconnectAll();
        treeProvider.refresh();
        showInfo('All connections disconnected.');
      } catch (err: any) {
        showError(`Failed to disconnect all: ${err.message}`);
      }
    }),
  );

  // Open remote file
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.openRemoteFile', async (connectionId: string, remotePath: string) => {
      try {
        await connectionManager.openRemoteFile(connectionId, remotePath);
      } catch (err: any) {
        showError(`Failed to open file: ${err.message}`);
      }
    }),
  );

  // Upload file to remote
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.uploadFile', async (arg?: any) => {
      try {
        const id = await resolveConnectionIdAsync(arg);
        if (!id) {
          return;
        }

        // Determine remote directory: if arg is a folder tree item, use its path
        let remoteDir: string;
        if (arg && typeof arg === 'object' && arg.entry && arg.entry.path) {
          remoteDir = arg.entry.path;
        } else {
          const state = connectionManager.getState(id);
          remoteDir = state?.config.remoteRoot || '/';
        }

        await connectionManager.uploadFile(id, remoteDir);
        treeProvider.refreshNode(id);
      } catch (err: any) {
        showError(`Failed to upload: ${err.message}`);
      }
    }),
  );

  // Download file from remote
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.downloadFile', async (arg?: any) => {
      try {
        const id = await resolveConnectionIdAsync(arg);
        if (!id) {
          return;
        }
        const remotePath = getRemotePathFromArg(arg);
        if (!remotePath) {
          return;
        }
        await connectionManager.downloadFile(id, remotePath);
      } catch (err: any) {
        showError(`Failed to download: ${err.message}`);
      }
    }),
  );

  // Delete remote file/folder
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.deleteRemote', async (arg?: any) => {
      try {
        const id = await resolveConnectionIdAsync(arg);
        if (!id) {
          return;
        }
        const remotePath = getRemotePathFromArg(arg);
        if (!remotePath) {
          return;
        }

        let isDirectory = false;
        if (arg && typeof arg === 'object') {
          if (arg.contextValue === 'remote_folder' || (arg.entry && arg.entry.stat && arg.entry.stat.type === 'directory')) {
            isDirectory = true;
          }
        }

        await connectionManager.deleteRemote(id, remotePath, isDirectory);
      } catch (err: any) {
        showError(`Failed to delete: ${err.message}`);
      }
    }),
  );

  // Rename remote file/folder
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.renameRemote', async (arg?: any) => {
      try {
        const id = await resolveConnectionIdAsync(arg);
        if (!id) {
          return;
        }
        const remotePath = getRemotePathFromArg(arg);
        if (!remotePath) {
          return;
        }
        await connectionManager.renameRemote(id, remotePath);
      } catch (err: any) {
        showError(`Failed to rename: ${err.message}`);
      }
    }),
  );

  // Create remote folder
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteExplorer.createRemoteFolder', async (arg?: any) => {
      try {
        const id = await resolveConnectionIdAsync(arg);
        if (!id) {
          return;
        }

        let parentPath: string;
        if (arg && typeof arg === 'object' && arg.entry && arg.entry.path) {
          parentPath = arg.entry.path;
        } else {
          const state = connectionManager.getState(id);
          parentPath = state?.config.remoteRoot || '/';
        }

        await connectionManager.createRemoteFolder(id, parentPath);
      } catch (err: any) {
        showError(`Failed to create folder: ${err.message}`);
      }
    }),
  );

  logInfo('Remote Explorer activated successfully');
}

export async function deactivate(): Promise<void> {
  logInfo('Remote Explorer deactivating…');
  try {
    if (connectionManager) {
      await connectionManager.disconnectAll(true);
    }
  } catch (err) {
    // Ignore errors during tear-down
  } finally {
    disposeOutputChannel();
  }
}

// ---- Private helpers ----

/**
 * Resolve a connection ID from various command argument formats.
 * Tree item clicks pass either a string ID or an object with a connectionId property.
 */
function resolveConnectionId(arg?: any): string | undefined {
  if (!arg) {
    return undefined;
  }
  if (typeof arg === 'string') {
    return arg;
  }
  // Tree item from context menu
  if (arg.connectionId) {
    return arg.connectionId;
  }
  // ConnectionTreeItem-like shape
  if (arg.state && arg.state.config && arg.state.config.id) {
    return arg.state.config.id;
  }
  return undefined;
}

/**
 * Resolve a connection ID, falling back to a quick-pick if no arg provided.
 */
async function resolveConnectionIdAsync(arg?: any): Promise<string | undefined> {
  const id = resolveConnectionId(arg);
  if (id) { return id; }
  return pickConnection();
}

/**
 * Extract a remote path from command arguments.
 */
function getRemotePathFromArg(arg?: any): string | undefined {
  if (!arg) {
    return undefined;
  }
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg.entry && arg.entry.path) {
    return arg.entry.path;
  }
  if (arg.path) {
    return arg.path;
  }
  return undefined;
}

/**
 * Show a quick-pick to let the user choose a connection.
 */
async function pickConnection(): Promise<string | undefined> {
  const states = connectionManager.getStates();
  if (states.size === 0) {
    vscode.window.showWarningMessage('No connections saved. Add one first.');
    return undefined;
  }

  const items: vscode.QuickPickItem[] = [];
  for (const [id, state] of states) {
    items.push({
      label: state.config.label,
      description: `(${state.config.protocol.toUpperCase()}) ${state.config.host}:${state.config.port}`,
      detail: `Status: ${state.status}`,
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a connection',
  });
  if (!pick) {
    return undefined;
  }

  // Map back to the ID by matching label
  for (const [id, state] of states) {
    if (state.config.label === pick.label) {
      return id;
    }
  }
  return undefined;
}

async function ensureRemoteWorkspaceEditorBehavior(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const hasRemoteWorkspaceFolder = folders.some(folder => folder.uri.scheme.startsWith('remote-'));
  if (!hasRemoteWorkspaceFolder) {
    return;
  }

  const remoteConfig = vscode.workspace.getConfiguration('remoteExplorer');
  if (!remoteConfig.get<boolean>('pinWorkspaceEditors', true)) {
    return;
  }

  const editorConfig = vscode.workspace.getConfiguration('workbench.editor');
  try {
    if (editorConfig.get<boolean>('enablePreview') !== false) {
      await editorConfig.update('enablePreview', false, vscode.ConfigurationTarget.Workspace);
    }
    if (editorConfig.get<boolean>('enablePreviewFromQuickOpen') !== false) {
      await editorConfig.update('enablePreviewFromQuickOpen', false, vscode.ConfigurationTarget.Workspace);
    }
  } catch (err: any) {
    logWarn(`Unable to disable preview editors for remote workspace files: ${err.message}`);
  }
}
