const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixture.cjs');
const { randomUUID } = require('node:crypto');
let f;
before(async () => { f = await fixture(); });
after(async () => { await f?.close(); });
const request = (url, options = {}) => fetch(f.origin + url, { ...options, headers: { 'X-Rift-Token': f.token, ...options.headers } });

test('authenticated file requests stream exact full and partial bytes', async () => {
  const full = await request('/files/plain');
  assert.equal(full.status, 200);
  assert.equal(await full.text(), '0123456789abcdefghijklmnopqrstuvwxyz');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  for (const [range, status, bytes, contentRange] of [
    ['bytes=2-5', 206, '2345', 'bytes 2-5/36'],
    ['bytes=32-', 206, 'wxyz', 'bytes 32-35/36'],
    ['bytes=-3', 206, 'xyz', 'bytes 33-35/36'],
    ['bytes=34-100', 206, 'yz', 'bytes 34-35/36'],
    ['bytes=-100', 206, '0123456789abcdefghijklmnopqrstuvwxyz', 'bytes 0-35/36'],
    ['bytes=-99999999999999999999', 206, '0123456789abcdefghijklmnopqrstuvwxyz', 'bytes 0-35/36'],
    ['bytes=99999999999999999999-', 416, '', 'bytes */36'],
    ['bytes=34-99999999999999999999', 206, 'yz', 'bytes 34-35/36'],
    ['bytes=36-', 416, '', 'bytes */36'],
    ['bytes=-0', 416, '', 'bytes */36'],
    ['bytes=9-2', 200, '0123456789abcdefghijklmnopqrstuvwxyz', null],
    ['bytes=nonsense', 200, '0123456789abcdefghijklmnopqrstuvwxyz', null],
    ['bytes=0-1,4-5', 200, '0123456789abcdefghijklmnopqrstuvwxyz', null],
    ['items=1-2', 200, '0123456789abcdefghijklmnopqrstuvwxyz', null],
  ]) {
    const res = await request('/files/plain', { headers: { Range: range } });
    assert.equal(res.status, status, range);
    assert.equal(res.headers.get('content-range'), contentRange, range);
    assert.equal(res.headers.get('content-length'), String(bytes.length), range);
    assert.equal(await res.text(), bytes, range);
  }
  const head = await request('/files/plain', { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '36');
  assert.equal(await head.text(), '');
  assert.equal((await fetch(f.origin + '/files/plain')).status, 401);
  assert.equal((await fetch(f.origin + '/files/plain', { method: 'HEAD', headers: { Range: 'bytes=2-5' } })).status, 401);
  const conditional = await request('/files/plain', { headers: { Range: 'bytes=2-5', 'If-Range': '"unknown"' } });
  assert.equal(conditional.status, 200);
  assert.equal(await conditional.text(), '0123456789abcdefghijklmnopqrstuvwxyz');
});

test('image previews are authenticated bounded derivatives and originals stay intact', async () => {
  assert.equal((await fetch(f.origin + '/previews/image-0')).status, 401);
  let res;
  for (let i = 0; i < 40; i++) {
    res = await request('/previews/image-0');
    if (res.status !== 202) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert(bytes.length <= 96 * 1024);
  const sharp = require('sharp');
  const meta = await sharp(bytes).metadata();
  assert(meta.width <= 480 && meta.height <= 480);
  const original = await request('/files/image-0');
  assert.equal(Number(original.headers.get('content-length')), f.items[0].fileSize);
  assert.equal((await request('/previews/plain')).status, 404);
});

test('stored uploads reconcile, commit once, synchronize twice, and cancel safely', async () => {
  const WS = require('ws');
  const connect = async () => {
    const ws = new WS(f.origin.replace('http', 'ws') + '/ws', { headers: { 'X-Rift-Token': f.token } });
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    await new Promise(r => ws.once('open', r));
    return { ws, messages };
  };
  const a = await connect(), b = await connect();
  try {
    const key = randomUUID();
    const form = new FormData(); form.append('file', new Blob(['original upload bytes']), 'synthetic.txt');
    const upload = await request('/upload', { method: 'POST', headers: { 'X-Rift-Upload-Id': key }, body: form });
    assert.equal(upload.status, 200);
    const stored = await upload.json();
    // Deliberately discard the response at the caller: status must reconcile it.
    const status = await request('/uploads/' + key);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).id, stored.id);
    const replay = await request('/upload', { method: 'POST', headers: { 'X-Rift-Upload-Id': key }, body: form });
    assert.equal((await replay.json()).id, stored.id);
    const commit = () => request('/uploads/' + key + '/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 10, y: 20, width: 240 }) });
    assert.equal((await commit()).status, 200);
    assert.equal((await commit()).status, 200);
    await new Promise(r => setTimeout(r, 50));
    for (const client of [a,b]) assert.equal(client.messages.filter(m => m.type === 'add' && m.item.id === stored.id).length, 1);
    assert.equal(await (await request('/files/' + stored.id)).text(), 'original upload bytes');
    assert.equal((await request('/uploads/' + key, { method: 'DELETE' })).status, 409);
    const cancelled = randomUUID();
    assert.equal((await request('/uploads/' + cancelled, { method: 'DELETE' })).status, 200);
    const late = await request('/upload', { method: 'POST', headers: { 'X-Rift-Upload-Id': cancelled }, body: form });
    assert.equal(late.status, 410);
    const abandoned = randomUUID();
    const orphan = await (await request('/upload', { method: 'POST', headers: { 'X-Rift-Upload-Id': abandoned }, body: form })).json();
    assert.equal((await request('/uploads/' + abandoned, { method: 'DELETE' })).status, 200);
    assert.equal((await request('/uploads/' + abandoned + '/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 410);
    assert.equal((await request('/files/' + orphan.id)).status, 404);
    assert.equal((await fetch(f.origin + '/uploads/' + key)).status, 401);
  } finally { a.ws.close(); b.ws.close(); }
});

test('corrupt and oversized images cannot fail the original; orientation is preserved', async () => {
  const sharp = require('sharp');
  const cases = [
    ['corrupt.png', Buffer.from('not an image'), false],
    ['too-many-pixels.png', await sharp({ create: { width: 5000, height: 5000, channels: 3, background: 'red' } }).png().toBuffer(), false],
    ['oriented.jpg', await sharp({ create: { width: 120, height: 80, channels: 3, background: 'blue' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer(), true],
  ];
  for (const [name, bytes, supported] of cases) {
    const key = randomUUID();
    const form = new FormData(); form.append('file', new Blob([bytes], { type: name.endsWith('jpg') ? 'image/jpeg' : 'image/png' }), name);
    assert.equal((await request('/upload', { method: 'POST', headers: { 'X-Rift-Upload-Id': key }, body: form })).status, 200);
    const result = await (await request('/uploads/' + key + '/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    let preview;
    for (let i = 0; i < 60; i++) {
      preview = await request('/previews/' + result.item.id);
      if (preview.status !== 202) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(preview.status, supported ? 200 : 422, name);
    if (supported) {
      const meta = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
      assert.equal(meta.width, 80); assert.equal(meta.height, 120);
    }
    assert.deepEqual(Buffer.from(await (await request('/files/' + result.item.id)).arrayBuffer()), bytes);
  }
});

test('aborted multipart uploads remove partial data and size limits remain 100 MiB', async () => {
  const http = require('node:http');
  const fs = require('node:fs');
  const path = require('node:path');
  const prefix = '--rift-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.bin"\r\nContent-Type: application/octet-stream\r\n\r\n';
  const key = randomUUID();
  const req = http.request(f.origin + '/upload', { method: 'POST', headers: { 'X-Rift-Token': f.token, 'X-Rift-Upload-Id': key, 'Content-Type': 'multipart/form-data; boundary=rift-boundary' } });
  req.on('error', () => {}); req.write(prefix); req.write(Buffer.alloc(65536));
  for (let i = 0; i < 100; i++) {
    if ((await request('/uploads/' + key)).status === 202) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal((await request('/uploads/' + key)).status, 202);
  req.destroy();
  for (let i = 0; i < 100; i++) {
    if ((await request('/uploads/' + key)).status === 404) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal((await request('/uploads/' + key)).status, 404);
  assert.equal(fs.readdirSync(path.join(f.dir, 'files')).filter(n => n.endsWith('.part')).length, 0);
  assert.equal(fs.readdirSync(path.join(f.dir, 'upload-tmp')).length, 0);
  const beforeFiles = fs.readdirSync(path.join(f.dir, 'files')).length;
  const large = http.request(f.origin + '/upload', { method: 'POST', headers: { 'X-Rift-Token': f.token, 'Content-Type': 'multipart/form-data; boundary=rift-boundary' } });
  const response = new Promise((resolve, reject) => { large.once('response', res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }); large.once('error', reject); });
  large.write(prefix);
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 101; i++) if (!large.write(block)) await new Promise(r => large.once('drain', r));
  large.end('\r\n--rift-boundary--\r\n');
  assert.equal(await response, 413);
  assert.equal(fs.readdirSync(path.join(f.dir, 'files')).length, beforeFiles);
});

test('upload identities, cancellation, board state and thumbnails survive a server restart', async () => {
  const key = randomUUID(), cancelled = randomUUID();
  const form = new FormData(); form.append('file', new Blob(['durable bytes']), 'durable.part');
  const stored = await (await request('/upload', { method: 'POST', headers: { 'X-Rift-Upload-Id': key }, body: form })).json();
  await request('/uploads/' + cancelled, { method: 'DELETE' });
  await f.restart();
  assert.equal((await (await request('/uploads/' + key)).json()).id, stored.id);
  assert.equal((await request('/uploads/' + cancelled)).status, 410);
  const committed = await request('/uploads/' + key + '/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":123,"y":456}' });
  assert.equal(committed.status, 200);
  await f.restart();
  const replay = await request('/uploads/' + key + '/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const { item } = await replay.json();
  assert.equal(item.x, 123); assert.equal(item.y, 456);
  assert.equal(await (await request('/files/' + stored.id)).text(), 'durable bytes');
  assert.equal((await request('/previews/image-0')).status, 200);
});

test('legacy clients retain shared originals until the last attachment reference is deleted', async () => {
  const WS = require('ws');
  const fs = require('node:fs');
  const path = require('node:path');
  const ws = new WS(f.origin.replace('http', 'ws') + '/ws', { headers: { 'X-Rift-Token': f.token } });
  await new Promise(r => ws.once('open', r));
  try {
    const bytes = require('./fixture.cjs').png(80, 60);
    const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/png' }), 'legacy.png');
    const stored = await (await request('/upload', { method: 'POST', body: form })).json();
    const original = { id: stored.id, kind: 'image', content: stored.storedName, fileName: stored.fileName, mimeType: stored.mimeType, fileSize: stored.fileSize, x: 1, y: 2 };
    const clone = { ...original, id: randomUUID() };
    ws.send(JSON.stringify({ type: 'add', item: original })); ws.send(JSON.stringify({ type: 'add', item: clone }));
    for (let i = 0; i < 100; i++) { if ((await request('/files/' + clone.id)).status === 200) break; await new Promise(r => setTimeout(r, 10)); }
    let preview;
    for (let i = 0; i < 60; i++) { preview = await request('/previews/' + original.id); if (preview.status !== 202) break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(preview.status, 200);
    const derivative = path.join(f.dir, 'previews', require('node:crypto').createHash('sha256').update(stored.storedName).digest('hex') + '.webp');
    assert(fs.existsSync(derivative));
    ws.send(JSON.stringify({ type: 'delete', id: original.id }));
    for (let i = 0; i < 100; i++) { if ((await request('/files/' + original.id)).status === 404) break; await new Promise(r => setTimeout(r, 10)); }
    assert.deepEqual(Buffer.from(await (await request('/files/' + clone.id)).arrayBuffer()), bytes);
    assert(fs.existsSync(derivative));
    ws.send(JSON.stringify({ type: 'delete', id: clone.id }));
    for (let i = 0; i < 100; i++) { if ((await request('/files/' + clone.id)).status === 404) break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(fs.existsSync(path.join(f.dir, 'files', stored.storedName)), false);
    assert.equal(fs.existsSync(derivative), false);
  } finally { ws.close(); }
});

test('upload authentication and the existing 20-per-minute rate limit remain enforced', async () => {
  const isolated = await fixture();
  try {
    const form = new FormData(); form.append('file', new Blob(['small']), 'rate.txt');
    assert.equal((await fetch(isolated.origin + '/upload', { method: 'POST', body: form })).status, 401);
    for (let i = 0; i < 20; i++) assert.equal((await fetch(isolated.origin + '/upload', { method: 'POST', headers: { 'X-Rift-Token': isolated.token }, body: form })).status, 200);
    assert.equal((await fetch(isolated.origin + '/upload', { method: 'POST', headers: { 'X-Rift-Token': isolated.token }, body: form })).status, 429);
  } finally { await isolated.close(); }
});

test('abandoned upload cleanup only removes tracked unattached originals', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const isolated = await fixture({ agedUpload: true });
  try {
    const res = await fetch(isolated.origin + '/uploads/' + isolated.aged.key, { headers: { 'X-Rift-Token': isolated.token } });
    assert.equal(res.status, 410);
    assert.equal(fs.existsSync(path.join(isolated.dir, 'files', isolated.aged.storedName)), false);
    assert.equal(fs.readFileSync(path.join(isolated.dir, 'files', 'legacy-untracked.bin'), 'utf8'), 'preserve unknown originals');
    assert.equal((await fetch(isolated.origin + '/files/image-0', { headers: { 'X-Rift-Token': isolated.token } })).status, 200);
  } finally { await isolated.close(); }
});
