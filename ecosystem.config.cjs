const path = require('node:path');
const root = path.resolve(process.env.RIFT_APP_DIR || __dirname);
module.exports = {
  apps: [{
    name: 'rift',
    script: path.join(root, 'server/index.js'),
    cwd: root,
    interpreter: process.env.RIFT_NODE || process.execPath,
    env: {
      NODE_ENV: 'production',
      // Set the gate in the selected configuration; PM2 can retain shell-only overrides.
      RIFT_MAINTENANCE: process.env.RIFT_MAINTENANCE || '0',
      ...(process.env.RIFT_ALLOWED_ORIGINS !== undefined && { RIFT_ALLOWED_ORIGINS: process.env.RIFT_ALLOWED_ORIGINS }),
    },
    max_memory_restart: '200M',
    autorestart: true,
  }],
};
