const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  onText: (cb) => ipcRenderer.on('bubble:text', (_e, text) => cb(text)),
  onPlace: (cb) => ipcRenderer.on('bubble:place', (_e, place) => cb(place)),
  size: (width, height) => ipcRenderer.invoke('bubble:size', width, height),
  show: () => ipcRenderer.invoke('bubble:show'),
  click: () => ipcRenderer.invoke('bubble:click'),
});
