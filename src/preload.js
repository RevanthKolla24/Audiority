/*
 * preload.js
 * Isolated bridge between the UI and Electron. Exposes named operations instead of unrestricted Node.js access. Guide: request methods; dropped-file paths; backend update subscription.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');
// main.js enables contextIsolation (separate JS worlds), sandbox (restricted renderer),
// and disables nodeIntegration. The bridge grants specific operations, not filesystem access.
// invoke sends a request to ipcMain and returns a Promise; on listens for pushed updates.
contextBridge.exposeInMainWorld('audiority', {
  getSetup: () => ipcRenderer.invoke('get-setup'),
  previewProfile: value => ipcRenderer.invoke('preview-profile', value),
  profileOperation: action => ipcRenderer.invoke('profile-operation', action),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickImportFolder: () => ipcRenderer.invoke('pick-import-folder'),
  cancelImport: () => ipcRenderer.invoke('cancel-import'),
  getAppearance: () => ipcRenderer.invoke('get-appearance'),
  getAppSettings: () => ipcRenderer.invoke('get-app-settings'),
  saveAppSettings: value => ipcRenderer.invoke('save-app-settings', value),
  getStatistics: () => ipcRenderer.invoke('get-statistics'),
  statisticsOperation: action => ipcRenderer.invoke('statistics-operation', action),
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  themeOperation: action => ipcRenderer.invoke('theme-operation', action),
  addFiles: files => ipcRenderer.invoke('add-files', files.map(file => webUtils.getPathForFile(file))),
  pickWatchFolder: () => ipcRenderer.invoke('pick-watch-folder'),
  pickOutput: () => ipcRenderer.invoke('pick-output'),
  start: () => ipcRenderer.invoke('start'),
  prioritizeItem: id => ipcRenderer.invoke('prioritize-item', id),
  cancel: () => ipcRenderer.invoke('cancel'),
  pause: () => ipcRenderer.invoke('pause'),
  resume: () => ipcRenderer.invoke('resume'),
  clear: () => ipcRenderer.invoke('clear'),
  reveal: id => ipcRenderer.invoke('reveal', id),
  onUpdate: callback => { ipcRenderer.on('update', (_event, update) => callback(update)); }
});