# FTP/SFTP + CoPilot

Live-edit FTP and SFTP sites from VS Code, with CoPilot right beside your remote files.

**By Kenny-0n-The-Weeknd**

[![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![FTP/SFTP](https://img.shields.io/badge/FTP%20%2B%20SFTP-Live%20Editing-2EA44F)](#features)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

FTP/SFTP + CoPilot helps you make live changes to your site without waiting on GitHub load times, repository sync delays, failed workflows, or deployment queues. Connect to your VPS or hosting account, open remote files inside VS Code, ask CoPilot for help, then save directly back to the server.

## Download

Download the latest installable VSIX from this repository:

**[Download FTP/SFTP + CoPilot v1.0.0](https://github.com/Kenny-0n-the-weeknd/SFTPGitHubCopilot/raw/main/ftp-sftp-copilot-1.0.0.vsix)**

You can also install it from a local checkout:

```powershell
code --install-extension .\ftp-sftp-copilot-1.0.0.vsix
```

## Features

- Connect to FTP and SFTP servers from the VS Code Explorer.
- Browse remote folders and files without leaving your workspace.
- Open remote folders as VS Code workspace folders.
- Read, edit, and save remote files directly back to the VPS or hosting server.
- Keep multiple remote files open at the same time.
- Upload, download, rename, delete, and create remote files or folders.
- Handle large FTP servers with directory caching and queued FTP operations.
- Reconnect when sockets drop while respecting manual disconnects.
- Use CoPilot on live site files without waiting for GitHub sync or deployment delays.

## Requirements

- Visual Studio Code `1.85.0` or newer.
- FTP or SFTP credentials for your server.
- Network access to your hosting provider, VPS, or remote machine.

## Installation

1. Download `ftp-sftp-copilot-1.0.0.vsix` from the link above.
2. Open VS Code.
3. Open the Command Palette with `Ctrl+Shift+P`.
4. Run `Extensions: Install from VSIX...`.
5. Select the downloaded VSIX file.
6. Reload VS Code if prompted.

You can also install from the terminal:

```powershell
code --install-extension .\ftp-sftp-copilot-1.0.0.vsix
```

## How To Use

1. Open the **FTP/SFTP + CoPilot** view in the VS Code Explorer.
2. Click the `+` button or run `Remote Explorer: Add New Connection` from the Command Palette.
3. Choose FTP or SFTP.
4. Enter your host, port, username, authentication details, and remote root path.
5. Connect to the server.
6. Open files from the remote tree or the added workspace folder.
7. Edit files normally in VS Code.
8. Save with `Ctrl+S` to write the changes back to the server.

## Recommended Workflow

Use this extension when you need fast live changes on a remote site and do not want to wait for GitHub, deployment pipelines, or hosting control panels.

For production sites, keep a backup or source-controlled copy of important files before editing live. This extension writes saved changes directly to the remote server.

## Build From Source

```powershell
npm install
npm run compile
npm run package
```

The package command creates a `.vsix` file that can be installed in VS Code.

## Support The Project

- Star this repo if the extension helps you.
- Share it with other developers who edit FTP/SFTP-hosted sites.
- Open issues for bugs, connection problems, or feature requests.
- Follow Kenny-0n-The-Weeknd on Instagram: [_kieran.spencer](https://www.instagram.com/_kieran.spencer)

## Links

- Repository: [Kenny-0n-the-weeknd/SFTPGitHubCopilot](https://github.com/Kenny-0n-the-weeknd/SFTPGitHubCopilot)
- Instagram: [@_kieran.spencer](https://www.instagram.com/_kieran.spencer)
- VS Code: [code.visualstudio.com](https://code.visualstudio.com/)

## License

MIT License. See [LICENSE](LICENSE).
