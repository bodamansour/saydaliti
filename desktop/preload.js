// The small bridge the pages can use inside the Windows program.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('saydalitiDesktop', {
  saveBackup: (name, json, manual) => ipcRenderer.invoke('backup:save', name, json, !!manual),
  printSilent: () => ipcRenderer.invoke('print:silent'),
  // The start page: online (the account on the Cloudflare site) or on this computer only.
  setMode: (mode) => ipcRenderer.invoke('mode:set', mode),
});
