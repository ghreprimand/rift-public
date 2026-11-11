#!/bin/bash
set -euo pipefail
usage() {
  cat <<'HELP'
Usage: ./deploy.sh --dry-run | --stage

Required: RIFT_DEPLOY_REMOTE (SSH host/alias, optionally user@host)
Optional: RIFT_REMOTE_DIR (default /opt/rift), RIFT_DEPLOY_SSH_KEY

--dry-run prints the tracked source manifest and intended release directory.
--stage copies source into that new directory. It does not install dependencies,
activate code, copy data/secrets, change ownership, or restart services.
Read docs/deployment.md before activating a release.
HELP
}
if [ "$#" -eq 0 ] || [ "${1:-}" = '--help' ]; then usage; exit 0; fi
if [ "$#" -ne 1 ] || { [ "$1" != '--stage' ] && [ "$1" != '--dry-run' ]; }; then usage >&2; exit 2; fi
remote="${RIFT_DEPLOY_REMOTE:?Set RIFT_DEPLOY_REMOTE to your SSH host or alias}"
remote_root="${RIFT_REMOTE_DIR:-/opt/rift}"
if [[ ! "$remote" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$ ]]; then printf 'Use an SSH host/alias without shell characters.\n' >&2; exit 2; fi
if [[ ! "$remote_root" =~ ^/[a-zA-Z0-9_./-]+$ ]] || [[ "$remote_root" = / ]] || [[ "/${remote_root}/" = *'/../'* ]] || [[ "/${remote_root}/" = *'/./'* ]]; then
  printf 'RIFT_REMOTE_DIR must be a non-root absolute directory without traversal or shell characters.\n' >&2; exit 2
fi
cd "$(dirname "$0")"
release="${remote_root%/}/releases/$(date -u +%Y%m%dT%H%M%SZ)"
manifest=$(mktemp)
trap 'rm -f "$manifest"' EXIT
# Only tracked application/config files are eligible; never sync a checkout wholesale.
git ls-files -z -- app server package.json package-lock.json ecosystem.config.cjs .env.example .nvmrc > "$manifest"
if [ ! -s "$manifest" ]; then printf 'No tracked application source found.\n' >&2; exit 2; fi
while IFS= read -r -d '' file; do
  if [ ! -f "$file" ] || [ -L "$file" ]; then printf 'Source entries must be regular files: %s\n' "$file" >&2; exit 2; fi
done < "$manifest"
printf 'Target: %s:%s\n' "$remote" "$release"
if [ "$1" = '--dry-run' ]; then
  tr '\0' '\n' < "$manifest"
  printf 'Dry run only; no SSH connection or remote write performed.\n'
  exit 0
fi
ssh_args=()
if [ -n "${RIFT_DEPLOY_SSH_KEY:-}" ]; then ssh_args=(-i "$RIFT_DEPLOY_SSH_KEY"); fi
printf -v rsync_ssh '%q ' ssh "${ssh_args[@]}"
ssh "${ssh_args[@]}" "$remote" "umask 077; mkdir -p -- '$release'"
rsync -a --from0 --files-from="$manifest" -e "$rsync_ssh" ./ "$remote:$release/"
printf 'Source staged. Install locked dependencies and follow docs/deployment.md.\nNo live files or services were changed.\n'
