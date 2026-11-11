const { app, BrowserWindow, session, ipcMain } = require('electron');
const { installDownloads } = require('../desktop-downloads');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, scratch } = require('./fixture.cjs');
const baseline = process.argv.includes('--baseline');
const adverse = process.argv.includes('--adverse');
const http1 = process.argv.includes('--http1');
const behavior = process.argv.includes('--behavior');
const warm = process.argv.includes('--warm');
const faults = process.argv.includes('--faults');
if (http1) app.commandLine.appendSwitch('disable-http2');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('no-sandbox');
fs.mkdirSync(scratch, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(scratch, 'electron-')));
let f, win, testSession;
let outcome = 0;
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Browser test exceeded 55-second deadline'); win?.destroy(); f?.terminate(); app.exit(1); }, 55000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function evaluate(expression) {
  const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
  return result.result.value;
}
async function waitFor(code, timeout = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(code)) return; await sleep(50); }
  const context = await evaluate(`({transform:document.getElementById('canvas')?.style.transform, image0:(() => { const img=document.querySelector('.card[data-id="image-0"] img');if(!img)return null;const r=img.getBoundingClientRect();return {src:img.getAttribute('src'),alt:img.alt,x:r.x,y:r.y,width:r.width,height:r.height};})(),previews:(() => {const p=window.__fixturePreviews;return p?{destroyed:!!p.destroyed,leases:p.leases,frame:p.frame,cache:p.cache.size,active:[...p.active.keys()],pending:[...p.targets.values()].filter(t=>!t.loaded).map(t=>({id:t.requestId,visible:t.visible,attempts:t.attempts,retryAt:t.retryAt})),held:[...p.fixtureLeases.values()]}:null})()})`);
  throw new Error(`Browser condition timed out: ${code}; context=${JSON.stringify(context)}`);
}
app.whenReady().then(async () => {
  try {
    f = await fixture({ tls: true, baseline, many: process.argv.includes('--many') });
    f.faults.previewFaults = faults;
    console.log('BROWSER_STAGE fixture ready');
    const ses = testSession = session.fromPartition(`test-${Date.now()}`);
    ses.setCertificateVerifyProc((_request, callback) => callback(0));
    await ses.cookies.set({ url: f.origin, name: 'rift_token', value: f.token, secure: true, httpOnly: true });
    console.log('BROWSER_STAGE cookie ready');
    let cancelSave = false;
    const saveNames = [];
    installDownloads({ ipcMain, session: ses, serverURL: f.origin, dialog: { async showSaveDialog(options) {
      saveNames.push(options.defaultPath);
      return { canceled: cancelSave, filePath: path.join(f.dir, 'native-download.bin') };
    } } });
    win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { session: ses, backgroundThrottling: false, contextIsolation: true, sandbox: true, preload: path.resolve(__dirname, '../preload.js') } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('BROWSER_CONSOLE', message); });
    const requests = new Map();
    const uploads = [];
    let activePreviews = new Set(), peakPreviews = 0;
    const debug = win.webContents.debugger;
    debug.attach('1.3');
    const ready = new Promise(r => win.webContents.once('dom-ready', r));
    win.loadURL(f.origin).catch(e => console.error('BROWSER_NAVIGATION', e.message));
    await debug.sendCommand('Network.enable');
    console.log('BROWSER_STAGE network ready');
    if (adverse) await debug.sendCommand('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 512 * 1024, uploadThroughput: 512 * 1024 });
    debug.on('message', (_event, method, p) => {
      if (method === 'Network.requestWillBeSent') {
        requests.set(p.requestId, { url: new URL(p.request.url).pathname, start: p.timestamp });
        if (p.request.url.includes('/previews/')) { activePreviews.add(p.requestId); peakPreviews = Math.max(peakPreviews, activePreviews.size); }
        if (p.request.url.endsWith('/upload')) uploads.push({ start: p.timestamp });
      }
      if (method === 'Network.responseReceived') {
        const r = requests.get(p.requestId); if (r) { r.protocol = p.response.protocol; r.response = p.timestamp; r.status = p.response.status; }
        if (p.response.url.endsWith('/upload')) {
          uploads.at(-1).response = p.timestamp;
          uploads.at(-1).serverTiming = Object.entries(p.response.headers).find(([key]) => key.toLowerCase() === 'server-timing')?.[1];
        }
      }
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        activePreviews.delete(p.requestId);
        const r = requests.get(p.requestId); if (r) { r.end = p.timestamp; r.bytes = p.encodedDataLength || 0; r.cancelled = !!p.canceled; }
      }
      if (method === 'Network.dataReceived') { const r = requests.get(p.requestId); if (r) r.received = (r.received || 0) + p.dataLength; }
    });
    await ready;
    console.log('BROWSER_STAGE DOM ready');
    await waitFor('document.querySelectorAll(".card").length >= 10');
    if (warm && !baseline) {
      await waitFor(`document.querySelectorAll('img[data-preview-id][src^="blob:"]').length >= 8`);
      const readyAgain = new Promise(r => win.webContents.once('dom-ready', r));
      win.webContents.reload(); await readyAgain;
      await waitFor('document.querySelectorAll(".card").length >= 10');
      requests.clear();
    }
    if (faults && !baseline) await waitFor(`document.querySelectorAll('img[data-preview-id][src^="blob:"]').length >= 1`, 12000);
    console.log('BROWSER_STAGE board ready');
    await evaluate(`
      if (typeof RiftPreviewScheduler !== 'undefined') {
        const priority = RiftPreviewScheduler.prototype.priority;
        RiftPreviewScheduler.prototype.priority = function(...args) {
          this.fixtureLeases ||= new Map(); window.__fixturePreviews = this;
          const key = Math.random(), release = priority.apply(this,args);
          this.fixtureLeases.set(key,new Error('priority lease').stack);
          return () => { this.fixtureLeases.delete(key); release(); };
        };
      }
      window.measure = { started: performance.now(), at100: null, longTasks: [] };
      new PerformanceObserver(list => measure.longTasks.push(...list.getEntries().map(e => e.duration))).observe({type:'longtask', buffered:true});
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(...args) {
        if (args[1] === '/upload') {
          this.upload.addEventListener('progress', e => { if (e.lengthComputable && e.loaded === e.total) measure.at100 = performance.now(); });
          this.addEventListener('load', () => measure.responseArrived = performance.now());
        }
        return originalOpen.apply(this, args);
      };
      new MutationObserver(() => {
        if (!measure.cardCreated && Array.from(document.querySelectorAll('.card')).some(el => el.textContent.includes('synthetic-upload.bin') && !el.querySelector('.progress-bar'))) measure.cardCreated = performance.now();
      }).observe(document.getElementById('canvas'), {childList:true, subtree:true});
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(1048576)], 'synthetic-upload.bin', {type:'application/octet-stream'}));
      document.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:dt, clientX:500, clientY:350}));
    `);
    await waitFor(`Array.from(document.querySelectorAll('.card')).some(el => el.textContent.includes('synthetic-upload.bin') && !el.querySelector('.progress-bar'))`, 30000);
    const timing = await evaluate(`({ totalMs: measure.cardCreated-measure.started, progress100Ms: measure.at100-measure.started, responseArrivalMs: measure.responseArrived-measure.started, after100Ms: measure.at100 === null ? null : measure.cardCreated-measure.at100, longTasks:measure.longTasks, protocol:performance.getEntriesByType('navigation')[0].nextHopProtocol })`);
    await sleep(250);
    const traffic = [...requests.values()];
    const logs = f.serverLog.flatMap(line => line.split('\n')).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const uploadRequests = new Set(logs.filter(line => line.req?.url === '/upload').map(line => line.reqId));
    const summary = { baseline, warm, faults, peakPreviews, attachmentCount: f.items.length, profile: adverse ? '150ms RTT, 512KiB/s each direction (browser throttle; no packet loss)' : 'healthy loopback',
      ...timing, originalRequests: traffic.filter(r => r.url.startsWith('/files/')).length,
      previewRequests: traffic.filter(r => r.url.startsWith('/previews/')).length,
      originalBytes: traffic.filter(r => r.url.startsWith('/files/')).reduce((n,r)=>n+Math.max(r.received || 0, r.bytes || 0),0),
      previewBytes: traffic.filter(r => r.url.startsWith('/previews/')).reduce((n,r)=>n+Math.max(r.received || 0, r.bytes || 0),0), uploads,
      previewResponses: traffic.filter(r => r.url.startsWith('/previews/')).map(r => ({ status: r.status, bodyBytes: r.received || 0, wireBytes: r.bytes || 0, cancelled: r.cancelled || false })),
      serverUploadMs: logs.filter(line => line.msg === 'request completed' && uploadRequests.has(line.reqId)).map(line => line.responseTime) };
    console.log('TRANSFER_RESULT ' + JSON.stringify(summary));
    if (!baseline || process.argv.includes('--assert-controlled')) {
      assert.equal(summary.originalRequests, 0, 'initial board load must not fetch originals');
      assert(summary.previewRequests > 0 || warm, 'visible images should request lightweight previews or reuse the warm cache');
      assert.equal(summary.protocol, http1 ? 'http/1.1' : 'h2');
      assert(summary.after100Ms !== null && summary.after100Ms < 5000, 'confirmation after 100% within five seconds');
      assert(peakPreviews <= 2, 'at most two previews in flight');
    }
    if (behavior && !baseline) {
      const drop = async (name, bytes = 1048576) => evaluate(`(() => {
        const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(${bytes})], ${JSON.stringify(name)}, {type:'application/octet-stream'}));
        document.dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:dt,clientX:500,clientY:350}));
      })()`);
      const card = name => `Array.from(document.querySelectorAll('.card')).find(el=>el.textContent.includes(${JSON.stringify(name)}))`;
      const finished = name => `(() => { const el=${card(name)}; return !!el && !el.querySelector('.upload-panel'); })()`;
      // Start a download while cold previews are still in flight, rather than
      // changing a delay flag after the board has already finished previewing.
      f.faults.previewDelay = 1200;
      await waitFor(`document.querySelectorAll('img[data-preview-id][src^="blob:"]').length < 8`);
      await evaluate(`document.querySelector('.card[data-id="plain"] .body').click()`);
      await waitFor(`document.querySelector('.card[data-id="plain"] .download-panel .progress-text')?.textContent === 'Done'`);
      assert.equal(fs.readFileSync(path.join(f.dir, 'native-download.bin'), 'utf8'), '0123456789abcdefghijklmnopqrstuvwxyz');
      f.faults.previewDelay = 0;
      const WS = require('ws');
      const observer = new WS(f.origin.replace('https', 'wss') + '/ws', { rejectUnauthorized: false, headers: { 'X-Rift-Token': f.token } });
      const messages = [];
      observer.on('error', () => {});
      observer.on('message', b => messages.push(JSON.parse(b)));
      await new Promise(r => observer.once('open', r));

      f.faults.delayUploadResponse = 1100;
      await drop('wait.bin'); await drop('queued-cancel.bin'); await drop('queued-success-1.bin'); await drop('queued-success-2.bin');
      await waitFor(`(${card('wait.bin')})?.dataset.uploadState === 'waiting'`);
      assert.equal(await evaluate(`(${card('wait.bin')}).querySelector('.progress-text').textContent`), 'Waiting for server confirmation…');
      assert.equal(await evaluate(`(${card('queued-cancel.bin')}).dataset.uploadState`), 'queued');
      await evaluate(`(${card('queued-cancel.bin')}).querySelector('.upload-cancel').click()`);
      await waitFor(`(${card('queued-cancel.bin')})?.dataset.uploadState === 'cancelled'`);
      await waitFor(finished('wait.bin'));
      await waitFor(finished('queued-success-1.bin'));
      await waitFor(finished('queued-success-2.bin'));
      f.faults.delayUploadResponse = 0;

      const beforeLost = uploads.length;
      f.faults.loseUploadResponse = true;
      await drop('lost-response.bin');
      await waitFor(finished('lost-response.bin'));
      assert.equal(uploads.length - beforeLost, 1, 'a lost response must reconcile without a second POST');
      assert.equal(messages.filter(m => m.type === 'add' && m.item.fileName === 'lost-response.bin').length, 1);
      f.faults.loseCommitResponse = true;
      await drop('lost-commit.bin');
      await waitFor(finished('lost-commit.bin'));
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('.card')).filter(el=>el.textContent.includes('lost-commit.bin')).length`), 1);
      f.faults.malformedUploadResponse = true;
      await drop('malformed-response.bin');
      await waitFor(finished('malformed-response.bin'));
      for (const code of [401, 429, 413]) {
        const name = 'status-' + code + '.bin';
        f.faults.nextUploadStatus = code;
        await drop(name, 1024);
        await waitFor(`(${card(name)})?.dataset.uploadState === 'failed'`);
        const message = await evaluate(`(${card(name)}).querySelector('.progress-text').textContent`);
        assert(message.includes(code === 401 ? 'Authentication expired' : code === 429 ? 'rate limit' : '100 MiB'));
        await evaluate(`(${card(name)}).querySelector('.upload-retry').click()`);
        await waitFor(finished(name));
      }

      f.faults.delayUploadResponse = 1200;
      await drop('active-cancel.bin', 8 * 1024 * 1024);
      await waitFor(`!!(${card('active-cancel.bin')})?.querySelector('.upload-cancel')`);
      await evaluate(`(${card('active-cancel.bin')}).querySelector('.upload-cancel').click()`);
      await waitFor(`(${card('active-cancel.bin')})?.querySelector('.progress-text').textContent === 'Cancelled'`);
      f.faults.delayUploadResponse = 0;
      assert.equal(messages.filter(m => m.type === 'add' && m.item.fileName.includes('cancel.bin')).length, 0);

      // Real Electron DownloadItem uses the shared session and native streaming.
      f.faults.previewDelay = 500;
      await evaluate(`document.querySelector('.card[data-id="plain"] .body').click()`);
      await waitFor(`document.querySelector('.card[data-id="plain"] .download-panel .progress-text')?.textContent === 'Done'`);
      assert.equal(fs.readFileSync(path.join(f.dir, 'native-download.bin'), 'utf8'), '0123456789abcdefghijklmnopqrstuvwxyz');
      assert.equal(saveNames.at(-1), 'plain.octet-stream');
      const dialogsBeforeAuthFailure = saveNames.length;
      f.faults.nextFileStatus = 401;
      await evaluate(`document.querySelector('.card[data-id="plain"] .body').click()`);
      await waitFor(`document.querySelector('.card[data-id="plain"] .download-panel .progress-text')?.textContent === 'Authentication expired. Sign in again.'`);
      assert.equal(saveNames.length, dialogsBeforeAuthFailure, 'an authentication error must not be saved as an attachment');
      cancelSave = true;
      await evaluate(`document.querySelector('.card[data-id="audio"] .acts .btn[title="Download"]').click()`);
      await waitFor(`document.querySelector('.card[data-id="audio"] .download-panel .progress-text')?.textContent === 'Download cancelled'`);
      cancelSave = false;
      f.faults.previewFaults = true;
      await evaluate(`document.querySelector('.card[data-id="image-0"] .acts .btn[title="Download"]').click()`);
      await waitFor(`(() => { const t = document.querySelector('.card[data-id="image-0"] .download-panel .progress-text'); return t && t.textContent.includes('/'); })()`);
      await evaluate(`document.querySelector('.card[data-id="image-0"] .download-panel button').click()`);
      await waitFor(`document.querySelector('.card[data-id="image-0"] .download-panel .progress-text')?.textContent === 'Download cancelled'`);
      f.faults.previewFaults = false;

      const originalsBeforeMedia = [...requests.values()].filter(r => r.url.startsWith('/files/')).length;
      await evaluate(`document.querySelector('.card[data-id="audio"] .open-preview').click()`);
      await waitFor(`document.querySelector('.card[data-id="audio"] audio')?.readyState >= 1`);
      await evaluate(`document.querySelector('.card[data-id="audio"] audio').currentTime=10`);
      await waitFor(`document.querySelector('.card[data-id="audio"] audio').currentTime >= 10`);
      await evaluate(`document.querySelector('.card[data-id="audio"] .open-preview').click()`);
      assert.equal(await evaluate(`document.querySelectorAll('[data-id="audio"] audio').length`), 0);
      await evaluate(`document.querySelector('.card[data-id="video"] .open-preview').click()`);
      await waitFor(`document.querySelector('.card[data-id="video"] video')?.readyState >= 1`);
      await evaluate(`document.querySelector('.card[data-id="video"] video').currentTime=1.5`);
      await waitFor(`(() => { const v = document.querySelector('.card[data-id="video"] video'); return v.currentTime >= 1.5 && !v.seeking; })()`);
      await evaluate(`document.querySelector('.card[data-id="video"] .open-preview').click()`);
      assert.equal(await evaluate(`document.querySelectorAll('[data-id="video"] video').length`), 0);
      await evaluate(`document.querySelector('.card[data-id="pdf"] .open-preview').click()`);
      await waitFor(`!!document.querySelector('.card[data-id="pdf"] embed')`);
      await evaluate(`document.querySelector('.card[data-id="pdf"] .open-preview').click()`);
      assert.equal(await evaluate(`document.querySelectorAll('[data-id="pdf"] embed').length`), 0);
      assert([...requests.values()].filter(r => r.url.startsWith('/files/')).length > originalsBeforeMedia);
      f.faults.previewDelay = 0;
      await waitFor(`document.querySelectorAll('img[data-preview-id][src^="blob:"]').length >= 8`);
      const pan = async distance => evaluate(`(() => {
        document.getElementById('viewport').dispatchEvent(new MouseEvent('mousedown',{button:2,clientX:700,clientY:400,bubbles:true,cancelable:true}));
        document.dispatchEvent(new MouseEvent('mousemove',{clientX:700+${distance},clientY:400,bubbles:true}));
        document.dispatchEvent(new MouseEvent('mouseup',{button:2,clientX:700+${distance},clientY:400,bubbles:true}));
      })()`);
      await pan(20000);
      await waitFor(`document.querySelectorAll('img[data-preview-id]').length === 0`);
      await sleep(100);
      const offscreenRequests = [...requests.values()].filter(r => r.url.startsWith('/previews/')).length;
      await sleep(300);
      assert.equal([...requests.values()].filter(r => r.url.startsWith('/previews/')).length, offscreenRequests, 'offscreen cards must not build a request queue');
      await pan(-20000);
      await waitFor(`document.querySelectorAll('img[data-preview-id][src^="blob:"]').length >= 8`);

      // Pan and zoom through the real transformed canvas, then move a grouped card.
      observer.send(JSON.stringify({ type: 'move', id: 'image-0', x: 40000, y: 40000 }));
      await waitFor(`!document.querySelector('.card[data-id="image-0"]')`);
      observer.send(JSON.stringify({ type: 'move', id: 'image-0', x: 0, y: 0 }));
      await waitFor(`!!document.querySelector('.card[data-id="image-0"] img[src^="blob:"]')`);
      await evaluate(`document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel', {deltaY:-400,clientX:700,clientY:400,bubbles:true,cancelable:true}))`);
      win.setSize(1000, 700); await sleep(100);
      win.setSize(1400, 900);
      observer.send(JSON.stringify({ type: 'collapse', id: 'image-1', collapsed: true }));
      await waitFor(`document.querySelector('.card[data-id="image-1"]').classList.contains('collapsed')`);
      observer.send(JSON.stringify({ type: 'collapse', id: 'image-1', collapsed: false }));
      // Expiry, deletion and a real WebSocket reconnection/resync.
      const lost = messages.find(m => m.type === 'add' && m.item.fileName === 'lost-response.bin').item;
      observer.send(JSON.stringify({ type: 'expire', id: lost.id, expiresAt: Date.now() - 1 }));
      observer.send(JSON.stringify({ type: 'delete', id: 'image-7' }));
      await waitFor(`!document.querySelector('.card[data-id="image-7"]')`);
      f.disconnectClients();
      await waitFor(`document.getElementById('dot').classList.contains('off')`);
      await waitFor(`document.getElementById('dot').title === 'Connected' && document.querySelectorAll('.card').length >= 8`);
      await waitFor(`!(${card('lost-response.bin')})`, 17000);
      observer.close();
      assert(peakPreviews <= 2, 'pan, resize and new attachments must retain the preview concurrency limit');
      console.log('BEHAVIOR_PASS waiting, queued/active cancellation, lost upload/commit and malformed responses, HTTP 401/429/413 retry, two clients, native streaming/save cancellation during previews, audio/video seek/close, PDF open/close, pan/move/zoom/resize/collapse, expiry/delete, reconnect');
    }
    console.log('BROWSER_PASS');
  } catch (e) { console.error(e.stack); outcome = 1; }
  finally {
    clearTimeout(deadline);
    win?.destroy();
    await testSession?.closeAllConnections();
    if (f) try { await f.close(); } catch { console.error('Fixture cleanup failed'); outcome = 1; }
    const profile = app.getPath('userData');
    await session.defaultSession.closeAllConnections();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch { console.warn('Temporary Electron profile retained in test scratch'); }
    app.exit(outcome);
  }
});
