const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // Native parent-folder picker for Home's clone flow; resolves null on cancel.
  pickFolder: () => ipcRenderer.invoke('tracker:pick-folder'),
  // Browser surface: session-level operations the <webview> element can't do.
  browser: {
    clearCache: () => ipcRenderer.invoke('browser:clear-cache'),
    clearCookies: () => ipcRenderer.invoke('browser:clear-cookies'),
  },
  // Self-update: state lives in the main process, mirrored over update:state.
  update: {
    getState: () => ipcRenderer.invoke('update:get-state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (handler) => {
      const listener = (_event, state) => handler(state);
      ipcRenderer.on('update:state', listener);
      return () => ipcRenderer.removeListener('update:state', listener);
    },
  },
  // Terminal drawer: one PTY per spawn, streamed over term:data/term:exit.
  term: {
    spawn: (opts) => ipcRenderer.invoke('term:spawn', opts),
    input: (id, data) => ipcRenderer.send('term:input', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('term:kill', id),
    onData: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('term:data', listener);
      return () => ipcRenderer.removeListener('term:data', listener);
    },
    onExit: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('term:exit', listener);
      return () => ipcRenderer.removeListener('term:exit', listener);
    },
  },
});
