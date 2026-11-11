# Rift

Rift is a self-hosted shared workspace for notes, images and files. A Fastify server stores the workspace and serves the interface. A browser or sandboxed Electron window opens that interface and synchronizes changes over WebSocket.

Version **1.1.0** adds named workspaces, synchronized tabs and views, search, Library, Archive and recoverable Trash. It also controls background previews, streams explicit transfers, supports byte ranges and reconciles interrupted uploads. This repository contains reusable source, generated test fixtures and generic configuration. It contains no hosted service or deployment credentials.

## How it works

```text
Browser / Electron  <-- HTTPS + WebSocket -->  Rift server
                                              |-- app assets
                                              |-- shared workspace/session state
                                              |-- original attachments
                                              `-- generated image previews
```

The server hosts every file in `app/`. Reload/reopen clients after a server/page update. Native changes in `main.js`, `preload.js`, `desktop-downloads.js`, the launcher or Electron require updating and restarting that desktop installation separately.

## Requirements

- Node **24 LTS** or newer; `.nvmrc` selects the Node 24 line.
- Git and npm. Use `npm ci` with the committed lock.
- A graphical desktop for Electron. A browser can use the hosted interface directly.
- Sharp's optional platform binaries for server thumbnails; do not install with `--omit=optional`.
- OpenSSL and FFmpeg with libx264 for the generated demo and browser test fixtures. Normal server operation does not need FFmpeg.

The lock selects Electron **45.3.0**, Fastify **5.12.8** and Sharp **0.35.5**. Server-only installation can skip the Electron binary download.

## Quick start

```bash
git clone https://github.com/ghreprimand/rift-public.git
cd rift-public
# If using nvm:
nvm install
nvm use
npm ci
cp .env.example .env
chmod 600 .env
```

Replace the placeholder `RIFT_TOKEN` in `.env` with a long random secret before using persistent/shared data. Install Node 24 through your preferred installer if you do not use nvm. Do not commit the resulting `.env`.

Start the persistent server:

```bash
npm run server
```

In another terminal:

```bash
npm start
```

The default page is `http://127.0.0.1:3300/`. The Electron client reads its page URL from the process environment, not the server's `.env`. For a remote installation:

```bash
RIFT_SERVER_URL=https://rift.example.invalid npm start
```

`example.invalid` is a placeholder. Use your own HTTPS origin. Authentication cookies are Secure; remote HTTP is not a supported deployment. Keep the backend on loopback behind the intended HTTPS proxy/private network. See [deployment and rollback](docs/deployment.md).

### Disposable demo

```bash
npm run preview
```

Open `http://localhost:8000/`. This loopback-only demo creates a generated board and credentials, does not read `.env`, and deletes its temporary data when stopped. Its embedding proxy relaxes frame restrictions only for the temporary demo. Do not use it as persistent storage.

## Workspaces and shared navigation

Create a workspace with **+ New workspace**. The in-page form supports Enter, Cancel/Escape and inline blank/duplicate-name feedback. Names contain 1–80 characters. Rename or archive a workspace through its menu. Inbox is the default destination for the migrated original board.

Tabs open, close, reorder and reopen without deleting their workspace. Every connected client follows the same open tabs, tab order, active workspace, search, filters, selection, Canvas/Library mode and saved camera. Different screen sizes fit one shared world rectangle. Library pagination and scroll anchors also follow the shared session. A short view-control lease prevents competing gestures; use **Take control** when another device is directing the view.

Native windows, keyboard focus, save dialogs, filesystem destinations and unsubmitted/offline drafts remain local. Disconnected clients synchronize accepted state after reconnecting; this is not independent per-device navigation.

Move selected cards with the bulk toolbar or a card's **Move to workspace** picker. Moving a grouped card moves its connected group together and preserves file identity and positions. Unpin all group members first. Uploads retain the workspace selected when queued even if the active tab changes.

## Finding and organizing content

- **Canvas** keeps freeform card positions and groups; pan, zoom, resize and arrange cards.
- **Library** shows the same cards in a searchable list with 100-row pages.
- **Search** matches note text, labels, filenames and group names. Choose this/all-workspace scope and filter by kind, pin, added-on/after date and sort. Hidden note content is excluded from snippets and text matching. There is no attachment text extraction or OCR.
- **Archive** retains material outside normal browsing.
- **Trash** retains modern deletions for 30 days, with Restore and explicit permanent deletion. Originals remain until their final live/recoverable reference is removed.
- Explicit expiry timers remain permanent automatic deletion. Older single-board pages retain permanent Inbox deletion semantics until reloaded.

Anyone with the shared token can access all workspaces. Workspaces do not create separate accounts or permissions.

## Cards, media and transfers

Paste text, type in the input bar, double-click the canvas or drop files to create cards. Edit notes/labels inline, copy text, duplicate notes, resize, pin, lock, collapse and group cards. Markdown uses an inert allowlist parser. Hidden text is presentation masking, not encryption or access control.

Rendering a card does not download its original attachment. Nearby image cards fetch bounded WebP previews, with two background requests, a bounded queue and a small Blob cache. Pan/zoom, removal and explicit transfers cancel obsolete preview work. Thumbnails fit within **480 × 480 pixels** and **96 KiB**; unsupported, corrupt or oversized images remain downloadable. A single bounded worker generates previews independently of upload success.

PDFs initially show a lightweight card; **Open PDF** loads the document. Audio/video initially show filename and size; **Play** loads media. Closing a preview releases its resources. Original-file endpoints support streamed byte ranges for seeking.

Uploads queue one at a time. Progress distinguishes Queued, Uploading, **Waiting for server confirmation…**, Completed, Failed and Cancelled. At 100% the page still waits for the server's successful response and durable card commit. Cancel active/queued uploads or retry after an error. Stable operation IDs and reconciliation prevent a lost response from creating duplicate cards. There is a two-minute inactivity limit, not a short absolute upload deadline. Limits remain **100 MiB per file** and **20 uploads per minute per client IP**.

Explicit downloads take priority over background previews. The current Electron bridge authenticates with HEAD, selects a destination once and streams to disk with progress/cancellation. Previous bridges use the browser save picker when available. Browser-native fallback cannot report completion to the page; use **Resume previews** when appropriate. Unknown length displays received bytes instead of failing. Terminal status panels clear after two seconds.

HTTP/2 stays enabled by default. `RIFT_HTTP1=1 npm start` is an opt-in temporary compatibility measure, not a replacement for efficient previews or a repair for a degraded network path.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RIFT_TOKEN` | empty | Shared authentication token; empty disables authentication. Set a strong value for shared use. |
| `HOST` | `127.0.0.1` | Backend bind address. |
| `PORT` | `3300` | Backend port. |
| `DATA_DIR` | `data/` beside `server/` | Persistent state, originals and receipts. Use an absolute path in production. Relative configured paths resolve against process cwd. |
| `RIFT_ALLOWED_ORIGINS` | empty | Comma-separated page origins when a trusted proxy rewrites Host. |
| `RIFT_MAINTENANCE` | `0` | `1` rejects user traffic and pauses expiry/upload cleanup; only health and authenticated readiness/diagnostics remain. |
| `RIFT_SKIP_DOTENV` | unset | `1` skips loading the root `.env`, used by isolated fixtures. |
| `RIFT_SERVER_URL` | `http://127.0.0.1:3300` | Desktop page origin; set in the desktop process environment. |
| `RIFT_HTTP1` | unset | `1` disables HTTP/2 only in that Electron process. |
| `RIFT_WAYLAND` | unset | `1` explicitly selects Wayland on Linux; otherwise Electron selects its normal platform. |
| `RIFT_ANGLE_VULKAN` | unset | `1` opts into ANGLE/Vulkan graphics on Linux. GPU sandboxing remains enabled. |

The server reads `.env` without overriding existing process variables. Successful login sets a Secure, HttpOnly, SameSite=Lax cookie for one year. Programmatic requests may use `X-Rift-Token`. Native WebSocket clients without an Origin must authenticate with that header.

## Storage and recovery

The server creates its data directories. Keep the whole `DATA_DIR` and authentication configuration out of Git:

| Path within `DATA_DIR` | Contents |
| --- | --- |
| `items.json` | Schema-2 workspaces, cards, groups, shared session, operation receipts and purge tombstones. |
| `items.pre-workspaces-v1.json` | One-time private backup of the original unversioned board before migration. |
| `files/` | Unchanged uploaded originals stored by generated identity. |
| `previews/` | Regenerable thumbnails and cached failure markers. |
| `uploads.json` | Durable transfer receipts and cancellation/deletion tombstones. |
| `upload-tmp/` | Known incomplete uploads, separate from original files. |

Commands persist atomically before acknowledgement/broadcast. Offline commands replay by operation ID; stale edits retain a recoverable draft under Transfers & drafts. Disk/quota warnings distinguish durable storage from an in-memory draft. Save your recovery text before closing a page with a storage warning.

Tracked unattached uploads expire after 24 hours; unknown legacy originals are not swept. Partial files are cleaned on restart. Operation receipts/tombstones remain to protect against very late retries, so monitor journal growth. Back up a stopped/quiesced service, the complete data directory and configuration. A card JSON export is not a backup of all workspaces and original bodies. See [deployment and rollback](docs/deployment.md).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Scroll | Zoom |
| Right-click drag / Space+drag | Pan |
| Ctrl/Cmd+click | Add to selection |
| M | Toggle multi-select |
| G / U | Group / remove from group |
| Delete / Backspace | Move selected modern cards to Trash, with confirmation |
| Ctrl/Cmd+C / Ctrl/Cmd+A | Copy selected note text / select all |
| Ctrl/Cmd+Z | Undo the last supported text-card deletion |
| Ctrl/Cmd+N | New note |
| Ctrl/Cmd+0 | Reset zoom |
| + / - | Zoom in / out |
| / or Ctrl/Cmd+K | Focus search |
| Enter / Shift+Enter in search | Cycle results |
| Ctrl/Cmd+Shift+T | Reopen the last closed workspace tab |
| Alt+Left / Alt+Right on a tab | Reorder that tab |
| Escape | Close modal/search or clear selection/mode |

Rift does not install a global desktop hotkey. Configure your desktop/window manager to invoke `launch.sh`; repeated launches focus the existing window through Electron's single-instance lock. The launcher expects npm on PATH and works from its checkout directory on macOS and Linux. A physical Mac packaging/save-dialog test is still required before distributing a new native build.

## Development and tests

```bash
npm ci
npm test
npm run test:organization
npm run test:organization -- --offline
npm run test:organization -- --shared
npm run test:organization -- --dialogs
npm run test:downloads
npm run test:downloads -- --layout
npm run test:downloads -- --picker
npm run test:downloads -- --legacy-bridge
npm run test:downloads -- --http1
npm run test:browser -- --adverse
npm run test:browser -- --adverse --warm
npm run test:browser -- --adverse --many
npm run test:browser -- --adverse --faults
npm run test:browser -- --behavior --http1
npm audit --omit=dev
```

The server integration suite has **22 tests**. Browser fixtures use generated PNG/PDF/WAV/MP4/ordinary files, isolated application data, a random token, ephemeral TLS and the real renderer/server/download paths. They skip `.env` and never contact a deployed server. Set `RIFT_TEST_SCRATCH` and `RIFT_TEST_ARTIFACTS` to control temporary/optional output locations. `RIFT_TEST_NODE` selects the standalone Node backend when needed.

On headless Linux, use `xvfb-run -a` before a browser command. The adverse profile is approximately **150 ms RTT** and **512 KiB/s** each direction using browser throttling. `--faults` additionally stalls preview response chunks; neither is TCP packet-loss simulation. The full-page transfer fixture has a 55-second deadline, organization checks 40 seconds and focused downloads 20 seconds.

`npm run test:browser -- --baseline --adverse` reconstructs the initial **public** release from this repository's existing history. It requires a full clone containing that commit; shallow clones need the historical commit fetched. Add `--assert-controlled` to demonstrate that the original eager-download behavior fails the new assertion. No unpublished history is needed.

Linux and macOS CI run API, organization, offline/shared-session/dialog, download, HTTP/2 adverse and HTTP/1.1 behavior checks. Automated fixtures do not prove physical desktop packaging or repair an underlying network path. See [architecture and protocol](docs/architecture.md), [security](SECURITY.md) and [release changes](CHANGELOG.md).

## Source map

- `app/`: canvas, preview scheduler, transfers, safe formatting, shared-session UI, outbox and styles.
- `server/`: HTTP/WebSocket integration, workspace model/search, assets, range streaming, upload receipts and thumbnail worker.
- `main.js`, `preload.js`, `desktop-downloads.js`: sandboxed desktop window and narrow native download bridge.
- `tests/`: generated fixtures, disposable demo and integration/browser regressions.
- `ecosystem.config.cjs`: location-independent PM2 example with an explicit maintenance gate.
- `deploy.sh`: opt-in staging helper; it does not activate a release or restart services.
- `GLOSSARY.md`, `docs/`: product vocabulary, protocol and operating procedures.
