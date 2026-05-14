"use strict";
/**
 * Utilities: logging, path helpers, and secret storage wrapper.
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
exports.logInfo = logInfo;
exports.logWarn = logWarn;
exports.logError = logError;
exports.showError = showError;
exports.showWarning = showWarning;
exports.showInfo = showInfo;
exports.normaliseRemotePath = normaliseRemotePath;
exports.joinRemotePath = joinRemotePath;
exports.dirnameRemote = dirnameRemote;
exports.basenameRemote = basenameRemote;
exports.remoteStatToFileStat = remoteStatToFileStat;
exports.storeSecret = storeSecret;
exports.getSecret = getSecret;
exports.deleteSecret = deleteSecret;
exports.generateId = generateId;
exports.disposeOutputChannel = disposeOutputChannel;
const vscode = __importStar(require("vscode"));
/** Dedicated output channel for Remote Explorer logs */
const outputChannel = vscode.window.createOutputChannel('Remote Explorer', { log: true });
/**
 * Write an info-level message to the Remote Explorer output channel.
 */
function logInfo(message) {
    outputChannel.info(`[INFO] ${message}`);
}
/**
 * Write a warning-level message to the Remote Explorer output channel.
 */
function logWarn(message) {
    outputChannel.warn(`[WARN] ${message}`);
}
/**
 * Write an error-level message to the Remote Explorer output channel.
 */
function logError(message) {
    outputChannel.error(`[ERROR] ${message}`);
}
/**
 * Show an error popup to the user.
 */
function showError(message) {
    logError(message);
    vscode.window.showErrorMessage(`Remote Explorer: ${message}`);
}
/**
 * Show a warning popup to the user.
 */
function showWarning(message) {
    logWarn(message);
    vscode.window.showWarningMessage(`Remote Explorer: ${message}`);
}
/**
 * Show an info popup to the user.
 */
function showInfo(message) {
    logInfo(message);
    vscode.window.showInformationMessage(`Remote Explorer: ${message}`);
}
/**
 * Normalise a remote path to always use forward slashes and no trailing slash
 * (except for the root '/').
 */
function normaliseRemotePath(input) {
    let path = input.replace(/\\/g, '/');
    // Collapse multiple slashes
    path = path.replace(/\/+/g, '/');
    if (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
    }
    return path || '/';
}
/**
 * Join two remote path segments with a forward slash.
 */
function joinRemotePath(base, ...segments) {
    let result = normaliseRemotePath(base);
    for (const seg of segments) {
        if (seg) {
            result = result.replace(/\/$/, '') + '/' + normaliseRemotePath(seg).replace(/^\//, '');
        }
    }
    return result || '/';
}
/**
 * Return the parent remote directory path.
 */
function dirnameRemote(path) {
    const p = normaliseRemotePath(path);
    if (p === '/') {
        return '/';
    }
    const idx = p.lastIndexOf('/');
    return idx <= 0 ? '/' : p.substring(0, idx);
}
/**
 * Return the basename of a remote path.
 */
function basenameRemote(path) {
    const p = normaliseRemotePath(path);
    if (p === '/') {
        return '/';
    }
    const idx = p.lastIndexOf('/');
    return p.substring(idx + 1);
}
const vscode_1 = require("vscode");
function remoteStatToFileStat(stat) {
    const type = stat.type === 'directory'
        ? vscode_1.FileType.Directory
        : stat.type === 'symlink'
            ? vscode_1.FileType.SymbolicLink
            : vscode_1.FileType.File;
    return [type, { ctime: stat.ctime, mtime: stat.mtime, size: stat.size }];
}
/**
 * Safely store a secret using VS Code SecretStorage.
 */
async function storeSecret(context, key, value) {
    await context.secrets.store(key, value);
}
/**
 * Retrieve a secret.
 */
async function getSecret(context, key) {
    return context.secrets.get(key);
}
/**
 * Delete a secret.
 */
async function deleteSecret(context, key) {
    await context.secrets.delete(key);
}
/**
 * Generate a short unique ID for a new connection.
 */
function generateId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
}
/** Dispose the output channel when extension deactivates */
function disposeOutputChannel() {
    outputChannel.dispose();
}
//# sourceMappingURL=index.js.map