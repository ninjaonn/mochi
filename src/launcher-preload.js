// The launcher only gets what it needs. It can ask for a copy, but it never
// receives a password.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('launcher', {
  search: call('launcher:search'),
  copyLink: call('launcher:copyLink'),
  hide: call('launcher:hide'),
  copy: call('vault:copy'),
  openLink: call('links:open'),
  lockStatus: call('lock:status'),
  pin: call('lock:pin'),
  onShow: (cb) => ipcRenderer.on('launcher:show', () => cb()),
});
