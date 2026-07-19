const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // Native parent-folder picker for Home's clone flow; resolves null on cancel.
  pickFolder: () => ipcRenderer.invoke('tracker:pick-folder'),
});
