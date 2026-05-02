# Rift

Rift is a real-time shared workspace for moving text, files, and images between machines. It runs a small Fastify server that hosts the browser UI and synchronizes cards over WebSocket, plus an Electron shell that opens the workspace as a native overlay window.

The public version is a reusable self-hosted baseline. It does not include private deployment targets, machine names, runtime data, or backup topology.

## How It Works

```
[Laptop - Electron]                [Rift server]                    [Desktop - Browser/Electron]
  loads UI from server <--- HTTPS ---> serves app/index.html <--- HTTPS ---> loads UI from server
  WebSocket sync      <--- WSS -----> broadcasts changes     <--- WSS -----> WebSocket sync
```

- `app/index.html` is the client UI: an infinite canvas with text, file, image, audio, video, PDF, and grouped cards.
- `server/index.js` is the Fastify backend: static UI hosting, token auth, WebSocket sync, uploads, downloads, state persistence, and expiration cleanup.
- `main.js` is the Electron shell. It loads `RIFT_SERVER_URL`, defaulting to `http://127.0.0.1:3300`.

## Quick Start

Install dependencies:

```bash
npm install
```

Start the server:

```bash
cp .env.example .env
npm run server
```

In another terminal, launch the Electron client:

```bash
npm start
```

For a hosted server, point the Electron client at your deployed URL:

```bash
RIFT_SERVER_URL=https://rift.example.invalid npm start
```

## Server Configuration

All server options are read from environment variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `RIFT_TOKEN` | empty | Shared token for cookie auth. If empty, auth is disabled. |
| `PORT` | `3300` | Fastify listen port. |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback-only when exposing through a reverse proxy or private overlay network. |
| `DATA_DIR` | `./data` | Directory for `items.json` and uploaded files. |

The server creates `DATA_DIR/files` automatically.

## Deployment

Rift can run behind any HTTPS reverse proxy or private overlay network. A common layout is:

1. Run `server/index.js` under PM2 or systemd.
2. Bind the app to `127.0.0.1:3300`.
3. Terminate HTTPS in Caddy, nginx, a tunnel, or an overlay-network serve command.
4. Set `RIFT_SERVER_URL` on each Electron client to the public or private HTTPS URL.

The included `deploy.sh` is a parameterized rsync helper. Configure it with environment variables:

```bash
RIFT_DEPLOY_REMOTE=user@example.invalid \
RIFT_DEPLOY_SSH_KEY="$HOME/.ssh/id_example" \
RIFT_REMOTE_DIR=/opt/rift \
RIFT_REMOTE_USER=rift \
./deploy.sh
```

`RIFT_DEPLOY_SSH_KEY` is optional. The remote host is expected to have Node.js, npm, PM2, and a service user available.

## Repo Structure

```
rift/
├── app/
│   └── index.html           # Frontend UI: canvas, cards, groups, uploads, search
├── server/
│   └── index.js             # Fastify server, WebSocket sync, auth, storage
├── main.js                  # Electron client shell
├── deploy.sh                # Optional parameterized rsync deploy helper
├── launch.sh                # Convenience launcher for desktop hotkeys
├── ecosystem.config.cjs     # PM2 process config
├── .env.example             # Server environment template
├── package.json             # Electron and server dependencies
└── README.md
```

## Features

- Infinite canvas with pan, zoom, auto-fit, and viewport virtualization.
- Text cards, file cards, image cards, audio cards, video cards, and inline PDFs.
- Drag-and-drop uploads with streamed file writes.
- Streamed downloads with native save dialogs in Electron.
- Multi-select, grouping, group movement, group resize, and grid arrange.
- Search by content, label, or filename.
- Markdown rendering for text cards.
- Hidden text mode for reducing on-screen exposure of sensitive snippets.
- Pin, lock, collapse, duplicate, resize, and expiration controls.
- Token authentication with an httpOnly cookie.
- WebSocket message validation and upload rate limiting.

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| Scroll wheel | Zoom in/out |
| Right-click drag / Space+drag | Pan canvas |
| Ctrl/Cmd+click | Add to selection |
| `M` | Toggle multi-select mode |
| `G` | Group selected cards |
| `U` | Ungroup or remove selected cards from a group |
| Delete / Backspace | Delete selected cards |
| Ctrl/Cmd+C | Copy selected text card content |
| Ctrl/Cmd+Z | Undo last text-card deletion |
| Ctrl/Cmd+A | Select all |
| Ctrl/Cmd+N | New text note |
| Ctrl/Cmd+0 | Reset zoom to 100% |
| `+` / `=` | Zoom in |
| `-` / `_` | Zoom out |
| `/` | Search |
| Escape | Deselect, close search, or exit the current mode |

## Storage

Runtime data is intentionally not tracked by git:

| Path | Contents |
| --- | --- |
| `data/items.json` | Card state, positions, labels, groups, and metadata. |
| `data/files/` | Uploaded files stored by generated filename. |
| `.env` | Local server configuration and token. |

Back up `DATA_DIR` and `.env` using your own infrastructure if the workspace contains data you care about.

## Security Notes

- Use `RIFT_TOKEN` for any deployment that is reachable by other users.
- Keep `HOST=127.0.0.1` when exposing Rift through a reverse proxy, tunnel, or private overlay network.
- Treat uploaded files and card text as sensitive workspace data.
- The Electron window runs with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- External links open in the operating system browser instead of inside the Electron shell.
