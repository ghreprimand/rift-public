const { randomUUID } = require('node:crypto');

function installDownloads({ ipcMain, session, dialog, serverURL }) {
  const origin = new URL(serverURL).origin;
  const downloads = new Map();
  const authorized = event => {
    try { return event.senderFrame === event.sender.mainFrame && new URL(event.senderFrame.url).origin === origin; }
    catch { return false; }
  };
  const notify = (record, status) => {
    if (!record.webContents.isDestroyed()) record.webContents.send('rift:download-status', { token: record.token, ...status });
  };
  const finish = (record, state, error) => {
    clearTimeout(record.timeout); downloads.delete(record.token);
    record.webContents.removeListener('destroyed', record.destroyed);
    notify(record, { state, error });
  };
  const prepare = async (record, id) => {
    const url = `${origin}/files/${encodeURIComponent(id)}?download=1&transfer=${record.token}`;
    // Authenticate and obtain the filename without downloading the original.
    const response = await session.fetch(url, { method: 'HEAD', credentials: 'include', signal: record.controller.signal });
    if (!response.ok) throw new Error([401, 403].includes(response.status)
      ? 'Authentication expired. Sign in again.' : `Download failed (HTTP ${response.status}).`);
    clearTimeout(record.timeout);
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    let filename = 'file';
    if (encoded) try { filename = decodeURIComponent(encoded); } catch {}
    if (filename === 'file') filename = /filename="([^"]*)"/i.exec(disposition)?.[1] || filename;
    notify(record, { state: 'choosing', received: 0, total: Number(response.headers.get('content-length')) || 0 });
    const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: filename });
    if (downloads.get(record.token) !== record) return;
    if (canceled || !filePath || record.cancelled || record.webContents.isDestroyed()) { finish(record, 'cancelled'); return; }
    record.filePath = filePath;
    record.timeout = setTimeout(() => finish(record, 'failed', 'Download did not start. Check authentication and connection.'), 120000);
    // Choose the destination before starting DownloadItem. Pausing the item
    // while awaiting a chooser does not suppress Electron's own save dialog.
    record.webContents.downloadURL(url);
  };
  ipcMain.handle('rift:download-version', event => {
    if (!authorized(event)) throw new Error('Invalid download request');
    return 2;
  });
  session.webRequest.onHeadersReceived({ urls: [origin + '/files/*'] }, (details, callback) => {
    const record = downloads.get(new URL(details.url).searchParams.get('transfer'));
    if (record && ![200, 206].includes(details.statusCode)) {
      clearTimeout(record.timeout); record.cancelled = true;
      // Electron may still emit will-download for a cancelled error response.
      // Retain the record briefly so that event cannot open a fallback save dialog.
      record.timeout = setTimeout(() => downloads.delete(record.token), 10000);
      notify(record, { state: 'failed', error: [401, 403].includes(details.statusCode)
        ? 'Authentication expired. Sign in again.' : `Download failed (HTTP ${details.statusCode}).` });
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  ipcMain.handle('rift:download', (event, id) => {
    if (!authorized(event) || typeof id !== 'string' || !id.length || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Invalid download request');
    const token = randomUUID();
    const record = { token, webContents: event.sender, cancelled: false, controller: new AbortController() };
    record.destroyed = () => { record.cancelled = true; record.controller.abort(); record.item?.cancel(); finish(record, 'cancelled'); };
    event.sender.once('destroyed', record.destroyed);
    downloads.set(token, record);
    record.timeout = setTimeout(() => {
      record.cancelled = true; record.controller.abort(); record.item?.cancel();
      finish(record, 'failed', 'Download did not start. Check authentication and connection.');
    }, 120000);
    prepare(record, id).catch(error => {
      if (downloads.get(token) === record) finish(record, record.cancelled ? 'cancelled' : 'failed', error.message);
    });
    return token;
  });
  ipcMain.handle('rift:cancel-download', (event, token) => {
    const record = downloads.get(token);
    if (!authorized(event) || record?.webContents !== event.sender) return;
    record.cancelled = true;
    record.controller.abort();
    record.item?.cancel();
    if (!record.item) finish(record, 'cancelled');
  });
  session.on('will-download', (_event, item, webContents) => {
    let token;
    try { const url = new URL(item.getURL()); if (url.origin === origin) token = url.searchParams.get('transfer'); } catch {}
    const record = downloads.get(token);
    // Untracked browser/legacy downloads use Electron's default chooser once.
    if (!record) return;
    if (record) {
      if (record.filePath) item.setSavePath(record.filePath);
      record.item = item;
      clearTimeout(record.timeout);
      notify(record, { state: 'choosing', received: 0, total: item.getTotalBytes() });
      const cancel = () => item.cancel();
      webContents.once('destroyed', cancel);
      item.on('updated', (_event, state) => {
        notify(record, { state: state === 'interrupted' ? 'failed' : 'downloading', received: item.getReceivedBytes(), total: item.getTotalBytes() });
        if (state === 'interrupted') item.cancel();
      });
      item.once('done', (_event, state) => {
        downloads.delete(token); webContents.removeListener('destroyed', cancel);
        webContents.removeListener('destroyed', record.destroyed);
        notify(record, { state, received: item.getReceivedBytes(), total: item.getTotalBytes() });
      });
      if (record.cancelled) { item.cancel(); return; }
    }
  });
}
module.exports = { installDownloads };
