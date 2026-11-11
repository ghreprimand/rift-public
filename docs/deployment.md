# Deployment, upgrades and rollback

Use your own hostnames, accounts, directories and backup system. Every host/path example here is a placeholder or conventional layout. This repository does not configure a hosted service, install a global hotkey or change networking automatically.

## Prepare a server

Use a dedicated service account, Node 24 or newer, private persistent storage and an HTTPS reverse proxy/private network. Keep `HOST=127.0.0.1`. A typical layout is `/srv/rift/releases/<release>` for code and `/srv/rift/shared/data` for data, but choose your own absolute paths.

In a prepared release directory owned by the service account:

```bash
node --version
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --omit=dev
node -e 'require("sharp"); console.log("Sharp loaded")'
cp .env.example .env
chmod 600 .env
```

Edit `.env` with a long random `RIFT_TOKEN`, an absolute persistent `DATA_DIR`, and any required `RIFT_ALLOWED_ORIGINS`. For an upgrade, preserve the existing secret/data path instead of generating new authentication. Do not omit optional dependencies, copy a real `.env` into Git, or store application data under a disposable release directory.

The server needs no Electron binary or FFmpeg. Browser tests and the demo need their additional fixture tools. Run the generated-data tests in a separate checkout/staging environment before activation; never point fixtures at real attachments or reuse a production token.

`ecosystem.config.cjs` resolves its own checkout directory. `RIFT_APP_DIR` optionally selects another root, and `RIFT_NODE` explicitly selects the Node interpreter. Verify the actual interpreter; a process manager's Node can differ from an interactive shell. Use a service account and configure restart persistence deliberately; PM2 installation/startup integration is not performed by this repository.

## Optional staging helper

```bash
RIFT_DEPLOY_REMOTE=rift@server.example.invalid \
RIFT_REMOTE_DIR=/srv/rift \
./deploy.sh --stage
```

The example host is not real. Set your own SSH host/alias and directory. `RIFT_DEPLOY_SSH_KEY` is optional; otherwise SSH uses its normal configuration. The remote account must be able to create the selected release directory. `--dry-run` shows the intended copy without modifying the remote server. Run `./deploy.sh --help` for the inputs.

The helper copies an explicit source/lock/config allowlist into a timestamped release directory. It does not copy `.env`, data, Git/workflow history or dependencies. It does not install dependencies, change ownership, expose a port, activate a release or restart a service. This replaces the old live rsync/restart helper: a schema-changing release requires a controlled activation.

## Activate an upgrade

1. Inspect the existing schema, runtime and current receiving uploads. Stage the new application and locked dependencies while the old service remains active.
2. Schedule a maintenance window. Quiesce writes, stop only Rift, and create a consistent private backup of complete data, authentication configuration, old code/lock, installed dependencies and process-manager settings. Record original/card/group identities and hashes. Retain that material outside any disposable release directory.
3. Preserve/configure the existing absolute data path and secret in the new release. Start with the maintenance gate explicitly included in the process-manager configuration. For PM2, from the new release directory:

```bash
RIFT_MAINTENANCE=1 pm2 startOrRestart ./ecosystem.config.cjs --update-env
```

The example config writes the gate into `env`. Do not rely solely on a shell-only override to an unrelated PM2 config; existing process environments can be retained. When selecting `RIFT_NODE` or `RIFT_APP_DIR`, pass the same intended values on both maintenance and live activation commands.

4. Verify authenticated `/ready` reports schema 2 and maintenance true. `/health` remains available without credentials, but user pages, uploads, files and WebSockets must return 503. Maintenance pauses expiry and upload cleanup. Validate original hashes, card/group identities, authentication and migration before allowing clients to write.
5. Start the explicit live configuration:

```bash
RIFT_MAINTENANCE=0 pm2 startOrRestart ./ecosystem.config.cjs --update-env
```

6. Verify authenticated readiness, unauthorized rejection, exact original ranges/HEAD, bounded thumbnails, upload confirmation, two-client synchronization and reconnect. Inspect the actual negotiated protocol rather than assuming HTTP/2. Save the PM2 process list with `pm2 save` only after successful activation and configure its service startup for your environment.
7. Reload/reopen existing pages. Deliver/restart a native desktop update separately only when its native changes are intended and platform checks are complete.

Do not log tokens, original filenames, note content or attachment bodies in rollout reports. A readiness response is not a substitute for data integrity and transfer checks.

## Schema and mixed versions

Startup preserves an unversioned original board in a one-time `items.pre-workspaces-v1.json`, then assigns original cards/groups to Inbox and persists schema 2. It retains IDs, originals, filenames, MIME types, positions, group relationships and expiry. Workspaces, shared session, operation receipts and tombstones are stored alongside the cards.

Deploy server and served assets together. New pages need the current routes. Existing single-board pages remain restricted to Inbox until reloaded. Their old deletion/clear commands keep permanent semantics. Updated pages use recoverable Trash and protocol version 2. Native bridge version 2 adds direct streamed status/cancellation; older wrappers may use the compatible browser save picker. A page update does not replace an installed wrapper.

## Backups and restore

Back up the complete `DATA_DIR`, authentication configuration and matched application/runtime/lock. Include `uploads.json` and transfer bookkeeping as well as `items.json` and `files/`; previews can be regenerated. Keep private permissions, copies outside the host, tested restore procedures and a retention policy suitable for the workspace. No automatic backup job or off-site destination is supplied.

A consistent snapshot requires stopping/quiescing writes. Before any restore, preserve the current state and originals. Inspect archive paths and reconstruct a matched data/code version in a private location. Reconcile every accepted change since the chosen snapshot. Verify authentication, original hashes and two-client synchronization before reopening traffic.

## Rollback

Before user traffic has been accepted by a new release, restore the matching stopped-service snapshot and preceding code/dependencies if activation fails. After traffic reopens, do not automatically restore old data: preserve the current schema/session/originals and reconcile new changes. Prefer a forward fix when reverting would lose newer workspaces or edits.

A page-only rollback restores preceding app assets and restarts the server while retaining current data. A complete code rollback must keep source, dependency lock/runtime and schema compatible. Old single-board code must not run against schema-2 ownership/session state. Retain the full current data copy even when an older compatible set is restored.

## Desktop/platform limits

Set `RIFT_SERVER_URL` in each desktop's launch environment. HTTP/2 remains enabled unless `RIFT_HTTP1=1` is explicitly selected as a temporary compatibility option. This does not repair a degraded transport path.

Linux defaults to Electron's normal platform; opt into Wayland or ANGLE/Vulkan only if appropriate. Select a working portal backend for native save dialogs rather than replacing the desktop's portal configuration blindly. The launcher requires npm on PATH; it does not install or select Node for the operating system.

Linux/macOS CI use generated fixtures. A physical Mac save-dialog/packaging test and hardware/window-manager smoke test are separate release checks. No packaged application or automatic client updater is supplied by the repository.
