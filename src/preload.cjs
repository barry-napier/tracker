const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
