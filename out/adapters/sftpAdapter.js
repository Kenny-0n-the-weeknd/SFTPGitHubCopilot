"use strict";
/**
 * SFTP adapter using the "ssh2" library.
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
exports.SftpAdapter = void 0;
const ssh2_1 = require("ssh2");
const utils_1 = require("../utils");
const fs = __importStar(require("fs"));
class SftpAdapter {
    session = null;
    remoteRoot = '/';
    lastConfig;
    connectionPromise = null;
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
    _doConnect(config, secrets) {
        if (this.session) {
            this.session.sftp.end();
            this.session.client.end();
            this.session = null;
        }
        const client = new ssh2_1.Client();
        this.remoteRoot = (0, utils_1.normaliseRemotePath)(config.remoteRoot || '/');
        const connectConfig = {
            host: config.host,
            port: config.port,
            username: config.username,
            readyTimeout: config.timeout,
        };
        if (config.authMethod === 'key') {
            if (!secrets.sshKeyPath) {
                throw new Error('SSH key path is required for key authentication');
            }
            const keyPath = secrets.sshKeyPath;
            if (!fs.existsSync(keyPath)) {
                throw new Error(`SSH key file not found: ${keyPath}`);
            }
            connectConfig.privateKey = fs.readFileSync(keyPath);
            if (secrets.sshPassphrase) {
                connectConfig.passphrase = secrets.sshPassphrase;
            }
        }
        else {
            connectConfig.password = secrets.password;
        }
        return new Promise((resolve, reject) => {
            client.on('ready', () => {
                (0, utils_1.logInfo)(`SSH: Authenticated to ${config.host}:${config.port}`);
                client.sftp((err, sftpStream) => {
                    if (err) {
                        client.end();
                        reject(new Error(`SFTP session error: ${err.message}`));
                        return;
                    }
                    this.session = { client, sftp: sftpStream };
                    const clearSession = () => {
                        if (this.session?.client === client) {
                            this.session = null;
                        }
                    };
                    client.on('close', clearSession);
                    client.on('end', clearSession);
                    sftpStream.on?.('close', clearSession);
                    sftpStream.on?.('end', clearSession);
                    resolve();
                });
            });
            client.on('error', (err) => {
                reject(new Error(`SFTP connection failed: ${err.message}`));
            });
            client.connect(connectConfig);
        });
    }
    async disconnect() {
        if (this.session) {
            this.session.sftp.end();
            this.session.client.end();
            this.session = null;
            (0, utils_1.logInfo)('SFTP: Disconnected');
        }
    }
    isConnected() {
        return this.session !== null;
    }
    async listDirectory(remotePath) {
        const session = await this.getSession();
        const absPath = this.toAbsolute(remotePath);
        const items = await new Promise((resolve, reject) => {
            session.sftp.readdir(absPath, (err, list) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(list);
                }
            });
        });
        const entries = [];
        for (const item of items) {
            if (item.filename === '.' || item.filename === '..') {
                continue;
            }
            const entryPath = (0, utils_1.joinRemotePath)(absPath, item.filename);
            entries.push({
                name: item.filename,
                path: entryPath,
                stat: {
                    type: this.isDirectory(item.attrs)
                        ? 'directory' : this.isSymlink(item.attrs) ? 'symlink' : 'file',
                    ctime: item.attrs.atime * 1000,
                    mtime: item.attrs.mtime * 1000,
                    size: item.attrs.size,
                    permissions: this.formatPermissions(item.attrs),
                },
            });
        }
        return entries;
    }
    async stat(remotePath) {
        const session = await this.getSession();
        const absPath = this.toAbsolute(remotePath);
        const attrs = await new Promise((resolve, reject) => {
            session.sftp.stat(absPath, (err, stats) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(stats);
                }
            });
        });
        return {
            type: this.isDirectory(attrs) ? 'directory' : this.isSymlink(attrs) ? 'symlink' : 'file',
            ctime: attrs.atime * 1000,
            mtime: attrs.mtime * 1000,
            size: attrs.size,
            permissions: this.formatPermissions(attrs),
        };
    }
    async readFile(remotePath) {
        const session = await this.getSession();
        const absPath = this.toAbsolute(remotePath);
        return new Promise((resolve, reject) => {
            const chunks = [];
            const stream = session.sftp.createReadStream(absPath);
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
        });
    }
    async writeFile(remotePath, data) {
        const session = await this.getSession();
        const absPath = this.toAbsolute(remotePath);
        return new Promise((resolve, reject) => {
            const stream = session.sftp.createWriteStream(absPath);
            stream.on('finish', resolve);
            stream.on('error', reject);
            stream.end(data);
        });
    }
    async createDirectory(remotePath) {
        const session = await this.getSession();
        const absPath = this.toAbsolute(remotePath);
        return new Promise((resolve, reject) => {
            session.sftp.mkdir(absPath, { mode: 0o755 }, (err) => {
                if (err && !err.message?.includes('already exists')) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }
    async deleteFile(remotePath) {
        const session = await this.getSession();
        const absPath = this.toAbsolute(remotePath);
        return new Promise((resolve, reject) => {
            session.sftp.unlink(absPath, (err) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }
    async deleteDirectory(remotePath) {
        const absPath = this.toAbsolute(remotePath);
        await this.recursiveDelete(absPath);
    }
    async rename(oldPath, newPath) {
        const session = await this.getSession();
        const absOld = this.toAbsolute(oldPath);
        const absNew = this.toAbsolute(newPath);
        return new Promise((resolve, reject) => {
            session.sftp.rename(absOld, absNew, (err) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }
    getCurrentDirectory() {
        return this.remoteRoot;
    }
    dispose() {
        if (this.session) {
            this.session.sftp.end();
            this.session.client.end();
            this.session = null;
        }
    }
    // -- private helpers --
    async getSession() {
        if (!this.session) {
            if (this.lastConfig) {
                await this.connect(this.lastConfig.config, this.lastConfig.secrets);
            }
            else {
                throw new Error('SFTP: Not connected');
            }
        }
        return this.session;
    }
    toAbsolute(p) {
        const clean = (0, utils_1.normaliseRemotePath)(p);
        if (clean.startsWith('/')) {
            return clean;
        }
        return (0, utils_1.joinRemotePath)(this.remoteRoot, clean);
    }
    isDirectory(attrs) {
        return attrs?.mode != null && (attrs.mode & 0o040000) !== 0;
    }
    isSymlink(attrs) {
        return attrs?.mode != null && (attrs.mode & 0o120000) !== 0;
    }
    formatPermissions(attrs) {
        if (attrs?.mode == null) {
            return undefined;
        }
        const mode = attrs.mode;
        const typeChar = this.isDirectory(attrs) ? 'd' : this.isSymlink(attrs) ? 'l' : '-';
        const rwx = (bits) => {
            const r = (bits & 4) ? 'r' : '-';
            const w = (bits & 2) ? 'w' : '-';
            const x = (bits & 1) ? 'x' : '-';
            return r + w + x;
        };
        const owner = rwx((mode >> 6) & 7);
        const group = rwx((mode >> 3) & 7);
        const other = rwx(mode & 7);
        return typeChar + owner + group + other;
    }
    async recursiveDelete(remotePath) {
        const entries = await this.listDirectory(remotePath);
        for (const entry of entries) {
            const entryPath = (0, utils_1.joinRemotePath)(remotePath, entry.name);
            if (entry.stat.type === 'directory') {
                await this.recursiveDelete(entryPath);
            }
            else {
                await this.deleteFile(entryPath);
            }
        }
        const session = await this.getSession();
        return new Promise((resolve, reject) => {
            session.sftp.rmdir(remotePath, (err) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }
}
exports.SftpAdapter = SftpAdapter;
//# sourceMappingURL=sftpAdapter.js.map