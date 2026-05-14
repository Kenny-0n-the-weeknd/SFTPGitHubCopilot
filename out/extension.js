"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const connectionManager_1 = require("./manager/connectionManager");
const treeView_1 = require("./ui/treeView");
const connectionForm_1 = require("./ui/connectionForm");
const constants_1 = require("./constants");
const utils_1 = require("./utils");
// Globals held for the lifetime of the extension
let connectionManager;
let treeProvider;
const SECRET_PREFIX = 'remoteExplorer.secret.';
function activate(context) {
    (0, utils_1.logInfo)('Remote Explorer extension activating…');
    // 1. Create the tree data provider and register the tree view
    treeProvider = new treeView_1.RemoteTreeDataProvider();
    const treeView = vscode.window.createTreeView(constants_1.CONNECTIONS_VIEW_ID, {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);
    // 2. Create the connection manager and wire up the circular dependency
    connectionManager = new connectionManager_1.ConnectionManager(context, treeProvider);
    treeProvider.setConnectionManager(connectionManager);
    // 3. Load persisted connections
    connectionManager.loadConnections().then(async () => {
        treeProvider.refresh();
        await ensureRemoteWorkspaceEditorBehavior();
    });
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void ensureRemoteWorkspaceEditorBehavior();
    }));
    // 4. Register commands
    // Add a new connection
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.addConnection', async () => {
        try {
            (0, utils_1.logInfo)('Opening add connection form...');
            const config = await (0, connectionForm_1.showConnectionForm)(context);
            (0, utils_1.logInfo)(`Add form returned: ${config ? `config for "${config.label}"` : 'undefined (cancelled)'}`);
            if (!config) {
                return;
            }
            const secrets = config._secrets;
            delete config._secrets;
            await connectionManager.addConnection(config);
            // Store secrets
            if (secrets) {
                const secretPayload = {
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
                await (0, utils_1.storeSecret)(context, `${SECRET_PREFIX}${config.id}`, JSON.stringify(secretPayload));
            }
            treeProvider.refresh();
            (0, utils_1.showInfo)(`Connection "${config.label}" added.`);
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to add connection: ${err.message}`);
        }
    }));
    // Start / connect
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.startConnection', async (arg) => {
        try {
            const id = await resolveConnectionIdAsync(arg);
            if (!id) {
                return;
            }
            await connectionManager.startConnection(id);
            await ensureRemoteWorkspaceEditorBehavior();
            treeProvider.refresh();
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to connect: ${err.message}`);
            treeProvider.refresh();
        }
    }));
    // Stop / disconnect
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.stopConnection', async (arg) => {
        try {
            const id = await resolveConnectionIdAsync(arg);
            if (!id) {
                return;
            }
            await connectionManager.stopConnection(id);
            treeProvider.refresh();
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to disconnect: ${err.message}`);
        }
    }));
    // Edit connection
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.editConnection', async (arg) => {
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
            const raw = await (0, utils_1.getSecret)(context, `${SECRET_PREFIX}${id}`);
            let secrets = { connectionId: id };
            if (raw) {
                try {
                    secrets = JSON.parse(raw);
                }
                catch { /* ignore */ }
            }
            (0, utils_1.logInfo)(`Opening edit form for connection: ${id}`);
            const updated = await (0, connectionForm_1.showConnectionForm)(context, { ...state.config });
            (0, utils_1.logInfo)(`Edit form returned: ${updated ? `config for "${updated.label}"` : 'undefined (cancelled)'}`);
            if (!updated) {
                return;
            }
            const newSecrets = updated._secrets;
            delete updated._secrets;
            await connectionManager.updateConnection(id, updated);
            // Update secrets if new values provided
            if (newSecrets) {
                const secretPayload = { connectionId: id };
                if (updated.authMethod === 'password') {
                    if (newSecrets.password) {
                        secretPayload.password = newSecrets.password;
                    }
                    else {
                        secretPayload.password = secrets.password;
                    }
                }
                if (updated.authMethod === 'key') {
                    if (newSecrets.sshKeyPath) {
                        secretPayload.sshKeyPath = newSecrets.sshKeyPath;
                    }
                    else {
                        secretPayload.sshKeyPath = secrets.sshKeyPath;
                    }
                    if (newSecrets.sshPassphrase) {
                        secretPayload.sshPassphrase = newSecrets.sshPassphrase;
                    }
                    else {
                        secretPayload.sshPassphrase = secrets.sshPassphrase;
                    }
                }
                await (0, utils_1.storeSecret)(context, `${SECRET_PREFIX}${id}`, JSON.stringify(secretPayload));
            }
            treeProvider.refresh();
            (0, utils_1.showInfo)(`Connection "${updated.label}" updated.`);
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to edit connection: ${err.message}`);
        }
    }));
    // Delete connection
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.deleteConnection', async (arg) => {
        try {
            const id = await resolveConnectionIdAsync(arg);
            if (!id) {
                return;
            }
            const state = connectionManager.getState(id);
            const label = state?.config.label || id;
            const confirm = await vscode.window.showWarningMessage(`Delete connection "${label}"? This cannot be undone.`, { modal: true }, 'Delete');
            if (confirm !== 'Delete') {
                return;
            }
            await connectionManager.deleteConnection(id);
            await (0, utils_1.deleteSecret)(context, `${SECRET_PREFIX}${id}`);
            treeProvider.refresh();
            (0, utils_1.showInfo)(`Connection "${label}" deleted.`);
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to delete connection: ${err.message}`);
        }
    }));
    // Refresh
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.refreshConnections', () => {
        treeProvider.refresh();
    }));
    // Disconnect all
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.disconnectAll', async () => {
        try {
            await connectionManager.disconnectAll();
            treeProvider.refresh();
            (0, utils_1.showInfo)('All connections disconnected.');
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to disconnect all: ${err.message}`);
        }
    }));
    // Open remote file
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.openRemoteFile', async (connectionId, remotePath) => {
        try {
            await connectionManager.openRemoteFile(connectionId, remotePath);
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to open file: ${err.message}`);
        }
    }));
    // Upload file to remote
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.uploadFile', async (arg) => {
        try {
            const id = await resolveConnectionIdAsync(arg);
            if (!id) {
                return;
            }
            // Determine remote directory: if arg is a folder tree item, use its path
            let remoteDir;
            if (arg && typeof arg === 'object' && arg.entry && arg.entry.path) {
                remoteDir = arg.entry.path;
            }
            else {
                const state = connectionManager.getState(id);
                remoteDir = state?.config.remoteRoot || '/';
            }
            await connectionManager.uploadFile(id, remoteDir);
            treeProvider.refreshNode(id);
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to upload: ${err.message}`);
        }
    }));
    // Download file from remote
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.downloadFile', async (arg) => {
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
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to download: ${err.message}`);
        }
    }));
    // Delete remote file/folder
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.deleteRemote', async (arg) => {
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
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to delete: ${err.message}`);
        }
    }));
    // Rename remote file/folder
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.renameRemote', async (arg) => {
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
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to rename: ${err.message}`);
        }
    }));
    // Create remote folder
    context.subscriptions.push(vscode.commands.registerCommand('remoteExplorer.createRemoteFolder', async (arg) => {
        try {
            const id = await resolveConnectionIdAsync(arg);
            if (!id) {
                return;
            }
            let parentPath;
            if (arg && typeof arg === 'object' && arg.entry && arg.entry.path) {
                parentPath = arg.entry.path;
            }
            else {
                const state = connectionManager.getState(id);
                parentPath = state?.config.remoteRoot || '/';
            }
            await connectionManager.createRemoteFolder(id, parentPath);
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to create folder: ${err.message}`);
        }
    }));
    (0, utils_1.logInfo)('Remote Explorer activated successfully');
}
async function deactivate() {
    (0, utils_1.logInfo)('Remote Explorer deactivating…');
    try {
        if (connectionManager) {
            await connectionManager.disconnectAll(true);
        }
    }
    catch (err) {
        // Ignore errors during tear-down
    }
    finally {
        (0, utils_1.disposeOutputChannel)();
    }
}
// ---- Private helpers ----
/**
 * Resolve a connection ID from various command argument formats.
 * Tree item clicks pass either a string ID or an object with a connectionId property.
 */
function resolveConnectionId(arg) {
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
async function resolveConnectionIdAsync(arg) {
    const id = resolveConnectionId(arg);
    if (id) {
        return id;
    }
    return pickConnection();
}
/**
 * Extract a remote path from command arguments.
 */
function getRemotePathFromArg(arg) {
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
async function pickConnection() {
    const states = connectionManager.getStates();
    if (states.size === 0) {
        vscode.window.showWarningMessage('No connections saved. Add one first.');
        return undefined;
    }
    const items = [];
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
async function ensureRemoteWorkspaceEditorBehavior() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const hasRemoteWorkspaceFolder = folders.some(folder => folder.uri.scheme.startsWith('remote-'));
    if (!hasRemoteWorkspaceFolder) {
        return;
    }
    const remoteConfig = vscode.workspace.getConfiguration('remoteExplorer');
    if (!remoteConfig.get('pinWorkspaceEditors', true)) {
        return;
    }
    const editorConfig = vscode.workspace.getConfiguration('workbench.editor');
    try {
        if (editorConfig.get('enablePreview') !== false) {
            await editorConfig.update('enablePreview', false, vscode.ConfigurationTarget.Workspace);
        }
        if (editorConfig.get('enablePreviewFromQuickOpen') !== false) {
            await editorConfig.update('enablePreviewFromQuickOpen', false, vscode.ConfigurationTarget.Workspace);
        }
    }
    catch (err) {
        (0, utils_1.logWarn)(`Unable to disable preview editors for remote workspace files: ${err.message}`);
    }
}
//# sourceMappingURL=extension.js.map