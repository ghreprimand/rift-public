# Architecture and protocol

The backend is authoritative for workspace membership, one shared session, cards/groups and transfer receipts. Every client sharing the token participates in the same state. A workspace is organizational, not an authorization boundary. The frontend is served by the backend; the Electron wrapper contributes the native window and download bridge.

Only the active workspace mounts cards. Canvas virtualization and a separate transformed-screen preview scheduler bound background work. The scheduler uses two active requests, a maximum 24-entry recomputed queue, a 180-pixel screen margin and a 64-entry / 8-MiB Blob cache. Original bodies are loaded only for deliberate opening/playback/download.

Sharp runs in one child worker with one libvips thread and no libvips cache. Input limits are 20 million pixels and 25 MiB encoded bytes, with a ten-second worker deadline and at most 32 queued jobs. The JavaScript heap limit is 128 MiB; native decode memory is additionally bounded by input limits, not that heap setting. Outputs fit 480 × 480 pixels and 96 KiB, preserving orientation/aspect ratio. Successes and failures are cached by stable stored identity. Thumbnail failure never rejects the original upload.

## WebSocket Protocol

All messages are JSON, sent between client ↔ server:

| Type | Direction | Fields | Description |
|------|-----------|--------|-------------|
| `sync` | server → client | `items[], groups[]`, plus workspace/session metadata for v2 | Active workspace snapshot; legacy clients get Inbox only |
| `add` | bidirectional | `item: {id, kind, content, x, y, width, height, color, label, hidden, pinned, locked, collapsed, expiresAt, markdown, ...}` | New card |
| `move` | bidirectional | `id, x, y` | Reposition card (blocked if pinned) |
| `update` | bidirectional | `id, content` | Edit text content (text cards only) |
| `delete` | bidirectional | `id` | Move a modern card to Trash; legacy Inbox deletion is permanent |
| `color` | bidirectional | `id, color` | Change card color |
| `label` | bidirectional | `id, label` | Rename card label |
| `hidden` | bidirectional | `id, hidden` | Toggle secret/hidden text |
| `pin` | bidirectional | `id, pinned` | Toggle pin (lock position and prevent delete) |
| `lock` | bidirectional | `id, locked` | Toggle content lock (prevent editing) |
| `collapse` | bidirectional | `id, collapsed` | Toggle card collapse |
| `resize` | bidirectional | `id, width, height` | Resize card dimensions |
| `expire` | bidirectional | `id, expiresAt` | Set/clear card expiration (timestamp or null) |
| `markdown` | bidirectional | `id, markdown` | Toggle markdown rendering |
| `group` | bidirectional | `group: {id, label, cards[]}` | Create group |
| `ungroup` | bidirectional | `id` | Dissolve group |
| `removeFromGroup` | bidirectional | `id, cards[]` | Remove specific cards from group |
| `addToGroup` | bidirectional | `id, cards[]` | Add cards to existing group |
| `groupLabel` | bidirectional | `id, label` | Rename group |
| `groupResize` | bidirectional | `id, width, height` | Resize group box (persisted) |
| `clear` | bidirectional | `workspaceId` for v2 | Trash unpinned active cards in this workspace; legacy clears Inbox only |

### Version 2 commands

New pages send `{type:"hello",version:2}` before command replay. Modern commands carry `operationId`, `workspaceId` and an `expectedVersion` where applicable. `ack` confirms durable persistence; `conflict` retains a rejected edit with the current card. Replayed acknowledgements include the current canonical card so a newer peer edit cannot be rewound. Invalid or oversized messages are rejected; the WebSocket payload limit is 256 KiB and the per-connection command limit is 120 per second. Note content is limited to 128 KiB, and client messages over 240 KiB remain recoverable locally rather than entering a reconnect loop.

Workspace commands are `workspaceCreate`, `workspaceRename`, `workspaceArchive`, `workspaceRestore` and `workspaceActivate`. Tab commands are `tabOpen`, `tabClose`, `tabReorder` and `tabReopen`. Card organization uses `archive`, `restore`, `purge` and `moveWorkspace`; grouped moves remain within one destination workspace. Session patches carry camera, selection, query, filters, view, page and scroll state. Camera updates are throttled to 10 Hz and finalized durably on gesture completion. Transfer messages share progress without sharing file paths.

`GET /search` is authenticated and returns bounded metadata results with scope, kind, pin, date, collection, sort, offset and limit controls. `GET /ready` reports persistence readiness; `GET /diagnostics` reports counts, queue sizes and memory without note text, filenames or credentials. Static application assets are privately revalidated and precompressed with Brotli/gzip; originals and byte-range responses are not transformed.

## File and upload HTTP contracts

All attachment, preview and upload-reconciliation routes use the same authentication as the page. IDs resolve through validated stored names under the data directory; originals stream in constant memory and streams close on disconnect.

- `GET /files/:id`: full 200 or single-range 206, preserving content type, UTF-8 filename disposition and private caching. `HEAD` returns headers without a body. Explicit, open-ended and suffix ranges are supported; valid unsatisfiable ranges receive 416 with `Content-Range: bytes */size`. Malformed ranges, unknown units, multiple ranges and unvalidated If-Range requests receive the full 200 response. Originals are not compressed/transformed.
- `GET /previews/:id`: 200 WebP, 202 pending, 503 queue full, or 422 unavailable. The original remains independently downloadable.
- `POST /upload`: streams the original to a temporary file, flushes/renames it and persists the receipt before success. `X-Rift-Upload-Id` carries an operation UUID; `X-Rift-Workspace` binds its queued destination. Legacy upload/add is retained.
- `GET /uploads/:key`: reconciles ambiguous outcomes: 202 receiving, 200 stored/completed, 404 unknown, or 410 cancelled/deleted.
- `POST /uploads/:key/commit`: persists one card from the stored receipt and broadcasts it. A repeated commit returns the existing card. Accepts position/size and the receipt's workspace.
- `DELETE /uploads/:key`: cancels/removes an unattached upload; an already committed card returns 409 with that card. A separate card action handles its deletion.

The upload limit is 100 MiB and the rate limit 20 per minute per IP. Body/renderer inactivity detection resets on activity; receipt and commit requests have two-minute deadlines. Automatic retries reconcile by ID rather than blindly sending another original. Unattached tracked originals expire after 24 hours; cancellation and deletion retain tombstones against late duplication.

## Synchronization and durability

A command is validated, applied to an in-memory checkpoint, durably saved and only then acknowledged/broadcast. A save failure restores the checkpoint and retains referenced originals. The client keeps unacknowledged commands in a durable outbox and replays the same IDs after reconnecting. Stale version conflicts retain the local draft for explicit recovery. Purge tombstones persist independently of upload receipts.

The shared view includes tabs/order, active workspace, camera, selection, query/filter/sort, view mode, Library page and row anchor. A short view-control lease prevents gesture feedback. World rectangles, rather than device-specific screen pixels, preserve the view on different display sizes. Local dialog state and file handles are not shared navigation state.

Intermediate view changes debounce persistence by 500 ms; final gestures flush durably. Shutdown flushes pending state. Expiry and 30-day Trash retention run every 15 seconds unless maintenance is enabled. Derivatives/originals are removed only after metadata deletion is accepted and the final live/recoverable reference is gone.

## Security and deployment boundaries

The page uses a script-hash CSP, inert allowlisted Markdown and private asset revalidation. WebSocket Origin, scope, versions, payload size and command rate are validated. The native preload exposes only versioned, origin-checked download methods. Renderer Node integration is disabled; context isolation and sandboxing remain enabled. External HTTP(S) links open in the OS browser, and unexpected navigation is blocked.

This is a trusted shared workspace, not an end-to-end encrypted or per-user multi-tenant service. Read the [security notes](../SECURITY.md) and [deployment procedure](deployment.md). Back up complete state and originals; restoring older data without reconciling newer work can lose accepted edits.
