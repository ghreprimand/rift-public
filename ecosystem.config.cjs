module.exports = {
  apps: [{
    name: 'rift',
    script: 'server/index.js',
    cwd: '/opt/rift',
    env: {
      NODE_ENV: 'production',
    },
    max_memory_restart: '200M',
    autorestart: true,
  }],
};
