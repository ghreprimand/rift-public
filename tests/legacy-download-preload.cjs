// Released v1 bridge: keep this interface to exercise mixed-version clients.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('riftDesktop', {
  startDownload: id => ipcRenderer.invoke('rift:download', id),
  cancelDownload: token => ipcRenderer.invoke('rift:cancel-download', token),
  onDownload: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('rift:download-status', listener);
    return () => ipcRenderer.removeListener('rift:download-status', listener);
  },
});
