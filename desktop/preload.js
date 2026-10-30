// The small bridge the pages can use inside the Windows program.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('saydalitiDesktop', {
  saveBackup: (name, json, manual) => ipcRenderer.invoke('backup:save', name, json, !!manual),
  printSilent: () => ipcRenderer.invoke('print:silent'),
  // The start page: online (the account on the Cloudflare site) or on this computer only.
  setMode: (mode) => ipcRenderer.invoke('mode:set', mode),
  // Back to the start page to switch between online and this computer.
  chooseMode: () => ipcRenderer.invoke('mode:choose'),
  // Live sync with United (Genius) on this computer.
  genius: {
    find: (o) => ipcRenderer.invoke('genius:find', o),
    enable: (o) => ipcRenderer.invoke('genius:enable', o),
    disable: () => ipcRenderer.invoke('genius:disable'),
    status: () => ipcRenderer.invoke('genius:status'),
    now: () => ipcRenderer.invoke('genius:now'),
  },
});
