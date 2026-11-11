const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('riftDesktop', {
  getDownloadVersion: () => ipcRenderer.invoke('rift:download-version'),
  startDownload: id => ipcRenderer.invoke('rift:download', id),
  cancelDownload: token => ipcRenderer.invoke('rift:cancel-download', token),
  onDownload: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('rift:download-status', listener);
    return () => ipcRenderer.removeListener('rift:download-status', listener);
  },
});
