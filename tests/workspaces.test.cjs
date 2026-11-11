const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const WS = require('ws');
const { fixture } = require('./fixture.cjs');
let f;
before(async () => { f = await fixture(); });
after(async () => { await f?.close(); });
const pause = ms => new Promise(r => setTimeout(r, ms));
async function peer(modern = true) {
  const socket = new WS(f.origin.replace('http', 'ws') + '/ws', { headers: { 'X-Rift-Token': f.token } });
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(raw)));
  await new Promise(r => socket.once('open', r));
  const wait = async predicate => {
    for (let i = 0; i < 100; i++) { const message = messages.find(predicate); if (message) return message; await pause(20); }
    throw new Error('Expected workspace protocol message was not received');
  };
  if (modern) socket.send(JSON.stringify({ type: 'hello', version: 2 }));
  const snapshot = await wait(m => m.type === 'sync' && (!modern || m.protocolVersion === 2));
  const command = async message => {
    const operationId = randomUUID();
    socket.send(JSON.stringify({ ...message, operationId }));
    return wait(m => ['ack', 'conflict'].includes(m.type) && m.operationId === operationId);
  };
  return { socket, messages, wait, snapshot, command };
}

test('the existing board migrates into Inbox and modern clients receive the shared session', async () => {
  const client = await peer();
  try {
    assert.equal(client.snapshot.workspaces[0].id, 'inbox');
    assert.equal(client.snapshot.workspaces[0].name, 'Inbox');
    assert.deepEqual(client.snapshot.session.tabs, ['inbox']);
    assert.equal(client.snapshot.session.activeWorkspaceId, 'inbox');
    assert.equal(client.snapshot.items.length, f.items.length);
    for (const item of client.snapshot.items) {
      assert.equal(item.workspaceId, 'inbox');
      assert.equal(item.content, f.items.find(original => original.id === item.id).content);
    }
  } finally { client.socket.close(); }
});

test('two clients share tabs, active workspace and view while legacy commands stay in Inbox', async () => {
  const a = await peer(), b = await peer(), legacy = await peer(false);
  try {
    const id = randomUUID();
    assert.equal((await a.command({ type: 'workspaceCreate', id, name: 'Research' })).type, 'ack');
    const activated = await b.wait(m => m.type === 'sync' && m.workspaceId === id);
    assert.deepEqual(activated.session.tabs, ['inbox', id]);
    assert.equal(activated.session.activeWorkspaceId, id);
    const camera = { cx: 200, cy: 100, width: 1200, height: 750 };
    a.socket.send(JSON.stringify({ type: 'session', workspaceId: id, patch: { camera, query: 'shared search', mode: 'library' }, release: true }));
    const view = await b.wait(m => m.type === 'session' && m.session.views[id].query === 'shared search');
    assert.deepEqual(view.session.views[id].camera, camera);
    assert.equal(view.session.views[id].mode, 'library');
    const cardId = randomUUID();
    assert.equal((await a.command({ type: 'add', workspaceId: id, item: { id: cardId, kind: 'text', content: 'workspace note', x: 1, y: 2 } })).type, 'ack');
    await b.wait(m => m.type === 'add' && m.item.id === cardId);
    await pause(30);
    assert.equal(legacy.messages.some(m => m.type === 'add' && m.item.id === cardId), false);
    assert.equal((await legacy.command({ type: 'clear' })).type, 'ack');
    await a.command({ type: 'tabOpen', id });
    const latest = a.messages.filter(m => m.type === 'sync' && m.workspaceId === id).at(-1);
    assert(latest.items.some(item => item.id === cardId));
  } finally { a.socket.close(); b.socket.close(); legacy.socket.close(); }
});

test('uploads retain their queued workspace and Trash retains originals until explicit purge', async () => {
  const a = await peer();
  const request = (url, options = {}) => fetch(f.origin + url, { ...options, headers: { 'X-Rift-Token': f.token, ...options.headers } });
  try {
    const id = randomUUID();
    await a.command({ type: 'workspaceCreate', id, name: 'Files' });
    const key = randomUUID();
    const form = new FormData(); form.append('file', new Blob(['retained original']), 'sample.txt');
    const uploaded = await request('/upload', { method: 'POST', headers: { 'X-Rift-Upload-Id': key, 'X-Rift-Workspace': id }, body: form });
    assert.equal(uploaded.status, 200);
    const receipt = await uploaded.json();
    await a.command({ type: 'tabOpen', id: 'inbox' });
    const committed = await request('/uploads/' + key + '/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: id }) });
    const { item } = await committed.json();
    assert.equal(item.workspaceId, id, 'switching tabs must not redirect the upload');
    await a.command({ type: 'tabOpen', id });
    assert.equal((await a.command({ type: 'archive', workspaceId: id, id: item.id, archived: true })).type, 'ack');
    let result = await request('/search?scope=all&collection=archive&q=sample');
    assert.equal((await result.json()).results[0].id, item.id);
    await a.command({ type: 'delete', workspaceId: id, id: item.id });
    assert.equal((await request('/files/' + item.id)).status, 404);
    assert.equal((await a.command({ type: 'restore', workspaceId: id, id: item.id })).type, 'ack');
    assert.equal(await (await request('/files/' + item.id)).text(), 'retained original');
    await a.command({ type: 'delete', workspaceId: id, id: item.id });
    await a.command({ type: 'purge', workspaceId: id, id: item.id });
    assert.equal((await request('/files/' + item.id)).status, 404);
    const status = await request('/uploads/' + key);
    assert.equal(status.status, 410);
    assert.equal(receipt.fileSize, 17);
  } finally { a.socket.close(); }
});

test('stale edits and malformed commands retain the accepted card and cannot cross workspaces', async () => {
  const a = await peer(), b = await peer();
  try {
    const workspaceId = randomUUID(), id = randomUUID();
    await a.command({ type: 'workspaceCreate', id: workspaceId, name: 'Validation' });
    const added = await a.command({ type: 'add', workspaceId, item: { id, kind: 'text', content: 'original', x: 0, y: 0 } });
    assert.equal(added.version, 1);
    const accepted = await a.command({ type: 'update', workspaceId, id, content: 'accepted', expectedVersion: 1 });
    assert.equal(accepted.version, 2);
    const stale = await b.command({ type: 'update', workspaceId, id, content: 'stale draft', expectedVersion: 1 });
    assert.equal(stale.type, 'conflict'); assert.equal(stale.item.content, 'accepted');
    const malformed = await b.command({ type: 'move', workspaceId, id, x: 'bad', y: 0 });
    assert.equal(malformed.type, 'conflict');
    assert.equal((await b.command({ type: 'delete', workspaceId: 'inbox', id })).type, 'conflict');
    assert.equal((await b.command({ type: 'workspaceCreate', id: '__proto__', name: 'Unsafe' })).type, 'conflict');
    await a.command({ type: 'tabOpen', id: workspaceId });
    const latest = a.messages.filter(m => m.type === 'sync' && m.workspaceId === workspaceId).at(-1).items.find(item => item.id === id);
    assert.equal(latest.content, 'accepted'); assert.equal(latest.x, 0);
  } finally { a.socket.close(); b.socket.close(); }
});

test('operation receipts survive restart and replay never creates a second card', async () => {
  const a = await peer();
  const workspaceId = a.snapshot.workspaceId, id = randomUUID(), operationId = randomUUID();
  const command = { type: 'add', operationId, workspaceId, item: { id, kind: 'text', content: 'one durable note', x: 0, y: 0 } };
  a.socket.send(JSON.stringify(command));
  await a.wait(m => m.type === 'ack' && m.operationId === operationId);
  a.socket.close();
  await f.restart();
  const b = await peer();
  try {
    b.socket.send(JSON.stringify(command));
    assert.equal((await b.wait(m => m.type === 'ack' && m.operationId === operationId)).type, 'ack');
    assert.equal(b.snapshot.items.filter(item => item.id === id).length, 1);
    assert.equal(b.snapshot.items.find(item => item.id === id).content, 'one durable note');
  } finally { b.socket.close(); }
});

test('shared view control rejects competing gestures until takeover and invalid patches are atomic', async () => {
  const a = await peer(), b = await peer();
  try {
    const workspaceId = a.snapshot.workspaceId;
    const camera = { cx: 123, cy: 456, width: 1600, height: 1000 };
    a.socket.send(JSON.stringify({ type: 'session', workspaceId, patch: { camera }, takeControl: true }));
    await b.wait(m => m.type === 'session' && m.session.views[workspaceId].camera?.cx === 123);
    b.socket.send(JSON.stringify({ type: 'session', workspaceId, patch: { camera: { ...camera, cx: 999 } } }));
    await pause(40);
    assert.equal(b.messages.filter(m => m.type === 'session').at(-1).session.views[workspaceId].camera.cx, 123);
    b.socket.send(JSON.stringify({ type: 'session', workspaceId, patch: { camera: { ...camera, cx: 777 } }, takeControl: true, release: true }));
    await a.wait(m => m.type === 'session' && m.session.views[workspaceId].camera.cx === 777);
    b.socket.send(JSON.stringify({ type: 'session', workspaceId, patch: { camera: { ...camera, cx: 888 }, mode: 'invalid' }, takeControl: true }));
    await b.wait(m => m.type === 'conflict' && /view option/.test(m.error));
    await b.command({ type: 'tabOpen', id: workspaceId });
    assert.equal(b.messages.filter(m => m.type === 'sync').at(-1).session.views[workspaceId].camera.cx, 777);
  } finally { a.socket.close(); b.socket.close(); }
});

test('readiness, diagnostics and search are authenticated and WebSocket origins are checked', async () => {
  for (const endpoint of ['/ready', '/diagnostics', '/search']) {
    assert.equal((await fetch(f.origin + endpoint)).status, 401);
    assert.equal((await fetch(f.origin + endpoint, { headers: { 'X-Rift-Token': f.token } })).status, 200);
  }
  const denied = new WS(f.origin.replace('http', 'ws') + '/ws', { headers: { 'X-Rift-Token': f.token, Origin: 'https://unrelated.invalid' } });
  const close = await new Promise(resolve => denied.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  assert.equal(close.code, 4003);
  const page = await fetch(f.origin + '/', { headers: { 'X-Rift-Token': f.token } });
  assert(page.headers.get('content-security-policy').includes("script-src 'self' 'sha256-"));
});

test('purging a card retains a shared original in another workspace and cannot resurrect the purged card', async () => {
  const a = await peer();
  const request = (url, options = {}) => fetch(f.origin + url, { ...options, headers: { 'X-Rift-Token': f.token, ...options.headers } });
  try {
    const source = a.snapshot.workspaceId, destination = randomUUID(), key = randomUUID();
    const bytes = require('./fixture.cjs').png(80, 60);
    const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/png' }), 'shared.png');
    await request('/upload', { method: 'POST', headers: { 'X-Rift-Upload-Id': key, 'X-Rift-Workspace': source }, body: form });
    const { item } = await (await request('/uploads/' + key + '/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    await a.command({ type: 'workspaceCreate', id: destination, name: 'Copies' });
    const cloneId = randomUUID();
    await a.command({ type: 'add', workspaceId: destination, item: { ...item, id: cloneId } });
    await a.command({ type: 'delete', workspaceId: source, id: item.id });
    await a.command({ type: 'purge', workspaceId: source, id: item.id });
    assert.deepEqual(Buffer.from(await (await request('/files/' + cloneId)).arrayBuffer()), bytes);
    assert.equal((await request('/uploads/' + key + '/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 410);
    await a.command({ type: 'delete', workspaceId: destination, id: cloneId });
    await a.command({ type: 'purge', workspaceId: destination, id: cloneId });
    assert.equal(require('node:fs').existsSync(require('node:path').join(f.dir, 'files', item.content)), false);
  } finally { a.socket.close(); }
});

test('a failed durable save publishes no mutation and cannot remove a retained original', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const a = await peer(), b = await peer();
  const workspaceId = a.snapshot.workspaceId, key = randomUUID();
  const request = (url, options = {}) => fetch(f.origin + url, { ...options, headers: { 'X-Rift-Token': f.token, ...options.headers } });
  try {
    const form = new FormData(); form.append('file', new Blob(['keep on failed save']), 'retained.txt');
    await request('/upload', { method: 'POST', headers: { 'X-Rift-Upload-Id': key, 'X-Rift-Workspace': workspaceId }, body: form });
    const { item } = await (await request('/uploads/' + key + '/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    await a.command({ type: 'delete', workspaceId, id: item.id });
    const before = b.messages.length;
    fs.chmodSync(f.dir, 0o500);
    const failed = await a.command({ type: 'purge', workspaceId, id: item.id });
    assert.equal(failed.type, 'conflict');
    assert.equal(fs.existsSync(path.join(f.dir, 'files', item.content)), true);
    assert.equal((await request('/ready')).status, 503);
    await pause(30);
    assert.equal(b.messages.slice(before).some(message => message.type === 'sync'), false, 'uncommitted mutation must not reach another client');
    fs.chmodSync(f.dir, 0o700);
    assert.equal((await a.command({ type: 'purge', workspaceId, id: item.id })).type, 'ack');
    assert.equal(fs.existsSync(path.join(f.dir, 'files', item.content)), false);
    assert.equal((await request('/ready')).status, 200);
  } finally { fs.chmodSync(f.dir, 0o700); a.socket.close(); b.socket.close(); }
});

test('application assets compress, revalidate privately and never bypass authentication', async () => {
  const http = require('node:http'), zlib = require('node:zlib');
  const raw = encoding => new Promise((resolve, reject) => {
    http.get(f.origin + '/', { headers: { 'X-Rift-Token': f.token, 'Accept-Encoding': encoding } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ response, bytes: Buffer.concat(chunks) }));
    }).once('error', reject);
  });
  const plain = await raw('identity');
  const compressed = await raw('br, gzip');
  assert.equal(compressed.response.headers['content-encoding'], 'br');
  assert.deepEqual(zlib.brotliDecompressSync(compressed.bytes), plain.bytes);
  assert(compressed.bytes.length < plain.bytes.length / 3);
  const gzip = await raw('br;q=0, gzip');
  assert.equal(gzip.response.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(gzip.bytes), plain.bytes);
  const etag = compressed.response.headers.etag;
  const conditional = await fetch(f.origin + '/', { headers: { 'X-Rift-Token': f.token, 'If-None-Match': etag } });
  assert.equal(conditional.status, 304); assert.equal(await conditional.text(), '');
  assert.equal(conditional.headers.get('cache-control'), 'private, max-age=0, must-revalidate');
  assert.equal(conditional.headers.get('vary'), 'Accept-Encoding');
  assert.equal((await fetch(f.origin + '/workspace-ui.js', { headers: { 'If-None-Match': etag } })).status, 401);
  assert.equal((await raw('identity;q=0, gzip;q=0, br;q=0')).response.statusCode, 406);
});

test('moving a grouped card moves the whole group and respects pinned members', async () => {
  const a = await peer();
  try {
    const source = randomUUID(), destination = randomUUID(), first = randomUUID(), second = randomUUID(), groupId = randomUUID();
    await a.command({ type: 'workspaceCreate', id: source, name: 'Grouped' });
    await a.command({ type: 'add', workspaceId: source, item: { id: first, kind: 'text', content: 'first', x: 10, y: 20 } });
    await a.command({ type: 'add', workspaceId: source, item: { id: second, kind: 'text', content: 'second', x: 100, y: 200 } });
    await a.command({ type: 'group', workspaceId: source, group: { id: groupId, label: 'Related', cards: [first, second] } });
    await a.command({ type: 'workspaceCreate', id: destination, name: 'Moved group' });
    await a.command({ type: 'pin', workspaceId: source, id: second, pinned: true });
    assert.equal((await a.command({ type: 'moveWorkspace', workspaceId: source, cards: [first], destination })).type, 'conflict');
    await a.command({ type: 'pin', workspaceId: source, id: second, pinned: false });
    assert.equal((await a.command({ type: 'moveWorkspace', workspaceId: source, cards: [first], destination })).type, 'ack');
    const moved = a.messages.filter(message => message.type === 'sync' && message.workspaceId === destination).at(-1);
    assert.equal(moved.items.length, 2);
    assert.deepEqual(moved.groups.find(group => group.id === groupId).cards, [first, second]);
    assert.deepEqual(moved.items.map(item => [item.id, item.x, item.y]), [[first, 10, 20], [second, 100, 200]]);
    assert(moved.items.every(item => item.workspaceId === destination));
  } finally { a.socket.close(); }
});

test('metadata search paginates, filters dates and masks hidden note contents', async () => {
  const a = await peer();
  const request = query => fetch(f.origin + '/search?' + query, { headers: { 'X-Rift-Token': f.token } }).then(r => r.json());
  try {
    const workspaceId = randomUUID();
    await a.command({ type: 'workspaceCreate', id: workspaceId, name: 'Library pages' });
    for (let i = 0; i < 106; i++) await a.command({ type: 'add', workspaceId, item: { id: randomUUID(), kind: 'text', content: 'searchable row', label: 'Row ' + String(i).padStart(3, '0'), x: 0, y: 0, createdAt: Date.parse(i < 53 ? '2025-01-01' : '2026-01-01') } });
    await a.command({ type: 'add', workspaceId, item: { id: randomUUID(), kind: 'text', hidden: true, content: 'hidden phrase', label: 'Private note', x: 0, y: 0 } });
    const first = await request('workspaceId=' + workspaceId + '&q=searchable&sort=name&limit=100');
    const second = await request('workspaceId=' + workspaceId + '&q=searchable&sort=name&limit=100&offset=100');
    assert.equal(first.total, 106); assert.equal(first.results.length, 100); assert.equal(second.results.length, 6);
    assert.equal(first.results[0].label, 'Row 000'); assert.equal(second.results[0].label, 'Row 100');
    assert.equal((await request('workspaceId=' + workspaceId + '&q=searchable&after=2026-01-01')).total, 53);
    assert.equal((await request('workspaceId=' + workspaceId + '&q=hidden%20phrase')).total, 0);
    assert.equal((await request('workspaceId=' + workspaceId + '&q=Private')).results[0].content, '');
    await a.command({ type: 'workspaceArchive', id: workspaceId });
    assert.equal((await request('scope=all&q=searchable')).total, 0);
    assert.equal((await request('scope=all&collection=archive&q=searchable')).total, 106);
    await a.command({ type: 'workspaceRestore', id: workspaceId });
    assert.equal((await request('workspaceId=' + workspaceId + '&q=searchable')).total, 106);
  } finally { a.socket.close(); }
});

test('deployment maintenance exposes authenticated readiness but accepts no user traffic', async () => {
  const isolated = await fixture({ maintenance: true, agedUpload: true });
  try {
    const headers = { 'X-Rift-Token': isolated.token };
    assert.equal((await fetch(isolated.origin + '/health')).status, 200);
    const ready = await fetch(isolated.origin + '/ready', { headers });
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).maintenance, true);
    assert.equal((await fetch(isolated.origin + '/ready')).status, 401);
    for (const route of ['/', '/ws', '/files/plain', '/search']) assert.equal((await fetch(isolated.origin + route, { headers })).status, 503);
    assert.equal((await fetch(isolated.origin + '/upload', { method: 'POST', headers })).status, 503);
    assert.equal(require('node:fs').existsSync(require('node:path').join(isolated.dir, 'files', isolated.aged.storedName)), true, 'maintenance must not sweep original files');
  } finally { await isolated.close(); }
});
