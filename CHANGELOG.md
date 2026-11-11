# Release changes

## 1.1.0

- Named workspaces with Inbox migration, shared tabs/order, active view, search, filters, selection and camera/Library state across connected clients.
- Searchable Library, grouped moves, Archive and 30-day recoverable Trash with reference-safe permanent deletion.
- Durable client command replay, operation IDs, version conflicts and recoverable offline drafts.
- In-page create/rename forms and a destination picker, replacing unsupported desktop prompts; keyboard/cancel/validation regressions.
- Bounded nearby image previews and background thumbnails, deliberate PDF/media loading, transfer priority and cleanup.
- Streamed authenticated range/HEAD responses, queued/cancellable uploads, waiting-for-confirmation state, receipt reconciliation and duplicate-safe commits.
- Correct native save-dialog ordering, a versioned download bridge, legacy/browser compatibility and terminal progress cleanup.
- Inert allowlisted Markdown, CSP, WebSocket Origin/scope validation, private compressed assets and authenticated readiness/diagnostics.
- Node 24 baseline, locked Electron 45/Fastify 5/Sharp dependencies, generated demos and Linux/macOS integration/browser CI.
- Generic loopback desktop default, opt-in Linux graphics compatibility, location-independent launch/PM2 examples and an explicit source-only staging helper.

The data schema is version 2. Read [deployment and rollback](docs/deployment.md) before upgrading. Runtime data, credentials, deployment records and infrastructure configuration are not part of this source release.

## 1.0.0

The initial public single-board canvas, notes/attachments, grouping, media, shared-token server and desktop shell. Its source remains in this repository's public history for the optional baseline fixture.
