/*
 * main.js
 * Coordinates Electron in the invisible background process. Talks to the web UI through preload.js. Guide: queue persistence; imports; startup recovery; secure window; IPC handlers; conversion runner; shutdown.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
// Electron's main process can access the OS; the renderer is a restricted web page.
// app controls lifecycle, BrowserWindow hosts that page, and ipcMain receives bridge requests.
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Engine } = require('./engine');
const { nextQueueItem } = require('./queue-priority');
const { trashOriginal } = require('./trash-original');
const { toolPaths } = require('./tools');
const { receivers, devices } = require('./catalog');
const { defaultSettings, validateSettings, resolveProfile } = require('./profiles');
const { loadLibrary, saveLibrary, mutateLibrary, emptyLibrary } = require('./profile-library');
const fs = require('node:fs/promises');
const { discoverMedia } = require('./imports');
const { WatchFolder } = require('./watch-folder');
const watcher = new WatchFolder();
let watchTimer, watchBusy = false, watchStopping = false, watchWarning = '';
// Import only when idle; users still review plans and start conversions.
async function pollWatchFolder() {
  if (watchStopping || watchBusy || !preferences.watchEnabled || !settings || running || importing || profileBusy || appStateBusy) return;
  watchBusy = true;
  try {
    const folder = preferences.watchFolder;
    const ready = await watcher.scan(folder, { outputSuffix: preferences.outputSuffix });
    if (watchStopping || folder !== preferences.watchFolder || !preferences.watchEnabled || running || importing || profileBusy || appStateBusy) return;
    if (ready.length) await addFiles(ready);
    watcher.mark([...items.values()].map(item => item.file));
    watchWarning = '';
  } catch (error) {
    if (!watchStopping && error.message !== watchWarning) {
      watchWarning = error.message; send('queue-warning', { message: `Watch folder: ${error.message}` });
    }
  } finally { watchBusy = false; }
}
const { builtins, tokenNames, loadThemes, saveThemes, mutateThemes, validateTheme } = require('./themes');
const { preferencesDefaults, validatePreferences, statsDefaults, validateStats, recordJob, loadState, saveState, inspectInOrder, loadQueue, saveQueue, cleanupInterrupted, cleanupOrphanedTempFiles } = require('./app-state');
let preferences = preferencesDefaults(), stats = statsDefaults(), preferencesWarning = '', statsWarning = '', appStateBusy = false;

let window, engine, outputDirectory = '', running = false, importing = false, profileBusy = false, controller, settings = null, settingsWarning = '', library = emptyLibrary();
const items = new Map();
let isQueuePaused = false, queueResumeResolver = null, queuePausePromise = null;
// Pause gates the next job, not the FFmpeg process already producing an output.
function resumeQueue() {
  isQueuePaused = false;
  const resolve = queueResumeResolver;
  queueResumeResolver = null; queuePausePromise = null;
  resolve?.();
  send('paused', { value: false });
}
function cancelQueue() {
  controller?.abort();
  // Wake a paused runner so it can observe cancellation and reach its finally block.
  resumeQueue();
}
let importController, appearance, appearanceWarning = '', appearanceBusy = false;
const page = path.join(__dirname, 'ui', 'index.html');
let queueWrites = Promise.resolve();
// Snapshots recovery fields and returns a serialized write Promise so older saves cannot overtake newer state.
function persistQueue(required = false) {
  const snapshot = new Map([...items].map(([id, item]) => [id, structuredClone(Object.fromEntries(['id', 'file', 'status', 'output', 'temporaryOutput', 'relativeDirectory', 'sidecars', 'importWarnings', 'error', 'priority'].map(key => [key, item[key]])))]));
  const write = queueWrites.then(() => saveQueue(app.getPath('userData'), snapshot));
  queueWrites = write.catch(error => send('queue-warning', { message: `Queue could not be saved: ${error.message}` }));
  return required ? write : queueWrites;
}
// Send: receives type, data. See the return statements below for the result; async results are Promises.
function send(type, data) {
  if (type === 'status' && items.has(data.id)) {
    const item = items.get(data.id); const changed = item.status !== data.status;
    Object.assign(item, data);
    if (changed || data.output) persistQueue();
  }
  if (window && !window.isDestroyed()) window.webContents.send('update', { type, ...data });
}
// Handle: receives channel, handler. See the return statements below for the result; async results are Promises.
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(page).href) throw new Error('Untrusted request');
    return handler(...args);
  });
}
// Add files: receives paths. See the return statements below for the result; async results are Promises.
async function addFiles(paths) {
  if (running || importing || profileBusy || appStateBusy) throw new Error('Wait for the current operation to finish before importing.');
  if (!settings) throw new Error('Complete playback setup before importing files.');
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Invalid file/folder selection.');
  importing = true;
  importController = new AbortController();
  send('importing', { value: true });
  const known = new Set([...items.values()].map(i => process.platform === 'win32' ? i.file.toLowerCase() : i.file));
  const warnings = []; let inspected = 0, duplicates = 0, failures = 0, discovery = {};
  let reportedAt = 0;
  const report = () => { if (Date.now() - reportedAt < 150) return; reportedAt = Date.now(); send('import-progress', { ...discovery, inspected, duplicates, failures }); };
  const candidates = async function* () { for await (const candidate of discoverMedia([...new Set(paths)], { outputDirectory, outputSuffix: preferences.outputSuffix, signal: importController.signal, onWarning: warning => { if (warnings.length < 30) warnings.push(warning); }, onProgress: value => { discovery = value; report(); } })) {
    const { file } = candidate;
    const fileKey = process.platform === 'win32' ? file.toLowerCase() : file;
    if (known.has(fileKey)) { duplicates++; continue; }
    known.add(fileKey);
    yield { ...candidate, id: crypto.randomUUID() };
  } };
  try { await inspectInOrder(candidates(), candidate => engine.inspect(candidate.file, { signal: importController.signal }), async ({ candidate, value: item, error }) => {
    const { id, file } = candidate;
    if (!error) {
      Object.assign(item, { id, relativeDirectory: candidate.relativeDirectory, sidecars: candidate.sidecars, importWarnings: candidate.warnings });
      items.set(id, item);
      publishItem(item, id);
      await persistQueue();
    } else { failures++; send('item', { item: { id, name: path.basename(file), status: importController.signal.aborted ? 'Cancelled' : 'Error', error: error.message, tracks: [] } }); }
    inspected++; report();
  }, preferences.inspectionConcurrency, importController.signal); } catch (error) { if (!importController.signal.aborted) throw error; }
  finally {
    send('import-result', { inspected, duplicates, failures, skipped: discovery.skipped || 0, cancelled: importController.signal.aborted, warnings });
    await persistQueue();
    importing = false; importController = null; send('importing', { value: false });
  }
}
// Publish item: receives item, id = item.id. See the return statements below for the result; async results are Promises.
function publishItem(item, id = item.id) {
    item.status = item.output ? 'Complete' : ['Error', 'Cancelled'].includes(item.status) ? item.status : item.plan.needsConversion ? 'Ready' : item.plan.unresolved ? 'Needs attention' : 'Unchanged';
    send('item', { item: { id, needsConversion: item.plan.needsConversion, droppedStreams: item.plan.droppedStreams, priority: item.priority, name: item.name, relativeDirectory: item.relativeDirectory, subtitleInfo: item.subtitleInfo, sidecarCount: item.sidecars?.length || 0, size: item.size, duration: item.duration, tracks: item.plan.tracks, warnings: [...item.plan.warnings, ...(item.importWarnings || [])], status: item.status, error: item.error || '', output: item.output || '' } });
}

app.whenReady().then(async () => {
  engine = new Engine(toolPaths(app.isPackaged ? process.resourcesPath : null));
  const loadedPreferences = await loadState(app.getPath('userData'), 'app-settings.json', preferencesDefaults, validatePreferences);
  preferences = loadedPreferences.state; preferencesWarning = loadedPreferences.warning;
  engine.setPreferences(preferences);
  outputDirectory = preferences.rememberOutput ? preferences.outputDirectory : '';
  const loadedStats = await loadState(app.getPath('userData'), 'statistics.json', statsDefaults, validateStats);
  stats = loadedStats.state; statsWarning = loadedStats.warning;
  const loaded = await loadLibrary(app.getPath('userData'));
  library = loaded.library; settings = library.profiles.find(p => p.id === library.activeId)?.settings || null; settingsWarning = loaded.warning;
  if (settings) engine.setProfile(resolveProfile(settings));
  const loadedAppearance = await loadThemes(app.getPath('userData'));
  appearance = loadedAppearance.state; appearanceWarning = loadedAppearance.warning;
  const recovered = await loadQueue(app.getPath('userData'), preferences);
  // Await the one-time sweep before creating a window, registering job IPC or polling.
  // Queue paths also cover previous destinations when the global destination changed.
  const cleanupDirectories = [outputDirectory, ...recovered.state.items.flatMap(item =>
    [item.temporaryOutput, item.output].filter(Boolean).map(file => path.dirname(file)))];
  await cleanupOrphanedTempFiles(cleanupDirectories);
  const recoveryWarnings = recovered.warning ? [recovered.warning] : [];
  const unfinished = recovered.state.items.some(item => !['Complete', 'Unchanged'].includes(item.status));
  const restore = !unfinished || dialog.showMessageBoxSync({ type: 'question', buttons: ['Restore Queue', 'Discard'], defaultId: 0, cancelId: 1, message: 'You have an unfinished queue from your last session. Would you like to restore it?', detail: 'Interrupted jobs restart from the beginning. Recorded temporary outputs will be cleaned up.' }) === 0;
  recoveryWarnings.push(...await cleanupInterrupted(recovered.state.items));
  if (restore) for (const saved of recovered.state.items) {
    try {
      const item = await engine.inspect(saved.file);
      Object.assign(item, saved, { temporaryOutput: '' });
      if (item.output) { try { await fs.access(item.output); } catch { item.output = ''; } }
      if (['Converting', 'Verifying', 'Complete'].includes(item.status) && !item.output) { item.status = 'Ready'; item.error = ''; }
      items.set(item.id, item);
      publishItem(item);
    } catch (error) {
      let completed = false;
      if (saved.output) { try { const output = await fs.lstat(saved.output); completed = output.isFile() && !output.isSymbolicLink() && output.size > 0; } catch {} }
      items.set(saved.id, { ...saved, name: path.basename(saved.file), size: 0, duration: 0, output: completed ? saved.output : '', temporaryOutput: '', status: completed ? 'Complete' : 'Error', error: completed ? '' : `Recovery: ${error.message}`, plan: { tracks: [], warnings: [completed ? 'Original source unavailable (it may have been moved to Trash); completed output is retained.' : 'Source unavailable; re-import before converting again.'], needsConversion: false } });
    }
  }
  if (!recovered.warning) await persistQueue();
  // Isolation keeps preload privileges separate; sandbox and no Node integration restrict UI code.
  window = new BrowserWindow({ width: 1240, height: 850, minWidth: 960, minHeight: 680, backgroundColor: '#f5f5f3', title: 'Audiority', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('did-finish-load', () => {
    for (const item of items.values()) publishItem(item);
    for (const message of recoveryWarnings) send('queue-warning', { message });
  });
  window.on('close', event => {
    if (!running && !importing) return;
    const choice = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['Keep working', 'Cancel and quit'], defaultId: 0, cancelId: 0, message: importing ? 'A folder/file import is in progress.' : 'A conversion is in progress.' });
    event.preventDefault();
    if (choice === 1) { cancelQueue(); importController?.abort(); const wait = setInterval(() => { if (!running && !importing) { clearInterval(wait); window.destroy(); app.quit(); } }, 100); }
  });
  handle('pick-files', async () => {
    const selection = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'], title: 'Import video or audio files' });
    if (!selection.canceled) await addFiles(selection.filePaths);
  });
  handle('add-files', addFiles);
  handle('pick-import-folder', async () => {
    const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'multiSelections'], title: 'Import show or media folders (includes subfolders)' });
    if (!selection.canceled) await addFiles(selection.filePaths);
  });
  handle('cancel-import', () => importController?.abort());
  handle('pick-watch-folder', async () => {
    const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: 'Choose watch folder' });
    return selection.canceled ? '' : selection.filePaths[0];
  });
  handle('get-app-settings', () => ({ preferences, warning: preferencesWarning, outputDirectory, version: app.getVersion() }));
  handle('save-app-settings', async value => {
    if (running || importing || profileBusy || appStateBusy) throw new Error('Wait for the current operation to finish before saving settings.');
    appStateBusy = true;
    try {
      const next = validatePreferences({ ...value, outputDirectory });
      if (next.watchFolder !== preferences.watchFolder || next.watchEnabled !== preferences.watchEnabled || next.outputSuffix !== preferences.outputSuffix) watcher.reset();
      preferences = await saveState(app.getPath('userData'), 'app-settings.json', next, validatePreferences);
      preferencesWarning = '';
      engine.setPreferences(preferences);
      for (const item of items.values()) if (item.probe) { engine.replan(item); publishItem(item); }
      await persistQueue();
      if (!preferences.storeFilenames) {
        stats.recent.forEach(job => { delete job.filename; });
        if (!statsWarning) { stats = await saveState(app.getPath('userData'), 'statistics.json', stats, validateStats); await fs.unlink(path.join(app.getPath('userData'), 'statistics.json.bak')).catch(() => {}); }
      }
      return { preferences, outputDirectory, warning: preferencesWarning };
    } finally { appStateBusy = false; }
  });
  handle('get-statistics', () => ({ stats, warning: statsWarning, enabled: preferences.statsEnabled }));
  handle('statistics-operation', async action => {
    if (running || appStateBusy) throw new Error('Wait until conversion/settings finish.');
    appStateBusy = true;
    try {
      if (action === 'reset') {
        const choice = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', 'Reset statistics'], defaultId: 0, cancelId: 0, message: 'Reset all local conversion statistics? Media files will not be touched.' });
        if (choice.response === 1) { stats = await saveState(app.getPath('userData'), 'statistics.json', statsDefaults(), validateStats, { reset: true }); await fs.unlink(path.join(app.getPath('userData'), 'statistics.json.bak')).catch(() => {}); statsWarning = ''; }
      } else if (action === 'export') {
        const selection = await dialog.showSaveDialog(window, { title: 'Export statistics', defaultPath: 'audiority-statistics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (!selection.canceled) await fs.writeFile(selection.filePath, JSON.stringify(stats, null, 2));
      } else throw new Error('Invalid statistics operation.');
      return { stats, warning: statsWarning, enabled: preferences.statsEnabled };
    } finally { appStateBusy = false; }
  });
  handle('export-diagnostics', async () => {
    const selection = await dialog.showSaveDialog(window, { defaultPath: 'audiority-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!selection.canceled) await fs.writeFile(selection.filePath, JSON.stringify({ version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron, encoders: engine.capabilities, tools: await engine.toolVersions(), limitations: ['MKV only', 'No video/GPU audio encoding', 'Development FFmpeg redistribution blocked', 'Windows validation outstanding'] }, null, 2));
  });
  const appearanceState = () => ({ state: appearance, builtins, tokenNames, warning: appearanceWarning });
  handle('get-appearance', appearanceState);
  handle('theme-operation', async action => {
    if (appearanceBusy) throw new Error('Wait for the previous appearance change.');
    appearanceBusy = true;
    try {
      if (action?.type === 'import') {
        const selection = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Audiority theme', extensions: ['json'] }] });
        if (selection.canceled) return appearanceState();
        const file = selection.filePaths[0];
        if ((await fs.stat(file)).size > 65536) throw new Error('Theme files must be smaller than 64 KB.');
        action = { type: 'save', theme: validateTheme(JSON.parse(await fs.readFile(file, 'utf8'))) };
      }
      if (action?.type === 'export') {
        const theme = [...builtins, ...appearance.custom].find(t => t.id === action.id);
        if (!theme) throw new Error('Theme not found.');
        const selection = await dialog.showSaveDialog(window, { defaultPath: `${theme.name.replace(/[^a-zA-Z0-9 -]/g, '') || 'theme'}.json`, filters: [{ name: 'Audiority theme', extensions: ['json'] }] });
        if (!selection.canceled) await fs.writeFile(selection.filePath, JSON.stringify(validateTheme({ ...theme, version: 1 }), null, 2));
      } else appearance = await saveThemes(app.getPath('userData'), mutateThemes(appearance, action));
      return appearanceState();
    } finally { appearanceBusy = false; }
  });
  const setupState = () => ({ receivers, devices, defaults: defaultSettings(), library, settings, profile: settings ? resolveProfile(settings) : null, warning: settingsWarning });
  handle('get-setup', setupState);
  handle('preview-profile', value => resolveProfile(validateSettings(value)));
  handle('profile-operation', async action => {
    if (running || importing || profileBusy || appStateBusy) throw new Error('Wait until the current operation finishes before changing profiles.');
    profileBusy = true;
    try {
      if (!action || typeof action !== 'object') throw new Error('Invalid profile operation.');
      const previousId = library.activeId;
      const previousSettings = JSON.stringify(settings);
      library = await saveLibrary(app.getPath('userData'), mutateLibrary(library, action));
      settings = library.profiles.find(p => p.id === library.activeId)?.settings || null;
      engine.setProfile(settings ? resolveProfile(settings) : null);
      if (previousId !== library.activeId || previousSettings !== JSON.stringify(settings)) {
        for (const item of items.values()) {
          if (settings && item.probe) engine.replan(item);
          delete item.output;
          publishItem(item);
        }
      }
      settingsWarning = '';
      await persistQueue();
      return setupState();
    } finally { profileBusy = false; }
  });
  handle('pick-output', async () => {
    if (running || importing || appStateBusy) throw new Error('Wait until the current operation finishes before changing output folder.');
    const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], title: 'Choose output folder' });
    if (running || importing || appStateBusy) throw new Error('Wait until the current operation finishes before changing output folder.');
    if (!selection.canceled) {
      appStateBusy = true;
      try {
        if (preferences.rememberOutput) preferences = await saveState(app.getPath('userData'), 'app-settings.json', { ...preferences, outputDirectory: selection.filePaths[0] }, validatePreferences);
        outputDirectory = selection.filePaths[0];
      } finally { appStateBusy = false; }
    }
    return outputDirectory;
  });
  handle('clear', () => { if (running || importing) throw new Error('Queue is busy.'); items.clear(); return persistQueue(true); });
  handle('cancel', cancelQueue);
  handle('pause', () => {
    if (!running || controller?.signal.aborted) return false;
    if (!isQueuePaused) {
      isQueuePaused = true;
      queuePausePromise = new Promise(resolve => { queueResumeResolver = resolve; });
      send('paused', { value: true });
    }
    return true;
  });
  handle('resume', () => { resumeQueue(); return false; });
  handle('prioritize-item', async id => {
    if (typeof id !== 'string' || !items.has(id)) throw new Error('Unknown queue item.');
    const item = items.get(id);
    if (item.status !== 'Ready' || item.output || !item.plan?.needsConversion) throw new Error('Only Ready items can be prioritized.');
    if (importing || profileBusy || appStateBusy) throw new Error('Wait for import or settings to finish.');
    // Monotonic even for multiple clicks within the same millisecond.
    let priority = Date.now();
    for (const candidate of items.values()) priority = Math.max(priority, (candidate.priority || 0) + 1);
    if (!Number.isSafeInteger(priority)) throw new Error('Queue priority limit exceeded.');
    item.priority = priority;
    publishItem(item);
    await persistQueue(true);
    return item.priority;
  });
  handle('reveal', id => { const item = items.get(id); if (item?.output) shell.showItemInFolder(item.output); });
  handle('start', async () => {
    if (running || profileBusy || appStateBusy) throw new Error('Queue or settings operation is already running.');
    if (importing || !settings) throw new Error('Finish import and playback setup first.');
    if (!outputDirectory) throw new Error('Choose an output folder first.');
    running = true;
    resumeQueue();
    controller = new AbortController();
    send('running', { value: true });
    const sleepBlocker = preferences.preventSleep ? powerSaveBlocker.start('prevent-app-suspension') : null;
    const record = async (status, item, started, outputBytes = 0) => {
      if (!preferences.statsEnabled) return;
      try {
        const next = recordJob(stats, { status, item, outputBytes, seconds: (performance.now() - started) / 1000, profile: library.profiles.find(p => p.id === library.activeId)?.name || '', storeFilenames: preferences.storeFilenames });
        stats = await saveState(app.getPath('userData'), 'statistics.json', next, validateStats);
        send('statistics-changed', {});
      } catch (error) { statsWarning = `Statistics could not be saved: ${error.message}. Conversion results are unaffected.`; send('statistics-changed', {}); }
    };
    try {
      const attempted = new Set();
      while (true) {
        if (controller.signal.aborted) break;
        const item = nextQueueItem(items, attempted);
        if (!item) break;
        // No work means completion, even if Pause was clicked during the final job.
        // After waking, rescan: priorities may have changed while we were waiting.
        if (isQueuePaused) { await queuePausePromise; continue; }
        attempted.add(item.id);
        send('status', { id: item.id, status: 'Converting', progress: 0, error: '' });
        const started = performance.now(); let lastProgressAt = 0;
        try {
          const result = await engine.convert(item, outputDirectory, { signal: controller.signal, preferences, onTemporaryOutput: async temp => { item.temporaryOutput = temp; await persistQueue(true); }, onProgress: progress => { if (progress < 0.99 && Date.now() - lastProgressAt < 150) return; lastProgressAt = Date.now(); send('status', { id: item.id, status: progress >= 0.99 && progress < 1 ? 'Verifying' : 'Converting', progress }); } });
          item.output = result.output;
          // Persist the verified output before an optional source move, so a crash during
          // Trash cannot make recovery lose the successfully published destination.
          await persistQueue(true);
          result.warnings.push(...await trashOriginal(item, result, {
            enabled: preferences.trashOriginals, signal: controller.signal,
            trashItem: file => shell.trashItem(file)
          }));
          send('status', { id: item.id, status: 'Complete', progress: 1, output: result.output, warnings: result.warnings });
          await record('completed', item, started, result.outputBytes);
        } catch (error) { send('status', { id: item.id, status: controller.signal.aborted ? 'Cancelled' : 'Error', error: error.message }); await record(controller.signal.aborted ? 'cancelled' : 'failed', item, started); }
      }
    } finally { resumeQueue(); if (sleepBlocker !== null) powerSaveBlocker.stop(sleepBlocker); await persistQueue(); running = false; controller = null; send('running', { value: false }); }
  });
  window.loadFile(page);
  watchTimer = setInterval(() => { void pollWatchFolder(); }, 30000);
});
let queueQuitReady = false;
app.on('before-quit', event => {
  if (queueQuitReady) return;
  event.preventDefault();
  watchStopping = true; clearInterval(watchTimer);
  cancelQueue(); importController?.abort();
  (async () => {
    while (running || importing || watchBusy) await new Promise(resolve => setTimeout(resolve, 50));
    await queueWrites; queueQuitReady = true; app.quit();
  })();
});
app.on('window-all-closed', () => app.quit());