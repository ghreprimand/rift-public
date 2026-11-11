// Isolated synthetic data only. Never read .env or contact a deployed Rift server.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const http2 = require('node:http2');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const scratch = path.resolve(process.env.RIFT_TEST_SCRATCH || path.join(os.tmpdir(), 'rift-tests'));
const artifacts = path.resolve(process.env.RIFT_TEST_ARTIFACTS || path.join(scratch, 'artifacts'));

function png(width = 1024, height = 1024) {
  const crc = data => {
    let c = 0xffffffff;
    for (const b of data) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc(body), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = 123456;
  for (let y = 0; y < height; y++) for (let x = 1; x <= width * 3; x++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    raw[y * (width * 3 + 1) + x] = seed & 255;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture({ tls = false, many = false, baseline = false, agedUpload = false, maintenance = false } = {}) {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'transfer-'));
  fs.mkdirSync(path.join(dir, 'files'));
  const aged = { key: randomUUID(), id: randomUUID(), storedName: randomUUID() + '.bin', status: 'stored', updatedAt: Date.now() - 25 * 60 * 60 * 1000 };
  if (agedUpload) {
    fs.writeFileSync(path.join(dir, 'files', aged.storedName), 'abandoned synthetic bytes');
    fs.writeFileSync(path.join(dir, 'files', 'legacy-untracked.bin'), 'preserve unknown originals');
    fs.writeFileSync(path.join(dir, 'uploads.json'), JSON.stringify({ [aged.key]: aged }));
  }
  const token = randomBytes(24).toString('hex');
  const image = png();
  const items = [];
  function add(id, mimeType, bytes, kind = 'file') {
    const content = `${id}.${mimeType.split('/')[1]}`;
    fs.writeFileSync(path.join(dir, 'files', content), bytes);
    const i = items.length;
    items.push({ id, kind, mimeType, content, fileName: content, fileSize: bytes.length,
      x: (i % 4) * 350, y: Math.floor(i / 4) * 250, width: 320, height: 200, createdAt: 1700000000000 });
  }
  for (let i = 0; i < (many ? 40 : 8); i++) add(`image-${i}`, 'image/png', image, 'image');
  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>>',
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>',
    '<</Length 49>>\nstream\nBT /F1 16 Tf 20 100 Td (Synthetic Rift PDF) Tj ET\nendstream',
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  add('pdf', 'application/pdf', Buffer.from(pdf));
  const wav = Buffer.alloc(44 + 16000 * 2 * 20);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  add('audio', 'audio/wav', wav);
  const video = path.join(dir, 'video.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
  add('video', 'video/mp4', fs.readFileSync(video));
  add('plain', 'application/octet-stream', Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'));
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ items, groups: [{ id: 'fixture-group', label: 'Synthetic', cards: ['image-0', 'image-1'] }] }));
  let source = root;
  if (baseline) {
    source = path.join(dir, 'baseline');
    for (const name of ['server/index.js', 'app/index.html']) {
      const target = path.join(source, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, execFileSync('git', ['show', 'cd2a407d11d6c5c735a0aaf4f3acb29c60175537:' + name], { cwd: root }));
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  }
  const serverLog = [];
  const reservation = require('node:net').createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const requestedPort = reservation.address().port;
  await new Promise(r => reservation.close(r));
  let child, port;
  // Browser fixtures must host the server with standalone Node, just like the
  // deployed service; Electron's executable also changes every forked worker.
  const serverRuntime = process.env.RIFT_TEST_NODE || (process.versions.electron ? process.env.npm_node_execpath || 'node' : process.execPath);
  async function boot() {
  child = spawn(serverRuntime, [path.join(source, 'server/index.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RIFT_SKIP_DOTENV: '1', RIFT_MAINTENANCE: maintenance ? '1' : '0', PORT: String(requestedPort), HOST: '127.0.0.1', RIFT_TOKEN: token, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture server startup deadline')), 8000);
    child.stdout.on('data', data => {
      const s = data.toString(); serverLog.push(s);
      const m = s.match(/Server listening at http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { port = Number(m[1]); clearTimeout(timeout); resolve(); }
    });
    child.stderr.on('data', d => serverLog.push(d.toString()));
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}`)); });
  });
  }
  await boot();
  let proxy;
  const sockets = new Set();
  const faults = { dropNextAck: false, loseUploadResponse: false, loseCommitResponse: false, malformedUploadResponse: false, nextUploadStatus: 0, nextFileStatus: 0, omitFileLength: false, delayUploadResponse: 0, previewDelay: 0, previewFaults: false };
  let origin = `http://127.0.0.1:${port}`;
  if (tls) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    proxy = http2.createSecureServer({ allowHTTP1: true, key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) });
    proxy.on('request', (req, res) => {
      const omitFileLength = req.url.startsWith('/files/') && faults.omitFileLength;
      if (omitFileLength) faults.omitFileLength = false;
      if (process.env.RIFT_TEST_TRACE) console.log('FIXTURE_REQUEST', req.method, req.url);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith(':') && !['connection', 'host'].includes(k)));
      headers.host = req.headers[':authority'] || req.headers.host;
      if (req.url.startsWith('/files/') && faults.nextFileStatus) {
        const status = faults.nextFileStatus; faults.nextFileStatus = 0;
        req.resume(); res.writeHead(status); res.end('{"error":"Synthetic authorization fault"}'); return;
      }
      if (req.url === '/upload' && faults.nextUploadStatus) {
        const status = faults.nextUploadStatus; faults.nextUploadStatus = 0;
        req.resume(); res.writeHead(status); res.end('{"error":"Synthetic fault"}'); return;
      }
      const upstream = http.request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers }, response => {
        if (process.env.RIFT_TEST_TRACE) console.log('FIXTURE_RESPONSE', req.url, response.statusCode);
        if (req.url === '/upload' && faults.loseUploadResponse) {
          faults.loseUploadResponse = false; response.resume(); response.on('end', () => res.destroy()); return;
        }
        if (/\/commit$/.test(req.url) && faults.loseCommitResponse) {
          faults.loseCommitResponse = false; response.resume(); response.on('end', () => res.destroy()); return;
        }
        if (req.url === '/upload' && faults.malformedUploadResponse) {
          faults.malformedUploadResponse = false; response.resume(); response.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{'); }); return;
        }
        const send = () => {
          if (res.destroyed) { response.destroy(); return; }
          for (const [k, v] of Object.entries(response.headers)) if (!['connection', 'transfer-encoding', 'keep-alive'].includes(k) && !(omitFileLength && k === 'content-length')) res.setHeader(k, v);
          res.writeHead(response.statusCode);
          // Controlled application-level faults, explicitly not a packet-loss simulator.
          if (faults.previewFaults && /\/(files|previews)\//.test(req.url)) {
            (async () => {
              for await (const chunk of response) for (let offset = 0; offset < chunk.length; offset += 16384) {
                await new Promise(r => setTimeout(r, 300));
                if (res.destroyed) return;
                if (!res.write(chunk.subarray(offset, offset + 16384))) await new Promise(r => { res.once('drain', r); res.once('close', r); });
              }
              res.end();
            })().catch(() => res.destroy());
          } else response.pipe(res);
        };
        setTimeout(send, req.url === '/upload' ? faults.delayUploadResponse : /\/previews\//.test(req.url) ? faults.previewDelay : 0);
      });
      upstream.on('error', () => res.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    });
    const WS = require('ws');
    const websocketProxy = new WS.WebSocketServer({ noServer: true });
    proxy.on('upgrade', (req, socket, head) => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      websocketProxy.handleUpgrade(req, socket, head, frontend => {
        const headers = Object.fromEntries(['cookie', 'x-rift-token', 'origin', 'host'].filter(key => req.headers[key] !== undefined).map(key => [key, req.headers[key]]));
        const upstream = new WS('ws://127.0.0.1:' + port + req.url, { headers });
        const pending = [];
        frontend.on('message', (body, binary) => { if (upstream.readyState === WS.OPEN) upstream.send(body, { binary }); else pending.push([body, binary]); });
        upstream.on('open', () => { for (const [body, binary] of pending) upstream.send(body, { binary }); pending.length = 0; });
        upstream.on('message', (body, binary) => {
          if (faults.dropNextAck && !binary) {
            try { if (JSON.parse(body).type === 'ack') { faults.dropNextAck = false; return; } } catch {}
          }
          if (frontend.readyState === WS.OPEN) frontend.send(body, { binary });
        });
        frontend.on('close', () => upstream.terminate());
        upstream.on('close', () => frontend.close());
        frontend.on('error', () => upstream.terminate());
        upstream.on('error', () => frontend.close());
      });
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    origin = `https://127.0.0.1:${proxy.address().port}`;
  }
  return { dir, token, origin, port, items, faults, serverLog, aged,
    disconnectClients() { for (const socket of sockets) socket.destroy(); },
    terminate() { child.kill('SIGTERM'); },
    async restart() {
      const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; await boot();
    },
    async close() {
      proxy?.close(); proxy?.closeAllConnections?.();
      if (child.exitCode === null) {
        const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited;
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
module.exports = { fixture, png, scratch, artifacts };
