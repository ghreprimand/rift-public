// Exercise real renderer, HTTP and DownloadItem boundaries with a delayed human
// save-dialog boundary. No production data or installed client is accessed.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const { installDownloads } = require('../desktop-downloads');
const { fixture, scratch, artifacts } = require('./fixture.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const mode = process.argv.includes('--layout') ? 'layout' : process.argv.includes('--legacy-bridge') ? 'legacy-bridge' : process.argv.includes('--picker') ? 'picker' : 'native';
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');
if (process.argv.includes('--http1')) app.commandLine.appendSwitch('disable-http2');
fs.mkdirSync(scratch, { recursive: true });
const profile = fs.mkdtempSync(path.join(scratch, 'download-regression-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let f, win, ses, outcome = 0;
const deadline = setTimeout(() => { f?.terminate(); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  try {
    f = await fixture({ tls: true });
    ses = session.fromPartition('download-regression-' + Date.now());
    ses.setCertificateVerifyProc((_request, callback) => callback(0));
    await ses.cookies.set({ url: f.origin, name: 'rift_token', value: f.token, secure: true, httpOnly: true });
    const saved = path.join(f.dir, 'selected-download.bin');
    let customDialogs = 0, automaticDialogOpportunities = 0, downloads = 0, originalGets = 0;
    ses.webRequest.onBeforeRequest({ urls: [f.origin + '/files/*'] }, (details, callback) => {
      if (details.method === 'GET') originalGets++;
      callback({});
    });
    installDownloads({ ipcMain, session: ses, serverURL: f.origin, dialog: { async showSaveDialog() {
      customDialogs++;
      assert.equal(originalGets, 0, 'the original must not start downloading before the save dialog');
      // The previous tests returned immediately and missed the real dialog race.
      await sleep(mode === 'native' ? 150 : 0);
      return { canceled: false, filePath: saved };
    } } });
    ses.on('will-download', (_event, item) => {
      downloads++;
      if (!item.getSavePath()) {
        automaticDialogOpportunities++;
        // Suppress an actual OS dialog in an unattended test. This is precisely
        // the public state where Electron would otherwise open its own chooser.
        item.setSavePath(path.join(f.dir, 'unexpected-default-download.bin'));
      }
    });
    win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: {
      session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false,
      offscreen: process.argv.includes('--screenshot'),
      ...(mode !== 'picker' && { preload: path.resolve(__dirname, mode === 'legacy-bridge' ? 'legacy-download-preload.cjs' : '../preload.js') }),
    } });
    const debug = win.webContents.debugger;
    debug.attach('1.3');
    const ready = new Promise(r => win.webContents.once('dom-ready', r));
    win.loadURL(f.origin).catch(() => {});
    const evaluate = async expression => {
      const result = await debug.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async expression => {
      for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await sleep(30); }
      throw new Error('Condition timed out: ' + expression);
    };
    await ready;
    await waitFor(`!!document.querySelector('[data-id="plain"] .body')`);
    if (mode === 'picker' || mode === 'legacy-bridge') {
      f.faults.omitFileLength = true;
      await evaluate(`(() => {
        window.pickerCalls = 0; window.savedBytes = []; window.fileClosed = false;
        window.showSaveFilePicker = async () => {
          pickerCalls++; await new Promise(r=>setTimeout(r,100));
          return { createWritable:async()=>({write:async value=>savedBytes.push(...value),close:async()=>{fileClosed=true},abort:async()=>{savedBytes=[]}}) };
        };
      })()`);
    }
    await evaluate(`(() => { const body=document.querySelector('[data-id="plain"] .body');body.click();body.click(); })()`);
    await waitFor(`document.querySelector('[data-id="plain"] .download-panel .progress-text')?.textContent === 'Done'`);
    const geometry = await evaluate(`(() => { const card=document.querySelector('[data-id="plain"]'); const body=card.querySelector('.body').getBoundingClientRect(); const bar=card.querySelector('.progress-bar').getBoundingClientRect(); return {bodyWidth:body.width,barWidth:bar.width,barTop:bar.top,bodyTop:body.top}; })()`);
    console.log('DOWNLOAD_RESULT ' + JSON.stringify({ mode, customDialogs, automaticDialogOpportunities, downloads, originalGets, ...geometry }));
    if (process.argv.includes('--screenshot')) {
      await sleep(150);
      const rect = await evaluate(`(() => { const r=document.querySelector('[data-id="plain"]').getBoundingClientRect(); return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}; })()`);
      const screenshot = await win.webContents.capturePage(rect);
      fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(path.join(artifacts, 'rift-download-card-fixed.png'), screenshot.toPNG());
    }
    if (mode === 'native') {
      assert.equal(customDialogs, 1, 'one user save dialog');
      assert.equal(automaticDialogOpportunities, 0, 'Electron must not open a second save dialog');
      assert.equal(downloads, 1, 'one original download');
      assert.equal(fs.readFileSync(saved, 'utf8'), '0123456789abcdefghijklmnopqrstuvwxyz');
    } else if (mode === 'layout') {
      assert(geometry.barWidth >= geometry.bodyWidth * 0.8, 'progress must span the card, rather than a tiny inline line');
      await waitFor(`!document.querySelector('[data-id="plain"] .download-panel')`);
    } else {
      assert.equal(customDialogs, 0, 'an old or absent bridge must use only the browser save picker');
      assert.equal(downloads, 0, 'writing through the browser picker must not start a native download');
      assert.equal(await evaluate('pickerCalls'), 1);
      assert.equal(await evaluate('String.fromCharCode(...savedBytes)'), '0123456789abcdefghijklmnopqrstuvwxyz');
      assert.equal(await evaluate('fileClosed'), true);
      assert.equal(originalGets, 1, 'one streamed original, including when length is unknown');
      await evaluate(`window.showSaveFilePicker = async () => { pickerCalls++; throw new DOMException('Cancelled','AbortError'); }`);
      await evaluate(`document.querySelector('[data-id="plain"] .body').click()`);
      await waitFor(`document.querySelector('[data-id="plain"] .download-panel .progress-text')?.textContent === 'Download cancelled'`);
      assert.equal(originalGets, 1, 'cancelling the picker must not fetch another original');
      await evaluate(`window.showSaveFilePicker = async () => { pickerCalls++; return {createWritable:async()=>({write:async()=>{},close:async()=>{throw new Error('must not complete')},abort:async()=>{window.writeAborted=true}})}; }`);
      f.faults.nextFileStatus = 401;
      await evaluate(`document.querySelector('[data-id="audio"] .btn[title="Download"]').click()`);
      await waitFor(`document.querySelector('[data-id="audio"] .download-panel .progress-text')?.textContent.includes('Authentication expired')`);
      assert.equal(await evaluate('writeAborted'), true, 'authentication failure must abort the writable file');
    }
    console.log('DOWNLOAD_PASS ' + mode);
  } catch (error) { console.error(error.stack); outcome = 1; }
  finally {
    clearTimeout(deadline); win?.destroy(); await ses?.closeAllConnections();
    try { await f?.close(); } catch { console.error('Fixture cleanup failed'); outcome = 1; }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch { console.warn('Temporary Electron profile retained in test scratch'); }
    app.exit(outcome);
  }
});
