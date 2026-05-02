#!/bin/bash
set -euo pipefail

REMOTE="${RIFT_DEPLOY_REMOTE:?Set RIFT_DEPLOY_REMOTE, for example user@example.com}"
SSH_KEY="${RIFT_DEPLOY_SSH_KEY:-}"
RIFT_REMOTE_DIR="${RIFT_REMOTE_DIR:-/opt/rift}"
RIFT_REMOTE_USER="${RIFT_REMOTE_USER:-rift}"
SSH_CMD="ssh"
if [ -n "${SSH_KEY}" ]; then
    SSH_CMD="ssh -i ${SSH_KEY}"
fi

echo ">>> Deploying Rift..."

# Server code
rsync -av \
    -e "${SSH_CMD}" \
    server/ "${REMOTE}:${RIFT_REMOTE_DIR}/server/"

# Frontend (served by the server at /)
rsync -av \
    -e "${SSH_CMD}" \
    app/ "${REMOTE}:${RIFT_REMOTE_DIR}/app/"

# Config files
rsync -av \
    -e "${SSH_CMD}" \
    package.json ecosystem.config.cjs .env.example \
    "${REMOTE}:${RIFT_REMOTE_DIR}/"

# Fix ownership when the deploy user is allowed to do it.
${SSH_CMD} "${REMOTE}" "chown -R ${RIFT_REMOTE_USER}:${RIFT_REMOTE_USER} ${RIFT_REMOTE_DIR} 2>/dev/null || true"

# Install deps and restart the PM2 process.
${SSH_CMD} "${REMOTE}" "sudo -u ${RIFT_REMOTE_USER} bash -c 'cd ${RIFT_REMOTE_DIR} && npm install --omit=dev 2>&1 | tail -3'"
${SSH_CMD} "${REMOTE}" "sudo -u ${RIFT_REMOTE_USER} bash -c 'pm2 restart rift 2>/dev/null || pm2 start ${RIFT_REMOTE_DIR}/ecosystem.config.cjs' && echo DONE"

echo ">>> Deploy complete."
