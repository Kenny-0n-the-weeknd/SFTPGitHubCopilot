"use strict";
/**
 * ConnectionManager: the central orchestrator for all remote connections.
 *
 * Responsibilities:
 * - Persist connection configs to workspace/global storage
 * - Store/retrieve secrets (passwords, SSH keys) via VS Code SecretStorage
 * - Create and dispose FTP/SFTP adapters
 * - Track per-connection state (status, error, etc.)
 * - Expose the currently active FileSystemProvider for a connection
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
exports.ConnectionManager = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const ftpAdapter_1 = require("../adapters/ftpAdapter");
const sftpAdapter_1 = require("../adapters/sftpAdapter");
const remoteFileSystemProvider_1 = require("../fs/remoteFileSystemProvider");
const utils_1 = require("../utils");
const CONNECTIONS_STORAGE_KEY = 'remoteExplorer.connections';
const SECRET_PREFIX = 'remoteExplorer.secret.';
class ConnectionManager {
    context;
    treeProvider;
    /** Map connection id -> runtime state (config + status) */
    states = new Map();
    /** Map connection id -> active IAdapter instance */
    adapters = new Map();
    /** Map connection id -> active FileSystemProvider */
    fsProviders = new Map();
    /** Registered filesystem scheme URIs per connection to enable workspace access */
    registeredSchemes = new Set();
    /** Map connection id -> in-flight connection startup promise */
    startPromises = new Map();
    /** Connection ids explicitly disconnected by the user; filesystem auto-start must not restart them. */
    autoStartBlocked = new Set();
    /** Connection ids currently being stopped. */
    stoppingConnections = new Set();
    constructor(context, treeProvider) {
        this.context = context;
        this.treeProvider = treeProvider;
    }
    // ---- Persistence ----
    /**
     * Load all saved connections from extension storage.
     */
    async loadConnections() {
        const raw = this.context.globalState.get(CONNECTIONS_STORAGE_KEY, []);
        const configs = Array.isArray(raw) ? raw : [];
        // Populate runtime state map
        for (const config of configs) {
            // Sanitize any host that was accidentally saved with a URL scheme
            config.host = config.host.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, '').split('/')[0];
            config.remoteRoot = (0, utils_1.absoluteRemotePath)(config.remoteRoot || '/');
            this.states.set(config.id, {
                config,
                status: 'stopped',
                lastStatusChange: Date.now(),
            });
            this.ensureFsProvider(config);
        }
        (0, utils_1.logInfo)(`Loaded ${configs.length} saved connection(s)`);
        return configs;
    }
    /**
     * Save all connections to extension storage.
     */
    async saveConnections() {
        const configs = [];
        for (const state of this.states.values()) {
            configs.push(state.config);
        }
        await this.context.globalState.update(CONNECTIONS_STORAGE_KEY, configs);
        (0, utils_1.logInfo)(`Saved ${configs.length} connection(s)`);
    }
    // ---- CRUD ----
    /**
     * Create a new connection config and persist it.
     */
    async addConnection(config) {
        config.id = config.id || (0, utils_1.generateId)();
        // Strip any URL scheme the user may have typed into the host field
        config.host = config.host.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, '').split('/')[0];
        config.remoteRoot = (0, utils_1.absoluteRemotePath)(config.remoteRoot || '/');
        this.states.set(config.id, {
            config,
            status: 'stopped',
            lastStatusChange: Date.now(),
        });
        this.ensureFsProvider(config);
        await this.saveConnections();
    }
    /**
     * Update an existing connection config.
     */
    async updateConnection(id, partial) {
        const state = this.states.get(id);
        if (!state) {
            throw new Error(`Connection not found: ${id}`);
        }
        // Sanitize host in case it contains a URL scheme
        if (partial.host) {
            partial.host = partial.host.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, '').split('/')[0];
        }
        if (partial.remoteRoot) {
            partial.remoteRoot = (0, utils_1.absoluteRemotePath)(partial.remoteRoot);
        }
        Object.assign(state.config, partial);
        await this.saveConnections();
        (0, utils_1.logInfo)(`Updated connection: ${state.config.label} (host: ${state.config.host})`);
    }
    /**
     * Delete a connection and all its stored data.
     */
    async deleteConnection(id) {
        // Disconnect if currently running
        if (this.adapters.has(id)) {
            await this.stopConnection(id); // removes workspace folder
        }
        // Dispose FileSystemProvider since the connection is permanently deleted
        const fsProvider = this.fsProviders.get(id);
        if (fsProvider) {
            const disposable = fsProvider._disposable;
            if (disposable) {
                disposable.dispose();
            }
            this.fsProviders.delete(id);
            this.registeredSchemes.delete(`remote-${id}`);
        }
        this.states.delete(id);
        await this.deleteSecrets(id);
        await this.saveConnections();
    }
    // ---- Connection lifecycle ----
    /**
     * Start / connect to a saved connection.
     */
    async startConnection(id, isManualStart = true) {
        const state = this.states.get(id);
        if (!state) {
            throw new Error(`Connection not found: ${id}`);
        }
        if (isManualStart) {
            this.autoStartBlocked.delete(id);
        }
        else if (this.autoStartBlocked.has(id) || this.stoppingConnections.has(id)) {
            throw new Error(`Connection ${state.config.label} is disconnected`);
        }
        const activeAdapter = this.adapters.get(id);
        if (state.status === 'running' && activeAdapter?.isConnected()) {
            return;
        }
        const existingStart = this.startPromises.get(id);
        if (existingStart) {
            return existingStart;
        }
        const startPromise = this.doStartConnection(id, state);
        this.startPromises.set(id, startPromise);
        try {
            await startPromise;
        }
        finally {
            this.startPromises.delete(id);
        }
    }
    async doStartConnection(id, state) {
        const existingAdapter = this.adapters.get(id);
        if (existingAdapter?.isConnected()) {
            this.updateStatus(id, 'running');
            return;
        }
        if (existingAdapter) {
            try {
                await existingAdapter.disconnect();
            }
            catch {
                // Ignore cleanup errors from a stale socket.
            }
            existingAdapter.dispose();
            this.adapters.delete(id);
        }
        this.updateStatus(id, 'connecting');
        try {
            const secrets = await this.loadSecrets(id);
            const adapter = this.createAdapter(state.config.protocol);
            await adapter.connect(state.config, secrets);
            if (this.autoStartBlocked.has(id) || this.stoppingConnections.has(id)) {
                await adapter.disconnect().catch(() => undefined);
                adapter.dispose();
                this.updateStatus(id, 'stopped');
                return;
            }
            this.adapters.set(id, adapter);
            this.ensureFsProvider(state.config);
            // Add the remote root as a workspace folder so it appears in the Explorer sidebar
            // and becomes available to Copilot. If it already exists, this does nothing.
            const scheme = `remote-${id}`;
            const remoteRootUri = (0, utils_1.remoteUriForPath)(scheme, state.config.remoteRoot);
            const wf = vscode.workspace.workspaceFolders;
            const exists = wf?.some(f => f.uri.scheme === scheme);
            if (!exists) {
                vscode.workspace.updateWorkspaceFolders(wf?.length ?? 0, 0, { uri: remoteRootUri, name: `${state.config.label} (${state.config.protocol.toUpperCase()})` });
            }
            this.updateStatus(id, 'running');
            (0, utils_1.logInfo)(`Connected: ${state.config.label} (${state.config.protocol}://${state.config.host})`);
        }
        catch (err) {
            if (this.autoStartBlocked.has(id) || this.stoppingConnections.has(id)) {
                this.updateStatus(id, 'stopped');
                return;
            }
            this.updateStatus(id, 'error', err.message);
            throw err;
        }
    }
    /**
     * Stop / disconnect a connection.
     */
    async stopConnection(id, isDeactivating = false) {
        const state = this.states.get(id);
        if (!state) {
            return;
        }
        if (!isDeactivating) {
            this.autoStartBlocked.add(id);
        }
        this.stoppingConnections.add(id);
        this.updateStatus(id, 'stopped');
        try {
            // Dispose the adapter
            const adapter = this.adapters.get(id);
            if (adapter) {
                try {
                    await adapter.disconnect();
                }
                catch {
                    // Swallow disconnect errors
                }
                adapter.dispose();
                this.adapters.delete(id);
            }
            // We no longer dispose the FileSystemProvider, because it acts as a permanent 
            // bridge that throws "Unavailable" if the adapter is offline, avoiding workspace errors.
            // Remove workspace folder only if the user explicitly clicked Disconnect,
            // NOT when VS Code is shutting down (so their remote folders stay in their workspace layout for next time).
            if (!isDeactivating) {
                this.removeWorkspaceFolder(id);
            }
            (0, utils_1.logInfo)(`Disconnected: ${state.config.label}`);
        }
        finally {
            this.stoppingConnections.delete(id);
        }
    }
    async ensureConnectionForFileSystem(id) {
        const state = this.states.get(id);
        if (!state) {
            throw new Error(`Connection not found: ${id}`);
        }
        if (this.autoStartBlocked.has(id) || this.stoppingConnections.has(id)) {
            throw new Error(`Connection ${state.config.label} is disconnected`);
        }
        await this.startConnection(id, false);
    }
    /**
     * Disconnect all active connections.
     */
    async disconnectAll(isDeactivating = false) {
        const ids = Array.from(this.states.keys());
        for (const id of ids) {
            await this.stopConnection(id, isDeactivating);
        }
    }
    /**
     * Attempt to reconnect a dropped connection.
     */
    async reconnect(id) {
        const state = this.states.get(id);
        if (!state) {
            return;
        }
        if (state.status === 'error') {
            await this.stopConnection(id);
            await this.startConnection(id, false);
        }
    }
    // ---- File operations (delegated to active adapter) ----
    /**
     * Open a remote file in a VS Code editor.
     * Uses the custom FileSystemProvider scheme so VS Code treats it like
     * a regular workspace file. This makes it available to GitHub Copilot.
     */
    async openRemoteFile(connectionId, remotePath) {
        const state = this.states.get(connectionId);
        if (!state) {
            throw new Error(`Connection ${connectionId} not found`);
        }
        if (state.status !== 'running') {
            await this.startConnection(connectionId, false);
        }
        const scheme = `remote-${connectionId}`;
        const uri = (0, utils_1.remoteUriForPath)(scheme, remotePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
    }
    async uploadFile(connectionId, remoteDir) {
        const adapter = this.adapters.get(connectionId);
        if (!adapter) {
            throw new Error('Connection is not active');
        }
        const files = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Upload',
            title: 'Select files to upload',
        });
        if (!files || files.length === 0) {
            return;
        }
        for (const fileUri of files) {
            const localPath = fileUri.fsPath;
            const fileName = path.basename(localPath);
            const remotePath = `${remoteDir}/${fileName}`.replace(/\/+/g, '/');
            const data = await vscode.workspace.fs.readFile(fileUri);
            await adapter.writeFile(remotePath, Buffer.from(data));
            (0, utils_1.logInfo)(`Uploaded: ${localPath} -> ${remotePath}`);
        }
        vscode.window.showInformationMessage(`Uploaded ${files.length} file(s)`);
        this.treeProvider.refreshNode(connectionId);
    }
    async downloadFile(connectionId, remotePath) {
        const adapter = this.adapters.get(connectionId);
        if (!adapter) {
            throw new Error('Connection is not active');
        }
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.basename(remotePath)),
            saveLabel: 'Download',
            title: 'Save remote file as',
        });
        if (!saveUri) {
            return;
        }
        const data = await adapter.readFile(remotePath);
        await vscode.workspace.fs.writeFile(saveUri, data);
        vscode.window.showInformationMessage(`Downloaded: ${path.basename(remotePath)}`);
    }
    async deleteRemote(connectionId, remotePath, isDirectory) {
        const adapter = this.adapters.get(connectionId);
        if (!adapter) {
            throw new Error('Connection is not active');
        }
        const confirm = await vscode.window.showWarningMessage(`Delete ${isDirectory ? 'directory' : 'file'} "${path.basename(remotePath)}" from remote server?`, { modal: true }, 'Delete');
        if (confirm !== 'Delete') {
            return;
        }
        if (isDirectory) {
            await adapter.deleteDirectory(remotePath);
        }
        else {
            await adapter.deleteFile(remotePath);
        }
        (0, utils_1.logInfo)(`Deleted remote: ${remotePath}`);
        this.treeProvider.refreshNode(connectionId);
    }
    async renameRemote(connectionId, oldPath) {
        const adapter = this.adapters.get(connectionId);
        if (!adapter) {
            throw new Error('Connection is not active');
        }
        const newName = await vscode.window.showInputBox({
            prompt: 'New name:',
            value: path.basename(oldPath),
        });
        if (!newName || newName === path.basename(oldPath)) {
            return;
        }
        const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
        const newPath = `${parentPath}/${newName}`.replace(/\/+/g, '/');
        await adapter.rename(oldPath, newPath);
        (0, utils_1.logInfo)(`Renamed: ${oldPath} -> ${newPath}`);
        this.treeProvider.refreshNode(connectionId);
    }
    async createRemoteFolder(connectionId, parentPath) {
        const adapter = this.adapters.get(connectionId);
        if (!adapter) {
            throw new Error('Connection is not active');
        }
        const folderName = await vscode.window.showInputBox({
            prompt: 'Folder name:',
            value: 'new-folder',
        });
        if (!folderName) {
            return;
        }
        const fullPath = `${parentPath}/${folderName}`.replace(/\/+/g, '/');
        await adapter.createDirectory(fullPath);
        (0, utils_1.logInfo)(`Created remote folder: ${fullPath}`);
        this.treeProvider.refreshNode(connectionId);
    }
    // ---- Accessors ----
    getStates() {
        return this.states;
    }
    getState(id) {
        return this.states.get(id);
    }
    getAdapter(id) {
        return this.adapters.get(id);
    }
    getFsProvider(id) {
        return this.fsProviders.get(id);
    }
    // ---- Private helpers ----
    ensureFsProvider(config) {
        const scheme = `remote-${config.id}`;
        if (!this.registeredSchemes.has(scheme)) {
            const fsProvider = new remoteFileSystemProvider_1.RemoteFileSystemProvider(() => this.adapters.get(config.id), () => this.ensureConnectionForFileSystem(config.id), config, scheme);
            this.fsProviders.set(config.id, fsProvider);
            const disposable = vscode.workspace.registerFileSystemProvider(scheme, fsProvider, {
                isCaseSensitive: true,
                isReadonly: false,
            });
            // Store the disposable on the fsProvider so we can dispose if needed (e.g. deletion)
            fsProvider._disposable = disposable;
            this.registeredSchemes.add(scheme);
        }
    }
    createAdapter(protocol) {
        if (protocol === 'sftp') {
            return new sftpAdapter_1.SftpAdapter();
        }
        return new ftpAdapter_1.FtpAdapter();
    }
    updateStatus(id, status, errorMessage) {
        const state = this.states.get(id);
        if (!state) {
            return;
        }
        state.status = status;
        state.errorMessage = errorMessage;
        state.lastStatusChange = Date.now();
        this.treeProvider.refresh();
    }
    secretKey(connectionId) {
        return `${SECRET_PREFIX}${connectionId}`;
    }
    async loadSecrets(id) {
        const raw = await (0, utils_1.getSecret)(this.context, this.secretKey(id));
        if (!raw) {
            return {};
        }
        try {
            return JSON.parse(raw);
        }
        catch {
            return {};
        }
    }
    async saveSecrets(id, secrets) {
        await (0, utils_1.storeSecret)(this.context, this.secretKey(id), JSON.stringify(secrets));
    }
    async deleteSecrets(id) {
        await (0, utils_1.deleteSecret)(this.context, this.secretKey(id));
    }
    /**
     * Remove the workspace folder associated with a connection.
     */
    removeWorkspaceFolder(connectionId) {
        const wf = vscode.workspace.workspaceFolders;
        if (!wf) {
            return;
        }
        const scheme = `remote-${connectionId}`;
        for (let i = 0; i < wf.length; i++) {
            if (wf[i].uri.scheme === scheme) {
                vscode.workspace.updateWorkspaceFolders(i, 1);
                break;
            }
        }
    }
}
exports.ConnectionManager = ConnectionManager;
//# sourceMappingURL=connectionManager.js.map