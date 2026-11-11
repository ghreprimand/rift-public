const { app, BrowserWindow, Menu, dialog, session, shell, ipcMain } = require('electron');
const { installDownloads } = require('./desktop-downloads');

const SERVER_URL = process.env.RIFT_SERVER_URL || 'http://127.0.0.1:3300';

app.setName('rift');
// Temporary compatibility option; keep HTTP/2 enabled for normal operation.
if (process.env.RIFT_HTTP1 === '1') app.commandLine.appendSwitch('disable-http2');

if (process.platform === 'linux' && process.env.RIFT_WAYLAND === '1') {
  app.commandLine.appendSwitch('ozone-platform', 'wayland');
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform');
}

// Optional graphics compatibility settings; normal operation keeps GPU sandboxing.
if (process.platform === 'linux' && process.env.RIFT_ANGLE_VULKAN === '1') {
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'vulkan');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let win;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    installDownloads({ ipcMain, session: session.defaultSession, dialog, serverURL: SERVER_URL });

    win = new BrowserWindow({
      width: 1400,
      height: 900,
      title: 'Rift',
      backgroundColor: '#0a0a14',
      autoHideMenuBar: true,
      ...(process.platform === 'darwin' && { alwaysOnTop: true }),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: require('node:path').join(__dirname, 'preload.js'),
      },
    });

    win.loadURL(SERVER_URL);

    win.webContents.setWindowOpenHandler(({ url }) => {
      try { if (['https:', 'http:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch { /* Invalid external links stay closed. */ }
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      try { if (new URL(url).origin !== new URL(SERVER_URL).origin) event.preventDefault(); } catch { event.preventDefault(); }
    });

    win.webContents.on('context-menu', (e, params) => {
      const menu = [];
      if (params.selectionText) {
        menu.push({ label: 'Copy', role: 'copy' });
      }
      if (params.isEditable) {
        menu.push({ label: 'Cut', role: 'cut' });
        menu.push({ label: 'Paste', role: 'paste' });
        menu.push({ label: 'Select All', role: 'selectAll' });
      }
      if (menu.length) {
        Menu.buildFromTemplate(menu).popup();
      }
    });

    win.on('closed', () => { win = null; });
  });

  app.on('window-all-closed', () => app.quit());
}
