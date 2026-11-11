// Temporary local demo. It never reads production data or credentials.
const http = require('node:http');
const WS = require('ws');
const sharp = require('sharp');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixture.cjs');
let previewFixture;
let previewWriter;

(async () => {
  const f = await fixture();
  previewFixture = f;
  const writer = new WS(f.origin.replace('http', 'ws') + '/ws', { headers: { 'X-Rift-Token': f.token } });
  previewWriter = writer;
  const received = [];
  writer.on('message', raw => received.push(JSON.parse(raw)));
  await new Promise(r => writer.once('open', r));
  writer.send(JSON.stringify({ type: 'hello', version: 2 }));
  const command = async message => {
    const operationId = randomUUID(); writer.send(JSON.stringify({ ...message, operationId }));
    for (let i = 0; i < 100; i++) {
      const reply = received.find(m => m.operationId === operationId);
      if (reply) { if (reply.type === 'conflict') throw new Error(reply.error); return; }
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('Demo initialization deadline');
  };
  const workspaceId = randomUUID(), referenceId = randomUUID();
  await command({ type: 'workspaceCreate', id: workspaceId, name: 'Website' });
  const first = randomUUID(), second = randomUUID();
  await command({ type: 'add', workspaceId, item: { id: first, kind: 'text', label: 'Release checklist', content: '## Ready for review\n- Review the landing page\n- Check the copy\n- Share the release notes', markdown: true, x: 60, y: 70, width: 350 } });
  await command({ type: 'add', workspaceId, item: { id: second, kind: 'text', label: 'Design notes', content: 'Keep the important things visible.\n\nUse workspaces for ownership, tabs for navigation, and search to find anything.', color: 'blue', x: 60, y: 345, width: 350 } });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="1000" height="600" fill="#e8e1d6"/><rect x="50" y="40" width="900" height="520" rx="18" fill="#15273d"/><text x="100" y="110" fill="#eabf7a" font-size="26" font-family="sans-serif">STUDIO / 01</text><text x="100" y="230" fill="white" font-size="52" font-family="sans-serif">A place for good ideas.</text><text x="100" y="285" fill="#a6bacd" font-size="24" font-family="sans-serif">Build, collect, and make things together.</text><rect x="100" y="345" width="240" height="70" rx="8" fill="#dfa85f"/><text x="140" y="390" font-size="24" fill="#15273d" font-family="sans-serif">Explore the work</text><circle cx="795" cy="425" r="105" fill="#527f91"/><circle cx="845" cy="385" r="65" fill="#9bbcb9"/></svg>';
  const image = await sharp(Buffer.from(svg)).png().toBuffer();
  const request = (url, options = {}) => fetch(f.origin + url, { ...options, headers: { 'X-Rift-Token': f.token, ...options.headers } });
  for (const [name, bytes, mime, x, y, width] of [['landing-page.png', image, 'image/png', 480, 70, 440], ['release-notes.txt', Buffer.from('Synthetic demo release notes. No production data.'), 'text/plain', 480, 430, 400]]) {
    const key = randomUUID(), form = new FormData(); form.append('file', new Blob([bytes], { type: mime }), name);
    const upload = await request('/upload', { method: 'POST', headers: { 'X-Rift-Upload-Id': key, 'X-Rift-Workspace': workspaceId }, body: form });
    if (!upload.ok) throw new Error('Demo upload failed');
    const commit = await request('/uploads/' + key + '/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x, y, width, workspaceId }) });
    if (!commit.ok) throw new Error('Demo card initialization failed');
  }
  await command({ type: 'workspaceCreate', id: referenceId, name: 'Reference' });
  await command({ type: 'add', workspaceId: referenceId, item: { id: randomUUID(), kind: 'text', label: 'Keyboard tips', content: '/ or Ctrl/Cmd+K: search\nSpace+drag: pan\nG: group selected cards\nCtrl/Cmd+Shift+T: reopen a tab', x: 80, y: 80, width: 400 } });
  await command({ type: 'workspaceActivate', id: workspaceId });
  writer.send(JSON.stringify({ type: 'session', workspaceId, patch: { camera: { cx: 490, cy: 330, width: 1120, height: 700 } }, release: true }));
  const target = new URL(f.origin);
  const server = http.createServer((req, res) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: target.port, path: req.url, method: req.method,
      headers: { ...req.headers, 'accept-encoding': 'identity', 'x-rift-token': f.token } }, response => {
      const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !['content-security-policy', 'content-length', 'connection', 'transfer-encoding'].includes(name)));
      if (String(headers['content-type']).includes('text/html')) {
        const chunks = []; let length = 0;
        response.on('data', chunk => { length += chunk.length; if (length > 512 * 1024) { response.destroy(); res.destroy(); } else chunks.push(chunk); });
        response.on('end', () => {
          const html = Buffer.concat(chunks).toString().replace('<body>', '<body><div style="position:fixed;right:20px;bottom:5px;z-index:99999;color:#c4b08a;font:11px sans-serif">Local demo · changes are temporary</div>');
          res.writeHead(response.statusCode, headers); res.end(html);
        });
      } else { res.writeHead(response.statusCode, headers); response.pipe(res); }
    });
    upstream.on('error', () => res.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
  });
  const bridge = new WS.WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => bridge.handleUpgrade(req, socket, head, client => {
    const upstream = new WS(f.origin.replace('http', 'ws') + '/ws', { headers: { 'X-Rift-Token': f.token, Host: req.headers.host } });
    const pending = [];
    client.on('message', (body, binary) => { if (upstream.readyState === WS.OPEN) upstream.send(body, { binary }); else pending.push([body, binary]); });
    upstream.on('open', () => { for (const [body, binary] of pending) upstream.send(body, { binary }); });
    upstream.on('message', (body, binary) => { if (client.readyState === WS.OPEN) client.send(body, { binary }); });
    client.on('close', () => upstream.terminate()); upstream.on('close', () => client.close());
    client.on('error', () => upstream.terminate()); upstream.on('error', () => client.close());
  }));
  await new Promise(r => server.listen(8000, '127.0.0.1', r));
  console.log('Local synthetic demo: http://localhost:8000/');
  const close = async () => { server.close(); server.closeAllConnections(); for (const client of bridge.clients) client.terminate(); writer.close(); await f.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
})().catch(async error => { console.error(error.message); previewWriter?.close(); await previewFixture?.close(); process.exit(1); });
