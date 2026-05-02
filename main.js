const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');

const SERVER_URL = process.env.RIFT_SERVER_URL || 'http://127.0.0.1:3300';

app.setName('rift');
app.commandLine.appendSwitch('disable-http-cache');

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'wayland');
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  // Route GL through ANGLE/Vulkan: the native EGL path has DMA-BUF import failures
  // (EGL_BAD_MATCH) on NVIDIA Wayland with recent driver/Mesa combos.
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

    session.defaultSession.on('will-download', async (_event, item) => {
      item.pause();
      const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: item.getFilename() });
      if (canceled || !filePath) { item.cancel(); return; }
      item.setSavePath(filePath);
      item.resume();
    });

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
      },
    });

    win.loadURL(SERVER_URL);

    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
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
