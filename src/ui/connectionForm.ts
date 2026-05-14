/**
 * ConnectionSetupWebview — shows an HTML form for adding or editing
 * a remote connection (FTP/SFTP).
 *
 * We use a VS Code webview panel to present a user-friendly form
 * rather than chaining multiple InputBox dialogs.
 */

import * as vscode from 'vscode';
import { ConnectionConfig, Protocol, AuthMethod } from '../types';
import { absoluteRemotePath, generateId, logInfo } from '../utils';

/**
 * Show the connection form webview.
 *
 * @param context Extension context for URI resolution.
 * @param existing If provided, the form will be pre-filled for editing.
 * @returns The filled-out ConnectionConfig, or undefined if cancelled.
 */
export async function showConnectionForm(
  context: vscode.ExtensionContext,
  existing?: ConnectionConfig,
): Promise<ConnectionConfig | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: ConnectionConfig | undefined) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const panel = vscode.window.createWebviewPanel(
      'remoteExplorer.connectionForm',
      existing ? `Edit: ${existing.label}` : 'Add Remote Connection',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    const isEdit = !!existing;
    const defaults: Partial<ConnectionConfig> = existing || {
      protocol: 'sftp',
      host: '',
      port: 22,
      username: '',
      authMethod: 'password',
      remoteRoot: '/',
      timeout: 30000,
      passiveMode: true,
      useTls: false,
    };

    panel.webview.html = getHtml(panel.webview, context, defaults, isEdit);

    // Use a local disposables array scoped to this panel's lifetime.
    // Do NOT use context.subscriptions — the message listener must be
    // tied to the panel, not the extension, so it is not affected by
    // previously disposed panels sharing the same subscriptions array.
    const panelDisposables: vscode.Disposable[] = [];

    panel.onDidDispose(() => {
      settle(undefined);
      panelDisposables.forEach(d => d.dispose());
    }, undefined, context.subscriptions);

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        logInfo(`Webview sent message: ${message.command}`);
        switch (message.command) {
          case 'error':
            vscode.window.showErrorMessage(`Webview UI Error: ${message.data}`);
            break;
          case 'save': {
            const data = message.data;
            const config: ConnectionConfig = {
              id: existing?.id || generateId(),
              label: data.label || 'Unnamed Connection',
              protocol: data.protocol as Protocol,
              host: data.host,
              port: Number(data.port),
              username: data.username,
              authMethod: data.authMethod as AuthMethod,
              remoteRoot: absoluteRemotePath(data.remoteRoot || '/'),
              localCachePath: data.localCachePath || undefined,
              timeout: Number(data.timeout) || 30000,
              passiveMode: data.passiveMode === true || data.passiveMode === 'true',
              useTls: data.useTls === true || data.useTls === 'true',
              customSettings: data.customSettings || {},
            };

            // Return the secrets info alongside the config so the caller
            // can store secrets separately.
            (config as any)._secrets = {
              password: data.authMethod === 'password' ? data.password : undefined,
              sshKeyPath: data.authMethod === 'key' ? data.sshKeyPath : undefined,
              sshPassphrase: data.authMethod === 'key' ? data.sshPassphrase : undefined,
            };

            settle(config);
            panel.dispose();
            break;
          }
          case 'cancel':
            settle(undefined);
            panel.dispose();
            break;
        }
      },
      undefined,
      panelDisposables,
    );
  });
}

function getHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  defaults: Partial<ConnectionConfig>,
  isEdit: boolean,
): string {
  const proto = defaults.protocol || 'sftp';
  const port = defaults.port ?? (proto === 'ftp' ? 21 : 22);
  const authMethod = defaults.authMethod || 'password';

  // Simple nonce for inline scripts
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>${isEdit ? 'Edit Connection' : 'Add Connection'}</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --border: var(--vscode-input-border, #555);
      --btn-primary-bg: var(--vscode-button-background, #0078d4);
      --btn-primary-fg: var(--vscode-button-foreground, #ffffff);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-secondary-fg: var(--vscode-button-secondaryForeground, #cccccc);
      --focus-border: var(--vscode-focusBorder, #007acc);
      --error: var(--vscode-errorForeground, #f44747);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--fg);
      background: var(--bg);
      padding: 16px;
    }
    h2 { margin-bottom: 16px; font-size: 16px; font-weight: 600; }
    .form-group { margin-bottom: 12px; }
    label { display: block; margin-bottom: 4px; font-weight: 500; }
    input, select, textarea {
      width: 100%;
      padding: 6px 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      border-radius: 3px;
      font-family: inherit;
      font-size: 13px;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--focus-border);
    }
    .row { display: flex; gap: 12px; }
    .row > * { flex: 1; }
    .row.small > * { flex: 0 0 auto; }
    .row.small > .flex { flex: 1; }
    .checkbox-group { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .checkbox-group input[type="checkbox"] { width: auto; }
    .hidden { display: none !important; }
    .actions { margin-top: 20px; display: flex; gap: 8px; justify-content: flex-end; }
    button {
      padding: 6px 16px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
    }
    .btn-primary { background: var(--btn-primary-bg); color: var(--btn-primary-fg); }
    .btn-secondary { background: var(--btn-secondary-bg); color: var(--btn-secondary-fg); }
  </style>
</head>
<body>
  <h2>${isEdit ? 'Edit Connection' : 'Add New Connection'}</h2>

  <div class="form-group">
    <label for="label">Connection Name</label>
    <input id="label" type="text" value="${escAttr(defaults.label || '')}" placeholder="My Server" />
  </div>

  <div class="row">
    <div class="form-group">
      <label for="protocol">Protocol</label>
      <select id="protocol">
        <option value="sftp" ${proto === 'sftp' ? 'selected' : ''}>SFTP (SSH)</option>
        <option value="ftp" ${proto === 'ftp' ? 'selected' : ''}>FTP</option>
      </select>
    </div>
    <div class="form-group">
      <label for="host">Host</label>
      <input id="host" type="text" value="${escAttr(defaults.host || '')}" placeholder="example.com" />
    </div>
    <div class="form-group">
      <label for="port">Port</label>
      <input id="port" type="number" value="${port}" min="1" max="65535" />
    </div>
  </div>

  <div class="row">
    <div class="form-group">
      <label for="username">Username</label>
      <input id="username" type="text" value="${escAttr(defaults.username || '')}" placeholder="user" />
    </div>
    <div class="form-group">
      <label for="authMethod">Authentication</label>
      <select id="authMethod">
        <option value="password" ${authMethod === 'password' ? 'selected' : ''}>Password</option>
        <option value="key" ${authMethod === 'key' ? 'selected' : ''}>SSH Key</option>
      </select>
    </div>
  </div>

  <!-- Password auth fields -->
  <div id="auth-password-section">
    <div class="form-group">
      <label for="password">Password</label>
      <input id="password" type="password" value="" placeholder="${isEdit ? 'Leave blank to keep current' : 'Enter password'}" />
    </div>
  </div>

  <!-- SSH Key auth fields -->
  <div id="auth-key-section" class="hidden">
    <div class="form-group">
      <label for="sshKeyPath">SSH Private Key Path</label>
      <input id="sshKeyPath" type="text" value="" placeholder="/home/user/.ssh/id_rsa" />
    </div>
    <div class="form-group">
      <label for="sshPassphrase">SSH Key Passphrase (if any)</label>
      <input id="sshPassphrase" type="password" value="" placeholder="Passphrase" />
    </div>
  </div>

  <div class="form-group">
    <label for="remoteRoot">Remote Root Directory</label>
    <input id="remoteRoot" type="text" value="${escAttr(defaults.remoteRoot || '/')}" placeholder="/" />
  </div>

  <div class="row">
    <div class="form-group">
      <label for="timeout">Connection Timeout (ms)</label>
      <input id="timeout" type="number" value="${defaults.timeout || 30000}" min="1000" step="1000" />
    </div>
    <div class="form-group">
      <label for="localCachePath">Local Cache Path (optional)</label>
      <input id="localCachePath" type="text" value="${escAttr(defaults.localCachePath || '')}" placeholder="Leave empty for no cache" />
    </div>
  </div>

  <div id="ftp-options" class="${proto === 'ftp' ? '' : 'hidden'}">
    <div class="checkbox-group">
      <input id="passiveMode" type="checkbox" ${defaults.passiveMode !== false ? 'checked' : ''} />
      <label for="passiveMode">Passive mode</label>
    </div>
    <div class="checkbox-group">
      <input id="useTls" type="checkbox" ${defaults.useTls ? 'checked' : ''} />
      <label for="useTls">Use explicit TLS (FTPS)</label>
    </div>
  </div>

  <div class="actions">
    <button id="cancelBtn" class="btn-secondary">Cancel</button>
    <button id="saveBtn" class="btn-primary">${isEdit ? 'Save Changes' : 'Add Connection'}</button>
  </div>

  <script nonce="${nonce}">
    window.onerror = function(msg, source, lineno, colno, error) {
      document.body.innerHTML += '<div style="color:red; margin-top:20px;">' + msg + ' - ' + source + ':' + lineno + '</div>';
    };

    const vscode = acquireVsCodeApi();

    // Show/hide auth sections
    const authMethodSel = document.getElementById('authMethod');
    const protocolSel = document.getElementById('protocol');
    const authPassword = document.getElementById('auth-password-section');
    const authKey = document.getElementById('auth-key-section');
    const ftpOptions = document.getElementById('ftp-options');

    function toggleAuth() {
      if (authMethodSel.value === 'key') {
        authPassword.classList.add('hidden');
        authKey.classList.remove('hidden');
      } else {
        authPassword.classList.remove('hidden');
        authKey.classList.add('hidden');
      }
    }

    function toggleProtocol() {
      if (protocolSel.value === 'ftp') {
        ftpOptions.classList.remove('hidden');
        document.getElementById('port').value = document.getElementById('port').value == '22' ? '21' : document.getElementById('port').value;
      } else {
        ftpOptions.classList.add('hidden');
        document.getElementById('port').value = document.getElementById('port').value == '21' ? '22' : document.getElementById('port').value;
      }
    }

    authMethodSel.addEventListener('change', toggleAuth);
    protocolSel.addEventListener('change', toggleProtocol);

    document.getElementById('saveBtn').addEventListener('click', save);
    document.getElementById('cancelBtn').addEventListener('click', cancel);

    // Set initial state
    toggleAuth();

    function getVal(id) {
      return document.getElementById(id).value;
    }

    function getCheck(id) {
      return document.getElementById(id).checked;
    }

    function save() {
      try {
        let host = getVal('host').trim()
          .replace('ftp://', '')
          .replace('sftp://', '')
          .replace('ftps://', '')
          .replace('http://', '')
          .replace('https://', '');
        host = host.split('/')[0];
        if (!host) {
          vscode.postMessage({ command: 'error', data: 'Host is required.' });
          return;
        }
        document.getElementById('host').value = host;

        const data = {
          label: getVal('label').trim() || host,
          protocol: getVal('protocol'),
          host: host,
          port: parseInt(getVal('port')) || ((getVal('protocol') === 'ftp') ? 21 : 22),
          username: getVal('username').trim(),
          authMethod: getVal('authMethod'),
          password: getVal('password'),
          sshKeyPath: getVal('sshKeyPath').trim(),
          sshPassphrase: getVal('sshPassphrase'),
          remoteRoot: getVal('remoteRoot').trim() || '/',
          localCachePath: getVal('localCachePath').trim(),
          timeout: parseInt(getVal('timeout')) || 30000,
          passiveMode: getCheck('passiveMode'),
          useTls: getCheck('useTls'),
        };

        vscode.postMessage({ command: 'save', data });
      } catch (err) {
        vscode.postMessage({ command: 'error', data: err.message });
      }
    }

    function cancel() {
      vscode.postMessage({ command: 'cancel' });
    }
  </script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function escAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
