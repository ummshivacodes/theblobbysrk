const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('threadAxis', {
  loadThreads: () => ipcRenderer.invoke('load-threads'),
  saveThreads: (data) => ipcRenderer.invoke('save-threads', data),
  quit: () => ipcRenderer.send('quit-app'),
  hide: () => ipcRenderer.send('hide-window'),
  resize: (width, height) => ipcRenderer.send('resize-window', { width, height }),
  getLoginItem: () => ipcRenderer.invoke('get-login-item'),
  setLoginItem: (on) => ipcRenderer.invoke('set-login-item', on),
  onShown: (cb) => ipcRenderer.on('window-shown', () => cb()),
  onHidden: (cb) => ipcRenderer.on('window-hidden', () => cb()),
  // Links. Main re-validates every URL (http/https only), whatever the page checked.
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  fetchTitle: (url) => ipcRenderer.invoke('fetch-title', url),
  // null, or { kind: 'recovered-from-backup', at } when the load had to use the backup.
  getLoadNotice: () => ipcRenderer.invoke('get-load-notice'),
});
