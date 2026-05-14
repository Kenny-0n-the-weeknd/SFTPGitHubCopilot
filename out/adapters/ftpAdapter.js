"use strict";
/**
 * FTP adapter using the "basic-ftp" library.
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
exports.FtpAdapter = void 0;
const ftp = __importStar(require("basic-ftp"));
const stream_1 = require("stream");
const utils_1 = require("../utils");
class FtpAdapter {
    client = null;
    remoteRoot = '/';
    lastConfig;
    connectionPromise = null;
    operationQueue = Promise.resolve();
    directoryCache = new Map();
    directoryCacheTtlMs = 15000;
    maxCachedDirectories = 50;
    async connect(config, secrets) {
        this.lastConfig = { config, secrets };
        if (this.connectionPromise) {
            return this.connectionPromise;
        }
        this.connectionPromise = this._doConnect(config, secrets);
        try {
            await this.connectionPromise;
        }
        finally {
            this.connectionPromise = null;
        }
    }
    async _doConnect(config, secrets) {
        if (this.client) {
            this.client.close();
        }
        this.directoryCache.clear();
        this.client = new ftp.Client(config.timeout);
        this.client.ftp.verbose = false;
        this.remoteRoot = (0, utils_1.normaliseRemotePath)(config.remoteRoot || '/');
        try {
            await this.client.access({
                host: config.host,
                port: config.port,
                user: config.username,
                password: secrets.password || '',
                secure: config.useTls,
                secureOptions: config.useTls ? { rejectUnauthorized: false } : undefined,
            });
            // Navigate to the remote root
            if (this.remoteRoot !== '/') {
                await this.client.ensureDir(this.remoteRoot);
                await this.client.cd(this.remoteRoot);
            }
            (0, utils_1.logInfo)(`FTP: Connected to ${config.host}:${config.port}`);
        }
        catch (err) {
            if (this.client) {
                this.client.close();
                this.client = null;
            }
            throw new Error(`FTP connection failed: ${err.message}`);
        }
    }
    async disconnect() {
        if (this.client) {
            this.client.close();
            this.client = null;
            this.directoryCache.clear();
            (0, utils_1.logInfo)('FTP: Disconnected');
        }
    }
    isConnected() {
        return this.client !== null && !this.client.closed;
    }
    async listDirectory(remotePath) {
        const absPath = this.toAbsolute(remotePath);
        const entries = await this.getDirectoryEntries(absPath);
        return entries.map(entry => ({ ...entry, stat: { ...entry.stat } }));
    }
    async stat(remotePath) {
        const absPath = this.toAbsolute(remotePath);
        const parentPath = absPath.substring(0, absPath.lastIndexOf('/')) || '/';
        const name = absPath.substring(absPath.lastIndexOf('/') + 1);
        if (parentPath === absPath) {
            return { type: 'directory', ctime: 0, mtime: 0, size: 0 };
        }
        const list = await this.getDirectoryEntries(parentPath);
        const found = list.find(item => item.name === name);
        if (!found) {
            try {
                const size = await this.runExclusive(client => client.size(absPath));
                return { type: 'file', ctime: 0, mtime: Date.now(), size };
            }
            catch {
                throw new Error(`File not found: ${absPath}`);
            }
        }
        return { ...found.stat };
    }
    async readFile(remotePath) {
        const absPath = this.toAbsolute(remotePath);
        return this.runExclusive(async (client) => {
            const chunks = [];
            const writable = new stream_1.Writable({
                write(chunk, _enc, cb) {
                    chunks.push(Buffer.from(chunk));
                    cb();
                },
            });
            await client.downloadTo(writable, absPath);
            return Buffer.concat(chunks);
        });
    }
    async writeFile(remotePath, data) {
        const absPath = this.toAbsolute(remotePath);
        await this.runExclusive(async (client) => {
            const readable = stream_1.Readable.from(data);
            await client.uploadFrom(readable, absPath);
        });
        this.invalidatePath(absPath);
    }
    async createDirectory(remotePath) {
        const absPath = this.toAbsolute(remotePath);
        await this.runExclusive(client => client.ensureDir(absPath));
        this.invalidatePath(absPath, true);
    }
    async deleteFile(remotePath) {
        const absPath = this.toAbsolute(remotePath);
        await this.runExclusive(client => client.remove(absPath));
        this.invalidatePath(absPath);
    }
    async deleteDirectory(remotePath) {
        const absPath = this.toAbsolute(remotePath);
        await this.runExclusive(client => client.removeDir(absPath));
        this.invalidatePath(absPath, true);
    }
    async rename(oldPath, newPath) {
        const absOld = this.toAbsolute(oldPath);
        const absNew = this.toAbsolute(newPath);
        await this.runExclusive(async (client) => {
            try {
                await client.rename(absOld, absNew);
            }
            catch (err) {
                throw new Error(`FTP rename failed: ${err.message}`);
            }
        });
        this.invalidatePath(absOld, true);
        this.invalidatePath(absNew, true);
    }
    getCurrentDirectory() {
        return this.remoteRoot;
    }
    dispose() {
        if (this.client) {
            this.client.close();
            this.client = null;
        }
    }
    // -- private helpers --
    async getClient() {
        if (!this.client || this.client.closed) {
            if (this.lastConfig) {
                await this.connect(this.lastConfig.config, this.lastConfig.secrets);
            }
            else {
                throw new Error('FTP: Not connected');
            }
        }
        return this.client;
    }
    async runExclusive(operation) {
        const previous = this.operationQueue;
        let release;
        this.operationQueue = new Promise(resolve => {
            release = resolve;
        });
        await previous;
        try {
            const client = await this.getClient();
            return await operation(client);
        }
        catch (err) {
            if (this.isConnectionError(err)) {
                this.client?.close();
                this.client = null;
                this.directoryCache.clear();
                const client = await this.getClient();
                return await operation(client);
            }
            throw err;
        }
        finally {
            release();
        }
    }
    isConnectionError(err) {
        const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
        return message.includes('closed') || message.includes('timeout') || message.includes('socket') || message.includes('econnreset');
    }
    async getDirectoryEntries(absPath) {
        const now = Date.now();
        const cached = this.directoryCache.get(absPath);
        if (cached?.entries && cached.expiresAt > now) {
            return cached.entries;
        }
        if (cached?.promise) {
            return cached.promise;
        }
        const promise = this.runExclusive(async (client) => {
            const raw = await client.list(absPath);
            const entries = [];
            for (const item of raw) {
                if (item.name === '.' || item.name === '..') {
                    continue;
                }
                const entryPath = (0, utils_1.joinRemotePath)(absPath, item.name);
                entries.push({
                    name: item.name,
                    path: entryPath,
                    stat: {
                        type: item.isDirectory ? 'directory' : item.isSymbolicLink ? 'symlink' : 'file',
                        ctime: 0,
                        mtime: item.modifiedAt ? item.modifiedAt.getTime() : Date.now(),
                        size: item.size || 0,
                        permissions: item.permissions?.user && item.permissions?.group && item.permissions?.world
                            ? `-${item.permissions.user}${item.permissions.group}${item.permissions.world}`
                            : undefined,
                    },
                });
            }
            return entries;
        });
        this.directoryCache.set(absPath, { expiresAt: now + this.directoryCacheTtlMs, promise });
        this.pruneDirectoryCache();
        try {
            const entries = await promise;
            this.directoryCache.set(absPath, { expiresAt: Date.now() + this.directoryCacheTtlMs, entries });
            this.pruneDirectoryCache();
            return entries;
        }
        catch (err) {
            this.directoryCache.delete(absPath);
            throw err;
        }
    }
    invalidatePath(absPath, includeSelf = false) {
        const parentPath = absPath.substring(0, absPath.lastIndexOf('/')) || '/';
        this.directoryCache.delete(parentPath);
        if (includeSelf) {
            this.directoryCache.delete(absPath);
            const prefix = absPath.endsWith('/') ? absPath : absPath + '/';
            for (const key of this.directoryCache.keys()) {
                if (key.startsWith(prefix)) {
                    this.directoryCache.delete(key);
                }
            }
        }
    }
    pruneDirectoryCache() {
        while (this.directoryCache.size > this.maxCachedDirectories) {
            const oldestKey = this.directoryCache.keys().next().value;
            if (!oldestKey) {
                return;
            }
            this.directoryCache.delete(oldestKey);
        }
    }
    toAbsolute(p) {
        const clean = (0, utils_1.normaliseRemotePath)(p);
        if (clean.startsWith('/')) {
            return clean;
        }
        return (0, utils_1.joinRemotePath)(this.remoteRoot, clean);
    }
}
exports.FtpAdapter = FtpAdapter;
//# sourceMappingURL=ftpAdapter.js.map