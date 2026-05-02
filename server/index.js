'use strict';

// Load .env from project root (one level up from server/)
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  unlinkSync, statSync, createReadStream, createWriteStream,
} = require('fs');
const { resolve, join, extname, basename } = require('path');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');

// === Config ===

const PORT = parseInt(process.env.PORT, 10) || 3300;
const HOST = process.env.HOST || '127.0.0.1';
const RIFT_TOKEN = process.env.RIFT_TOKEN || '';
const DATA_DIR = resolve(process.env.DATA_DIR || join(__dirname, '..', 'data'));
const APP_DIR = resolve(__dirname, '..', 'app');
const FILES_DIR = resolve(DATA_DIR, 'files');
const STATE_FILE = resolve(DATA_DIR, 'items.json');
const UPLOAD_MAX = 100 * 1024 * 1024; // 100 MB
const UPLOADS_PER_MINUTE = 20;

mkdirSync(FILES_DIR, { recursive: true });

// === Cached frontend ===

const cachedHTML = readFileSync(resolve(APP_DIR, 'index.html'), 'utf8');

// === State ===

const items = new Map(); // id -> item object
let groups = [];         // [{ id, label, cards, width?, height? }]

try {
  if (existsSync(STATE_FILE)) {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.items || []);
    for (const item of arr) items.set(item.id, item);
    groups = Array.isArray(raw) ? [] : (raw.groups || []);
    console.log(`Loaded ${items.size} items, ${groups.length} groups`);
  }
} catch (err) {
  console.warn('Failed to load state, starting fresh:', err.message);
}

// === Path safety ===

function safeFilePath(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const safe = basename(filename);
  if (!safe || safe === '.' || safe === '..') return null;
  const full = resolve(FILES_DIR, safe);
  if (!full.startsWith(FILES_DIR + '/') && full !== FILES_DIR) return null;
  return full;
}

// === Upload rate limiting ===

const uploadBuckets = new Map(); // ip -> { count, resetAt }

function checkUploadRate(ip) {
  const now = Date.now();
  let bucket = uploadBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60000 };
    uploadBuckets.set(ip, bucket);
  }
  if (bucket.count >= UPLOADS_PER_MINUTE) return false;
  bucket.count++;
  return true;
}

// Clean stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of uploadBuckets) {
    if (now >= bucket.resetAt) uploadBuckets.delete(ip);
  }
}, 300000);

// === Expiration timer ===

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, item] of items) {
    if (item.expiresAt && now >= item.expiresAt) {
      items.delete(id);
      if (item.kind === 'file' || item.kind === 'image') {
        const fp = safeFilePath(item.content);
        if (fp) try { unlinkSync(fp); } catch { /* ignore */ }
      }
      for (let g = groups.length - 1; g >= 0; g--) {
        const ci = groups[g].cards.indexOf(id);
        if (ci !== -1) groups[g].cards.splice(ci, 1);
        if (groups[g].cards.length === 0) groups.splice(g, 1);
      }
      broadcast({ type: 'delete', id });
      changed = true;
    }
  }
  if (changed) saveState();
}, 15000);

// === Persistence ===

let saveTimer = null;

function saveState() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushState, 500);
}

function flushState() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      items: [...items.values()],
      groups,
    }, null, 2));
  } catch (err) {
    console.error('Failed to save state:', err.message);
  }
}

process.on('SIGTERM', () => { flushState(); process.exit(0); });
process.on('SIGINT', () => { flushState(); process.exit(0); });

// === WebSocket client tracking ===

const clients = new Set();

function broadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  }
}

// === Auth ===

function checkToken(req) {
  if (!RIFT_TOKEN) return true;
  const headerToken = req.headers['x-rift-token'];
  const cookieToken = req.cookies && req.cookies.rift_token;
  return headerToken === RIFT_TOKEN || cookieToken === RIFT_TOKEN;
}

// Auth page HTML
const AUTH_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rift</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{display:flex;align-items:center;justify-content:center;
height:100vh;background:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
.auth{background:rgba(16,20,28,.95);border:1px solid rgba(255,140,0,.25);border-radius:12px;
padding:32px;backdrop-filter:blur(20px);text-align:center}
.auth h2{color:rgba(255,140,0,.6);font-size:12px;letter-spacing:3px;text-transform:uppercase;
margin-bottom:16px;font-weight:500}
input{background:#0d1117;border:1px solid #21262d;color:#e6edf3;padding:12px 16px;
border-radius:8px;font-size:15px;width:260px;outline:none;text-align:center}
input:focus{border-color:rgba(255,140,0,.5)}input::placeholder{color:#444c56}</style>
</head><body><form class="auth" method="POST" action="/auth">
<h2>Rift</h2>
<input name="token" type="password" placeholder="Enter token" autofocus>
</form></body></html>`;

// === Message validation ===

const VALID_TYPES = new Set([
  'add', 'move', 'update', 'delete', 'clear', 'color', 'label',
  'group', 'ungroup', 'removeFromGroup', 'groupLabel', 'hidden',
  'pin', 'lock', 'collapse', 'resize', 'expire', 'markdown',
  'addToGroup', 'groupResize',
]);

function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.type !== 'string' || !VALID_TYPES.has(msg.type)) return false;
  switch (msg.type) {
    case 'add':
      return !!msg.item && typeof msg.item === 'object'
        && ['text', 'file', 'image'].includes(msg.item.kind);
    case 'move':
      return typeof msg.id === 'string'
        && typeof msg.x === 'number' && typeof msg.y === 'number';
    case 'update':
      return typeof msg.id === 'string' && typeof msg.content === 'string';
    case 'delete': case 'ungroup':
      return typeof msg.id === 'string';
    case 'clear':
      return true;
    case 'color':
      return typeof msg.id === 'string';
    case 'label': case 'groupLabel':
      return typeof msg.id === 'string' && typeof msg.label === 'string';
    case 'group':
      return !!msg.group && typeof msg.group === 'object'
        && typeof msg.group.id === 'string'
        && typeof msg.group.label === 'string'
        && Array.isArray(msg.group.cards);
    case 'removeFromGroup': case 'addToGroup':
      return typeof msg.id === 'string' && Array.isArray(msg.cards);
    case 'hidden':
      return typeof msg.id === 'string' && typeof msg.hidden === 'boolean';
    case 'pin':
      return typeof msg.id === 'string' && typeof msg.pinned === 'boolean';
    case 'lock':
      return typeof msg.id === 'string' && typeof msg.locked === 'boolean';
    case 'collapse':
      return typeof msg.id === 'string' && typeof msg.collapsed === 'boolean';
    case 'resize': case 'expire': case 'groupResize':
      return typeof msg.id === 'string';
    case 'markdown':
      return typeof msg.id === 'string' && typeof msg.markdown === 'boolean';
    default:
      return false;
  }
}

// === Message handler ===

function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'add': {
      let content = msg.item.content;
      // Validate file/image content is a safe filename (prevent path traversal)
      if ((msg.item.kind === 'file' || msg.item.kind === 'image') && content) {
        if (!safeFilePath(content)) break;
      }
      const item = {
        id: msg.item.id || randomUUID(),
        kind: msg.item.kind,
        content: content,
        fileName: msg.item.fileName,
        fileSize: msg.item.fileSize,
        mimeType: msg.item.mimeType,
        color: msg.item.color,
        label: msg.item.label,
        x: msg.item.x ?? 0,
        y: msg.item.y ?? 0,
        width: msg.item.width ?? 240,
        height: msg.item.height ?? 0,
        createdAt: msg.item.createdAt ?? Date.now(),
        hidden: msg.item.hidden ?? false,
        pinned: msg.item.pinned ?? false,
        collapsed: msg.item.collapsed ?? false,
        expiresAt: msg.item.expiresAt ?? null,
        markdown: msg.item.markdown ?? false,
        locked: msg.item.locked ?? false,
      };
      items.set(item.id, item);
      saveState();
      broadcast({ type: 'add', item }, sender);
      break;
    }
    case 'move': {
      const item = items.get(msg.id);
      if (!item || item.pinned) break;
      item.x = msg.x;
      item.y = msg.y;
      saveState();
      broadcast(msg, sender);
      break;
    }
    case 'update': {
      const item = items.get(msg.id);
      if (!item) break;
      // Block content updates on file/image cards (path traversal vector)
      if (item.kind === 'file' || item.kind === 'image') break;
      item.content = msg.content;
      saveState();
      broadcast(msg, sender);
      break;
    }
    case 'delete': {
      const item = items.get(msg.id);
      if (!item || item.pinned) break;
      items.delete(msg.id);
      if (item.kind === 'file' || item.kind === 'image') {
        const fp = safeFilePath(item.content);
        if (fp) try { unlinkSync(fp); } catch { /* ignore */ }
      }
      for (let g = groups.length - 1; g >= 0; g--) {
        const ci = groups[g].cards.indexOf(msg.id);
        if (ci !== -1) groups[g].cards.splice(ci, 1);
        if (groups[g].cards.length === 0) groups.splice(g, 1);
      }
      saveState();
      broadcast(msg, sender);
      break;
    }
    case 'clear': {
      for (const [, item] of items) {
        if (item.kind === 'file' || item.kind === 'image') {
          const fp = safeFilePath(item.content);
          if (fp) try { unlinkSync(fp); } catch { /* ignore */ }
        }
      }
      items.clear();
      groups.length = 0;
      saveState();
      broadcast({ type: 'clear' }, sender);
      break;
    }
    case 'color': {
      const item = items.get(msg.id);
      if (item) { item.color = msg.color; saveState(); broadcast(msg, sender); }
      break;
    }
    case 'label': {
      const item = items.get(msg.id);
      if (item) { item.label = msg.label; saveState(); broadcast(msg, sender); }
      break;
    }
    case 'group': {
      groups.push(msg.group);
      saveState();
      broadcast(msg, sender);
      break;
    }
    case 'ungroup': {
      const gi = groups.findIndex(g => g.id === msg.id);
      if (gi !== -1) { groups.splice(gi, 1); saveState(); broadcast(msg, sender); }
      break;
    }
    case 'removeFromGroup': {
      const group = groups.find(g => g.id === msg.id);
      if (group) {
        group.cards = group.cards.filter(c => !msg.cards.includes(c));
        if (group.cards.length === 0) {
          const gi = groups.indexOf(group);
          if (gi !== -1) groups.splice(gi, 1);
        }
        saveState();
        broadcast(msg, sender);
      }
      break;
    }
    case 'groupLabel': {
      const group = groups.find(g => g.id === msg.id);
      if (group) { group.label = msg.label; saveState(); broadcast(msg, sender); }
      break;
    }
    case 'hidden': {
      const item = items.get(msg.id);
      if (item) { item.hidden = msg.hidden; saveState(); broadcast(msg, sender); }
      break;
    }
    case 'pin': {
      const item = items.get(msg.id);
      if (item) { item.pinned = msg.pinned; saveState(); broadcast(msg, sender); }
      break;
    }
    case 'collapse': {
      const item = items.get(msg.id);
      if (item) { item.collapsed = msg.collapsed; saveState(); broadcast(msg, sender); }
      break;
    }
    case 'resize': {
      const item = items.get(msg.id);
      if (item) {
        if (msg.width != null) item.width = msg.width;
        if (msg.height != null) item.height = msg.height;
        saveState();
        broadcast(msg, sender);
      }
      break;
    }
    case 'lock': {
      const item = items.get(msg.id);
      if (item) { item.locked = msg.locked; saveState(); broadcast(msg, sender); }
      break;
    }
    case 'expire': {
      const item = items.get(msg.id);
      if (item) { item.expiresAt = msg.expiresAt; saveState(); broadcast(msg, sender); }
      break;
    }
    case 'markdown': {
      const item = items.get(msg.id);
      if (item) { item.markdown = msg.markdown; saveState(); broadcast(msg, sender); }
      break;
    }
    case 'addToGroup': {
      const group = groups.find(g => g.id === msg.id);
      if (group) {
        for (const cardId of msg.cards) {
          if (!group.cards.includes(cardId)) group.cards.push(cardId);
        }
        saveState();
        broadcast(msg, sender);
      }
      break;
    }
    case 'groupResize': {
      const group = groups.find(g => g.id === msg.id);
      if (group) {
        if (msg.width != null) group.width = msg.width;
        if (msg.height != null) group.height = msg.height;
        saveState();
        broadcast(msg, sender);
      }
      break;
    }
  }
}

// === Server setup ===

async function start() {
  const fastify = require('fastify')({ logger: true });

  // Plugins (no CORS — all requests are same-origin)
  await fastify.register(require('@fastify/cookie'));
  await fastify.register(require('@fastify/formbody'));
  await fastify.register(require('@fastify/websocket'));
  await fastify.register(require('@fastify/multipart'), {
    limits: { fileSize: UPLOAD_MAX },
  });

  // --- Health check ---
  fastify.get('/health', async () => ({ status: 'ok' }));

  // --- Serve the app (cached in memory) ---
  fastify.get('/', async (req, reply) => {
    if (!checkToken(req)) {
      return reply.type('text/html').send(AUTH_HTML);
    }
    return reply.type('text/html').send(cachedHTML);
  });

  // --- Auth endpoint ---
  fastify.post('/auth', async (req, reply) => {
    const { token } = req.body || {};
    if (token === RIFT_TOKEN) {
      reply.setCookie('rift_token', token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        maxAge: 365 * 24 * 60 * 60,
      });
      return reply.redirect('/');
    }
    return reply.status(401).type('text/html').send(AUTH_HTML);
  });

  // --- WebSocket endpoint ---
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    if (!checkToken(req)) {
      socket.close(4001, 'Unauthorized');
      return;
    }

    clients.add(socket);
    console.log(`WS client connected (${clients.size} total)`);

    // Send full sync on connect
    socket.send(JSON.stringify({ type: 'sync', items: [...items.values()], groups }));

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!validateMessage(msg)) return;
        handleMessage(msg, socket);
      } catch (err) {
        console.error('WS parse error:', err.message);
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      console.log(`WS client disconnected (${clients.size} total)`);
    });
  });

  // --- File upload (rate-limited) ---
  fastify.post('/upload', async (req, reply) => {
    if (!checkToken(req)) return reply.status(401).send({ error: 'Unauthorized' });
    if (!checkUploadRate(req.ip)) return reply.status(429).send({ error: 'Rate limit exceeded' });

    const data = await req.file();
    if (!data) return reply.status(400).send({ error: 'No file provided' });

    const id = randomUUID();
    const ext = extname(data.filename || '').toLowerCase();
    const storedName = `${id}${ext}`;
    const filePath = join(FILES_DIR, storedName);

    try {
      await pipeline(data.file, createWriteStream(filePath));
    } catch (err) {
      // Clean up partial file
      try { unlinkSync(filePath); } catch { /* ignore */ }
      return reply.status(500).send({ error: 'Upload failed' });
    }
    const fileSize = statSync(filePath).size;

    return reply.send({ id, storedName, fileName: data.filename, fileSize, mimeType: data.mimetype });
  });

  // --- File download (streamed, by item ID) ---
  fastify.get('/files/:id', async (req, reply) => {
    if (!checkToken(req)) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = req.params;
    const item = items.get(id);
    if (!item || (item.kind !== 'file' && item.kind !== 'image')) {
      return reply.status(404).send({ error: 'Not found' });
    }

    const filePath = safeFilePath(item.content);
    if (!filePath || !existsSync(filePath)) {
      return reply.status(404).send({ error: 'File not found on disk' });
    }

    const stat = statSync(filePath);
    return reply
      .header('Content-Disposition', `inline; filename="${encodeURIComponent(item.fileName || 'file')}"`)
      .header('Content-Length', stat.size)
      .header('Cache-Control', 'private, max-age=86400')
      .type(item.mimeType || 'application/octet-stream')
      .send(createReadStream(filePath));
  });

  // --- Start listening ---
  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Rift server listening on ${HOST}:${PORT}`);
    console.log(`  Data dir: ${DATA_DIR}`);
    console.log(`  Auth:     ${RIFT_TOKEN ? 'token required' : 'disabled'}`);
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
