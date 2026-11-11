'use strict';

// Load .env from project root (one level up from server/)
if (process.env.RIFT_SKIP_DOTENV !== '1') {
  require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
}

const {
  readFileSync, mkdirSync, existsSync, unlinkSync, copyFileSync, chmodSync,
} = require('fs');
const { resolve, join, basename } = require('path');
const { randomUUID, createHash } = require('crypto');
const { sendFile } = require('./file-response');
const { Thumbnails } = require('./thumbnails');
const { UploadStore, atomicJSON } = require('./upload-store');
const { Workspaces } = require('./workspaces');
const { asset, sendAsset } = require('./assets');

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
const cachedApp = asset(cachedHTML, 'text/html');
const cachedAssets = new Map(['transfers.js', 'markup.js', 'outbox.js', 'workspace-ui.js', 'workspaces.css'].map(file => [file, asset(readFileSync(join(APP_DIR, file)), file.endsWith('.css') ? 'text/css' : 'application/javascript')]));

// === State ===

const items = new Map(); // id -> item object
let groups = [];         // [{ id, label, cards, width?, height? }]
let operations = {};
let rawState = {};
let pendingBroadcasts = null;
let pendingAttachmentCleanup = null;
const thumbnails = new Thumbnails(join(DATA_DIR, 'previews'), content => {
  for (const item of items.values()) if (item.content === content) broadcast({ type: 'previewReady', id: item.id });
});

try {
  if (existsSync(STATE_FILE)) {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    rawState = Array.isArray(raw) ? { items: raw } : raw;
    const arr = Array.isArray(raw) ? raw : (raw.items || []);
    for (const item of arr) items.set(item.id, item);
    groups = Array.isArray(raw) ? [] : (raw.groups || []);
    operations = Array.isArray(raw) ? {} : (raw.operations || {});
    console.log(`Loaded ${items.size} items, ${groups.length} groups`);
  }
} catch (err) {
  // Cleanup must never interpret unreadable board state as an empty board.
  console.error('Failed to load state; refusing to start:', err.message);
  throw err;
}
if (existsSync(STATE_FILE) && !rawState.schemaVersion && !existsSync(join(DATA_DIR, 'items.pre-workspaces-v1.json'))) {
  copyFileSync(STATE_FILE, join(DATA_DIR, 'items.pre-workspaces-v1.json'));
  chmodSync(join(DATA_DIR, 'items.pre-workspaces-v1.json'), 0o600);
}
const boards = new Workspaces(rawState, items, () => groups);
const uploads = new UploadStore(DATA_DIR, items);

// === Path safety ===

function safeFilePath(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const safe = basename(filename);
  if (filename !== safe || filename.includes('\\')) return null;
  if (!safe || safe === '.' || safe === '..') return null;
  const full = resolve(FILES_DIR, safe);
  if (!full.startsWith(FILES_DIR + '/') && full !== FILES_DIR) return null;
  return full;
}

function deleteAttachment(item) {
  if (item.kind !== 'file' && item.kind !== 'image') return;
  if (pendingAttachmentCleanup) { pendingAttachmentCleanup.push({ ...item }); return; }
  uploads.remove(item.content, item.id);
  if ([...items.values()].some(other => other.id !== item.id && other.content === item.content)) return;
  const fp = safeFilePath(item.content);
  if (fp) try { unlinkSync(fp); } catch { /* ignore */ }
  if (typeof item.content === 'string') thumbnails.remove(item.content);
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
  if (process.env.RIFT_MAINTENANCE === '1') return;
  const expired = [...items.values()].filter(item => (item.expiresAt && now >= item.expiresAt) || (item.trashedAt && now - item.trashedAt >= 30 * 86400000));
  if (!expired.length) return;
  const before = JSON.stringify({ items: [...items.values()], groups, purged: boards.purged });
  for (const item of expired) {
    items.delete(item.id); boards.purged[item.id] = now;
    for (let g = groups.length - 1; g >= 0; g--) {
      groups[g].cards = groups[g].cards.filter(id => id !== item.id);
      if (!groups[g].cards.length) groups.splice(g, 1);
    }
  }
  try { flushState(true); }
  catch {
    const restored = JSON.parse(before); items.clear(); for (const item of restored.items) items.set(item.id, item);
    groups = restored.groups; boards.purged = Object.assign(Object.create(null), restored.purged); return;
  }
  for (const item of expired) {
    try { deleteAttachment(item); } catch { console.error('Expired attachment cleanup needs retry'); }
    broadcast({ type: 'delete', id: item.id, workspaceId: item.workspaceId });
  }
  catalogChanged();
}, 15000);

// === Persistence ===

let saveTimer = null;
let persistenceError = null;

function saveState() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushState, 500);
}

function flushState(strict = false) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    atomicJSON(STATE_FILE, {
      items: [...items.values()],
      groups,
      operations,
      ...boards.state(),
    });
    persistenceError = null;
  } catch (err) {
    persistenceError = 'State could not be saved';
    console.error('Failed to save state:', err.message);
    if (strict) throw err;
  }
}

process.on('SIGTERM', () => { flushState(); process.exit(0); });
process.on('SIGINT', () => { flushState(); process.exit(0); });

// === WebSocket client tracking ===

const clients = new Set();
const transfers = new Map();

function broadcast(msg, exclude) {
  if (pendingBroadcasts) { pendingBroadcasts.push({ msg, exclude }); return; }
  const workspaceId = msg.workspaceId || msg.item?.workspaceId || items.get(msg.id)?.workspaceId || 'inbox';
  for (const client of clients) {
    if ((client !== exclude || client.modern) && client.readyState === 1) {
      if (msg.type === 'sync') { client.send(JSON.stringify({ ...boards.snapshot(client.modern), clientId: client.clientId, ...(client.modern && { transfers: [...transfers.values()] }) })); continue; }
      if (client.modern && !['session', 'catalog', 'transfer'].includes(msg.type) && workspaceId !== boards.session.activeWorkspaceId) continue;
      if (!client.modern && (workspaceId !== 'inbox' || ['session', 'catalog', 'transfer'].includes(msg.type))) continue;
      client.send(JSON.stringify({ ...msg, workspaceId }));
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
      if (items.has(msg.item.id)) break;
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
        workspaceId: msg.workspaceId || 'inbox',
        version: 1,
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
      if (sender?.modern) {
        item.trashedAt = Date.now();
        broadcast(msg, sender);
        saveState();
        break;
      }
      items.delete(msg.id);
      boards.purged[msg.id] = Date.now();
      deleteAttachment(item);
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
      const removed = [...items.values()].filter(item => item.workspaceId === (msg.workspaceId || 'inbox') && !item.pinned && !item.trashedAt);
      if (sender?.modern) {
        for (const item of removed) { item.trashedAt = Date.now(); item.version++; }
        saveState(); broadcast({ type: 'sync' }); break;
      }
      for (const item of removed) items.delete(item.id);
      for (const item of removed) boards.purged[item.id] = Date.now();
      for (const item of removed) deleteAttachment(item);
      groups = groups.filter(group => group.workspaceId !== (msg.workspaceId || 'inbox'));
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
      if (!groups.some(group => group.id === msg.group.id)) groups.push({ ...msg.group, workspaceId: msg.workspaceId || 'inbox', version: 1 });
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

const WORKSPACE_COMMANDS = new Set(['workspaceCreate', 'workspaceRename', 'workspaceArchive', 'workspaceRestore', 'workspaceActivate', 'tabOpen', 'tabClose', 'tabReopen', 'tabReorder']);
const idString = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const text = (value, limit) => typeof value === 'string' && value.length <= limit;
const finite = (value, min = -1e7, max = 1e7) => Number.isFinite(value) && value >= min && value <= max;
function reject(message) { throw new Error(message); }
function validateScoped(message, modern) {
  const workspaceId = modern ? message.workspaceId || boards.session.activeWorkspaceId : 'inbox';
  if (!boards.exists(workspaceId)) reject('Workspace is unavailable');
  message.workspaceId = workspaceId;
  const target = items.get(message.id) || groups.find(group => group.id === message.id);
  if (target && target.workspaceId !== workspaceId) reject('Card or group belongs to another workspace');
  if (message.expectedVersion !== undefined && (!Number.isSafeInteger(message.expectedVersion) || message.expectedVersion !== (target?.version || 0))) reject('This card changed on another device. Your draft was retained.');
  if (target?.pinned && ['move', 'delete', 'purge', 'color'].includes(message.type)) reject('Unpin this card first');
  if (target?.locked && ['update', 'label'].includes(message.type)) reject('Unlock this card first');
  if (message.type === 'purge' && !target?.trashedAt) reject('Move this card to Trash before permanent deletion');
  if (message.type === 'add') {
    const item = message.item;
    if (!item || !idString(item.id) || !['text', 'file', 'image'].includes(item.kind) || !text(item.content, 128 * 1024)
        || !finite(item.x ?? 0) || !finite(item.y ?? 0) || !finite(item.width ?? 240, 160, 4000) || !finite(item.height ?? 0, 0, 10000)) reject('Invalid card fields');
    if (items.has(item.id) && items.get(item.id).workspaceId !== workspaceId) reject('Card ID already belongs to another workspace');
    if (Object.hasOwn(boards.purged, item.id)) reject('This card was permanently deleted');
    if (item.kind !== 'text' && (!safeFilePath(item.content) || !existsSync(safeFilePath(item.content)))) reject('Original file is unavailable');
    for (const name of ['label', 'fileName', 'mimeType']) if (item[name] !== undefined && !text(item[name], name === 'fileName' ? 1024 : 200)) reject('Invalid card metadata');
    if (item.mimeType !== undefined && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(item.mimeType)) reject('Invalid MIME type');
    for (const name of ['hidden', 'locked', 'pinned', 'collapsed', 'markdown']) if (item[name] !== undefined && typeof item[name] !== 'boolean') reject('Invalid card flags');
    if (item.createdAt !== undefined && !finite(item.createdAt, 0, Number.MAX_SAFE_INTEGER)) reject('Invalid card timestamp');
    if (item.fileSize !== undefined && (!Number.isSafeInteger(item.fileSize) || item.fileSize < 0 || item.fileSize > UPLOAD_MAX)) reject('Invalid file size');
  } else if (message.type === 'group') {
    if (!message.group || !idString(message.group.id) || !text(message.group.label, 200)) reject('Invalid group');
    if (groups.some(group => group.id === message.group.id && group.workspaceId !== workspaceId)) reject('Group ID belongs to another workspace');
  } else if (message.type !== 'clear' && message.type !== 'moveWorkspace' && !target) reject('Card or group no longer exists');
  if (message.id !== undefined && !idString(message.id)) reject('Invalid ID');
  if (message.type === 'move' && (!finite(message.x) || !finite(message.y))) reject('Invalid coordinates');
  if (message.type === 'update' && (!text(message.content, 128 * 1024) || target.kind !== 'text')) reject('Only note text can be edited');
  if (['label', 'groupLabel'].includes(message.type) && !text(message.label, 200)) reject('Invalid label');
  if (message.type === 'color' && !['', 'red', 'green', 'blue', 'purple', 'orange', 'pink'].includes(message.color)) reject('Invalid color');
  if (message.type === 'expire' && message.expiresAt !== null && !finite(message.expiresAt, 0, Number.MAX_SAFE_INTEGER)) reject('Invalid expiry');
  for (const [type, field] of Object.entries({ hidden: 'hidden', pin: 'pinned', lock: 'locked', collapse: 'collapsed', markdown: 'markdown', archive: 'archived' })) {
    if (message.type === type && typeof message[field] !== 'boolean') reject('Invalid flag');
  }
  if (message.type === 'resize' && ((message.width !== undefined && !finite(message.width, 160, 4000)) || (message.height !== undefined && !finite(message.height, 0, 10000)) || (message.width === undefined && message.height === undefined))) reject('Invalid card size');
  if (message.type === 'groupResize' && [message.width, message.height].some(value => value !== null && !finite(value, 0, 1e7))) reject('Invalid group size');
  const members = message.group?.cards || (['addToGroup', 'removeFromGroup', 'moveWorkspace'].includes(message.type) ? message.cards : null);
  if (members && (!Array.isArray(members) || members.length > 5000 || new Set(members).size !== members.length
      || members.some(id => !idString(id) || !items.has(id) || items.get(id).workspaceId !== workspaceId))) reject('Group members must belong to this workspace');
  if (['group', 'addToGroup', 'removeFromGroup', 'moveWorkspace'].includes(message.type) && !members) reject('Missing card selection');
  return target;
}
function applyOrganization(message) {
  const item = items.get(message.id);
  if (message.type === 'archive') item.archived = message.archived;
  else if (message.type === 'restore') delete item.trashedAt;
  else if (message.type === 'purge') {
    if (!item.trashedAt) reject('Move this card to Trash before permanent deletion');
    items.delete(item.id); boards.purged[item.id] = Date.now(); deleteAttachment(item);
    for (const group of groups) group.cards = group.cards.filter(id => id !== item.id);
  } else if (message.type === 'moveWorkspace') {
    if (!boards.exists(message.destination) || boards.exists(message.destination).archived) reject('Destination workspace is unavailable');
    const ids = new Set(message.cards);
    let changed = true;
    while (changed) {
      changed = false;
      for (const group of groups) if (group.workspaceId === message.workspaceId && group.cards.some(id => ids.has(id))) {
        for (const id of group.cards) if (items.has(id) && !ids.has(id)) { ids.add(id); changed = true; }
      }
    }
    for (const id of ids) if (items.get(id).pinned) reject('Unpin all cards in this group before moving it');
    for (const id of ids) { items.get(id).workspaceId = message.destination; items.get(id).version++; }
    for (const group of groups) if (group.cards.some(id => ids.has(id))) group.workspaceId = message.destination;
    boards.open(message.destination);
    boards.session.views[message.destination].selection = [...ids];
  }
  saveState(); broadcast({ type: 'sync' });
}
function catalogChanged() { broadcast({ type: 'catalog', workspaces: boards.catalog() }); }

// === Server setup ===

async function start() {
  if (rawState.schemaVersion !== 2) flushState(true);
  const fastify = require('fastify')({ logger: { serializers: { req(request) {
    return { method: request.method, url: String(request.url || '').split('?')[0].replace(/\/(files|previews|uploads)\/[^/]+/g, '/$1/:id') };
  } } } });
  const maintenance = process.env.RIFT_MAINTENANCE === '1';
  fastify.addHook('onRequest', async (request, reply) => {
    if (maintenance && !['/health', '/ready', '/diagnostics'].includes(String(request.url).split('?')[0])) {
      return reply.code(503).header('Retry-After', '5').send({ error: 'Rift maintenance is in progress. Reconnect shortly.' });
    }
  });

  // Plugins (no CORS — all requests are same-origin)
  await fastify.register(require('@fastify/cookie'));
  await fastify.register(require('@fastify/formbody'));
  await fastify.register(require('@fastify/websocket'), { options: { maxPayload: 256 * 1024 } });
  await fastify.register(require('@fastify/multipart'), {
    limits: { fileSize: UPLOAD_MAX },
  });

  // --- Health check ---
  fastify.get('/health', async () => ({ status: 'ok' }));
  fastify.get('/ready', async (req, reply) => {
    if (!checkToken(req)) return reply.code(401).send({ error: 'Unauthorized' });
    return reply.code(persistenceError ? 503 : 200).send({ status: persistenceError ? 'degraded' : 'ready', schemaVersion: 2, maintenance, error: persistenceError });
  });
  fastify.get('/diagnostics', async (req, reply) => {
    if (!checkToken(req)) return reply.code(401).send({ error: 'Unauthorized' });
    return { items: items.size, workspaces: boards.workspaces.length, connections: clients.size, pendingUploads: uploads.active.size,
      thumbnailQueue: thumbnails.queue.size, thumbnailWorker: !!thumbnails.active, uploadReceipts: Object.keys(uploads.records).length,
      memoryBytes: process.memoryUsage().rss, persistence: persistenceError || 'ok' };
  });
  const scriptHashes = [...cachedHTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'");
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    if (String(reply.getHeader('content-type') || '').includes('text/html')) reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' " + scriptHashes.join(' ') + "; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; object-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return payload;
  });

  // --- Serve the app (cached in memory) ---
  fastify.get('/', async (req, reply) => {
    if (!checkToken(req)) {
      return reply.type('text/html').send(AUTH_HTML);
    }
    return sendAsset(req, reply, cachedApp);
  });
  fastify.get('/transfers.js', async (req, reply) => {
    if (!checkToken(req)) return reply.code(401).send();
    return sendAsset(req, reply, cachedAssets.get('transfers.js'));
  });
  fastify.get('/markup.js', async (req, reply) => {
    if (!checkToken(req)) return reply.code(401).send();
    return sendAsset(req, reply, cachedAssets.get('markup.js'));
  });
  fastify.get('/outbox.js', async (req, reply) => {
    if (!checkToken(req)) return reply.code(401).send();
    return sendAsset(req, reply, cachedAssets.get('outbox.js'));
  });
  for (const [file, mime] of [['workspace-ui.js', 'application/javascript'], ['workspaces.css', 'text/css']]) {
    fastify.get('/' + file, async (req, reply) => {
      if (!checkToken(req)) return reply.code(401).send();
      return sendAsset(req, reply, cachedAssets.get(file));
    });
  }
  fastify.get('/search', async (req, reply) => {
    if (!checkToken(req)) return reply.code(401).send({ error: 'Unauthorized' });
    reply.header('Cache-Control', 'no-store');
    const query = req.query || {};
    const workspaceId = query.scope === 'all' ? undefined : query.workspaceId || boards.session.activeWorkspaceId;
    if (workspaceId && !boards.exists(workspaceId)) return reply.code(404).send({ error: 'Workspace is unavailable' });
    return boards.search({ ...query, workspaceId, pinned: query.pinned === 'true' });
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
    if (req.headers.origin) {
      const allowed = String(process.env.RIFT_ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean);
      try {
        const origin = new URL(req.headers.origin);
        if (!['https:', 'http:'].includes(origin.protocol) || (origin.host !== req.headers.host && !allowed.includes(origin.origin))) { socket.close(4003, 'Origin is not allowed'); return; }
      } catch { socket.close(4003, 'Invalid origin'); return; }
    } else if (RIFT_TOKEN && req.headers['x-rift-token'] !== RIFT_TOKEN) { socket.close(4003, 'Native clients require token authentication'); return; }

    clients.add(socket);
    socket.clientId = randomUUID();
    socket.modern = false;
    console.log(`WS client connected (${clients.size} total)`);

    // Send full sync on connect
    socket.send(JSON.stringify(boards.snapshot(false)));

    let messageWindow = { count: 0, reset: Date.now() + 1000 };
    socket.on('message', (raw) => {
      let msg;
      let checkpoint;
      try {
        if (Date.now() > messageWindow.reset) messageWindow = { count: 0, reset: Date.now() + 1000 };
        if (raw.length > 256 * 1024) reject('Oversized message');
        msg = JSON.parse(raw.toString());
        if (++messageWindow.count > 120) reject('Too many messages; retry after a pause');
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) reject('Invalid command');
        if (msg.type === 'hello' && msg.version === 2) {
          socket.modern = true;
          socket.send(JSON.stringify({ ...boards.snapshot(true), clientId: socket.clientId, transfers: [...transfers.values()] }));
          return;
        }
        if (msg.type === 'transfer' || msg.type === 'transferCancel') {
          if (!socket.modern || !/^[0-9a-f-]{36}$/.test(msg.id || '')) reject('Invalid transfer');
          if (msg.type === 'transferCancel') {
            const transfer = transfers.get(msg.id);
            if (transfer && transfer.canCancel) { transfer.state = 'cancelRequested'; transfer.message = 'Cancellation requested…'; broadcast({ type: 'transfer', transfer }); }
            return;
          }
          if (!boards.exists(msg.workspaceId) || !['upload', 'download'].includes(msg.kind) || !text(msg.name, 1024) || !text(msg.message, 500)
              || !['queued', 'uploading', 'waiting', 'completed', 'failed', 'cancelled', 'downloading', 'choosing'].includes(msg.state)) reject('Invalid transfer status');
          const transfer = { id: msg.id, owner: socket.clientId, workspaceId: msg.workspaceId, kind: msg.kind, name: msg.name, message: msg.message, state: msg.state, canCancel: !!msg.canCancel, updatedAt: Date.now() };
          transfers.set(msg.id, transfer);
          if (transfers.size > 100) for (const [id, value] of transfers) if (['completed', 'cancelled', 'failed'].includes(value.state)) { transfers.delete(id); break; }
          broadcast({ type: 'transfer', transfer });
          return;
        }
        if (msg.type === 'session') {
          if (!socket.modern) reject('Reload Rift to share the session');
          if (boards.updateView(msg, socket.clientId)) {
            broadcast({ ...boards.sessionMessage(), sourceClientId: socket.clientId, viewSequence: msg.viewSequence });
            if (msg.release) flushState(true); else saveState();
          } else socket.send(JSON.stringify(boards.sessionMessage()));
          return;
        }
        if (msg.operationId !== undefined && (typeof msg.operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(msg.operationId))) reject('Invalid operation ID');
        if (msg.operationId && Object.hasOwn(operations, msg.operationId)) {
          const receipt = operations[msg.operationId];
          const item = items.get(receipt.id);
          socket.send(JSON.stringify({ type: 'ack', operationId: msg.operationId, ...receipt, appliedVersion: receipt.version,
            version: item?.version || receipt.version, replay: true, item, missing: !!receipt.id && !item && !groups.some(group => group.id === receipt.id) }));
          return;
        }
        checkpoint = JSON.stringify({ items: [...items.values()], groups, operations, ...boards.state() });
        pendingBroadcasts = []; pendingAttachmentCleanup = [];
        const workspaceCommand = WORKSPACE_COMMANDS.has(msg.type);
        const organizationCommand = ['archive', 'restore', 'purge', 'moveWorkspace'].includes(msg.type);
        if (workspaceCommand) {
          if (!socket.modern) reject('Reload Rift to use workspaces');
          boards.workspaceCommand(msg); broadcast({ type: 'sync' });
        } else {
          if (organizationCommand && !socket.modern) reject('Reload Rift to organize cards');
          if (!organizationCommand && !validateMessage(msg)) reject('Invalid command fields');
          const target = validateScoped(msg, socket.modern);
          if (target) { target.version = (target.version || 0) + 1; msg.version = target.version; }
          if (organizationCommand) applyOrganization(msg); else handleMessage(msg, socket);
        }
        for (const [workspaceId, view] of Object.entries(boards.session.views)) view.selection = view.selection.filter(id => items.has(id) && items.get(id).workspaceId === workspaceId && !items.get(id).trashedAt);
        boards.revision++;
        if (msg.operationId) {
          const target = items.get(msg.id || msg.item?.id) || groups.find(group => group.id === (msg.id || msg.group?.id));
          operations[msg.operationId] = { id: target?.id, version: target?.version, at: Date.now(), revision: boards.revision };
          const keys = Object.keys(operations);
          if (keys.length > 10000) delete operations[keys[0]];
        }
        flushState(true);
        const events = pendingBroadcasts, cleanup = pendingAttachmentCleanup;
        pendingBroadcasts = null; pendingAttachmentCleanup = null; checkpoint = null;
        for (const event of events) broadcast(event.msg, event.exclude);
        for (const item of cleanup) {
          try { deleteAttachment(item); } catch { console.error('Committed attachment cleanup needs retry'); }
        }
        if (msg.operationId) socket.send(JSON.stringify({ type: 'ack', operationId: msg.operationId, ...operations[msg.operationId] }));
        catalogChanged();
      } catch (error) {
        if (checkpoint) {
          pendingBroadcasts = null; pendingAttachmentCleanup = null;
          const before = JSON.parse(checkpoint);
          items.clear(); for (const item of before.items) items.set(item.id, item);
          groups = before.groups; operations = before.operations;
          boards.workspaces = before.workspaces; boards.session = before.session; boards.revision = before.revision;
          boards.purged = Object.assign(Object.create(null), before.purgedItems || {});
          if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        }
        socket.send(JSON.stringify({ type: 'conflict', operationId: msg?.operationId, error: error.message,
          item: items.get(msg?.id) || undefined }));
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      for (const transfer of transfers.values()) if (transfer.owner === socket.clientId && !['completed', 'cancelled', 'failed'].includes(transfer.state)) {
        transfer.message = 'Connection lost · awaiting transfer status';
        broadcast({ type: 'transfer', transfer });
      }
      console.log(`WS client disconnected (${clients.size} total)`);
    });
  });

  // --- File upload (rate-limited) ---
  fastify.post('/upload', async (req, reply) => {
    if (!checkToken(req)) return reply.status(401).send({ error: 'Unauthorized' });
    const key = req.headers['x-rift-upload-id'] || randomUUID();
    const workspaceId = req.headers['x-rift-workspace'] || 'inbox';
    if (!boards.exists(workspaceId)) return reply.code(404).send({ error: 'Workspace is unavailable' });
    if (!/^[0-9a-f-]{36}$/.test(key)) return reply.code(400).send({ error: 'Invalid upload ID' });
    if (uploads.cancelled(key)) return reply.code(410).send({ error: 'Upload cancelled or deleted' });
    if (uploads.active.has(key)) return reply.code(409).send({ error: 'Upload is still receiving' });
    if (uploads.get(key)) return reply.send(uploads.get(key));
    if (!checkUploadRate(req.ip)) return reply.status(429).send({ error: 'Rate limit exceeded' });
    try {
      const data = await req.file();
      if (!data) return reply.status(400).send({ error: 'No file provided' });
      // A second request may have arrived while multipart headers were read.
      if (uploads.cancelled(key)) { data.file.resume(); return reply.code(410).send({ error: 'Upload cancelled' }); }
      if (uploads.active.has(key) || uploads.get(key)) { data.file.resume(); return reply.code(409).send({ error: 'Reconcile upload status before retrying' }); }
      const result = await uploads.receive(key, data, req, workspaceId);
      return reply.header('Server-Timing', `body;dur=${result.bodyMs.toFixed(2)}, store;dur=${result.storeMs.toFixed(2)}`).send(result.record);
    } catch (err) {
      const status = err.statusCode || (err.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : err.name === 'AbortError' ? 410 : 500);
      return reply.code(status).send({ error: status === 413 ? 'File exceeds 100 MiB limit' : status === 410 ? 'Upload cancelled' : 'Upload could not be stored; reconcile before retrying' });
    }
  });

  fastify.get('/uploads/:key', async (req, reply) => {
    if (!checkToken(req)) return reply.code(401).send({ error: 'Unauthorized' });
    reply.header('Cache-Control', 'no-store');
    const record = uploads.get(req.params.key);
    if (record?.status === 'receiving') return reply.code(202).send({ status: 'uploading' });
    if (!record) return reply.code(uploads.active.has(req.params.key) ? 202 : 404).send({ status: uploads.active.has(req.params.key) ? 'uploading' : 'unknown' });
    return reply.code(uploads.cancelled(req.params.key) ? 410 : 200).send(record);
  });
  fastify.delete('/uploads/:key', async (req, reply) => {
    if (!checkToken(req)) return reply.code(401).send({ error: 'Unauthorized' });
    if (!/^[0-9a-f-]{36}$/.test(req.params.key)) return reply.code(400).send({ error: 'Invalid upload ID' });
    if (uploads.cancelled(req.params.key)) return { status: 'cancelled' };
    if (!uploads.cancel(req.params.key)) return reply.code(409).send({ item: items.get(uploads.get(req.params.key).id) });
    const transfer = transfers.get(req.params.key);
    if (transfer) { transfer.state = 'cancelled'; transfer.message = 'Cancelled'; transfer.canCancel = false; broadcast({ type: 'transfer', transfer }); }
    return { status: 'cancelled' };
  });
  fastify.post('/uploads/:key/commit', async (req, reply) => {
    if (!checkToken(req)) return reply.code(401).send({ error: 'Unauthorized' });
    const record = uploads.get(req.params.key);
    if (uploads.cancelled(req.params.key)) return reply.code(410).send({ error: 'Upload cancelled or deleted' });
    if (!record) return reply.code(404).send({ error: 'Upload not stored yet' });
    if (Object.hasOwn(boards.purged, record.id)) return reply.code(410).send({ error: 'This card was permanently deleted' });
    if (record.status === 'receiving') return reply.code(409).send({ error: 'Upload is still receiving' });
    if (items.has(record.id)) return { item: items.get(record.id) };
    const body = req.body || {};
    if (body.workspaceId && body.workspaceId !== (record.workspaceId || 'inbox')) return reply.code(409).send({ error: 'Upload belongs to its original workspace' });
    const number = (n, fallback) => Number.isFinite(n) ? n : fallback;
    const image = record.mimeType?.startsWith('image/');
    const video = record.mimeType?.startsWith('video/');
    const item = { id: record.id, kind: image || video ? 'image' : 'file', content: record.storedName,
      fileName: record.fileName, fileSize: record.fileSize, mimeType: record.mimeType,
      x: number(body.x, 0), y: number(body.y, 0), width: Math.max(160, Math.min(800, number(body.width, 320))), height: 0, createdAt: Date.now(), workspaceId: record.workspaceId || 'inbox', version: 1 };
    items.set(item.id, item);
    try { flushState(true); } catch (e) { items.delete(item.id); throw e; }
    record.status = 'completed'; record.updatedAt = Date.now(); uploads.save();
    broadcast({ type: 'add', item });
    catalogChanged();
    return { item };
  });

  // --- File download (streamed, by item ID) ---
  fastify.get('/previews/:id', async (req, reply) => {
    if (!checkToken(req)) return reply.status(401).send({ error: 'Unauthorized' });
    const item = items.get(req.params.id);
    if (!item || item.trashedAt || !item.mimeType?.startsWith('image/')) return reply.status(404).send();
    const filePath = safeFilePath(item.content);
    if (!filePath || !existsSync(filePath)) return reply.status(404).send();
    const result = thumbnails.request(item.content, filePath);
    if (result.status !== 200) return reply.code(result.status).header('Cache-Control', 'no-store').header('Retry-After', '2').send();
    return sendFile(req, reply, result.path, { mimeType: 'image/webp', fileName: item.id + '.webp' });
  });

  fastify.get('/files/:id', async (req, reply) => {
    if (!checkToken(req)) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = req.params;
    const item = items.get(id);
    if (!item || item.trashedAt || (item.kind !== 'file' && item.kind !== 'image')) {
      return reply.status(404).send({ error: 'Not found' });
    }

    const filePath = safeFilePath(item.content);
    if (!filePath || !existsSync(filePath)) {
      return reply.status(404).send({ error: 'File not found on disk' });
    }

    return sendFile(req, reply, filePath, { ...item, download: req.query.download === '1' });
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
