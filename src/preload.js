const { contextBridge, ipcRenderer, webUtils } = require('electron');
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
  pickOutput: () => ipcRenderer.invoke('pick-output'),
  start: () => ipcRenderer.invoke('start'),
  cancel: () => ipcRenderer.invoke('cancel'),
  clear: () => ipcRenderer.invoke('clear'),
  reveal: id => ipcRenderer.invoke('reveal', id),
  onUpdate: callback => { ipcRenderer.on('update', (_event, update) => callback(update)); }
});