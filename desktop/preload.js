// The small bridge the pages can use inside the Windows program.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('saydalitiDesktop', {
  saveBackup: (name, json, manual) => ipcRenderer.invoke('backup:save', name, json, !!manual),
  printSilent: () => ipcRenderer.invoke('print:silent'),
});
