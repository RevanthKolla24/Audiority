/*
 * updates.js
 * Runs in Electron's main process. Checks packaged apps for GitHub releases.
 * Windows downloads updates; unsigned macOS offers a manual release download.
 * Tests inject a fake updater without contacting GitHub or installing software.
 */
const releasesPage = 'https://github.com/RevanthKolla24/Audiority/releases/latest';

// Receives OS services and queue guards; returns a shutdown cleanup function.
function startUpdates({ app, updater, dialog, shell, platform = process.platform, isBusy, prepareInstall, rollbackInstall = () => {}, onState = () => {}, warn = console.warn }) {
  const supported = app.isPackaged && ['darwin', 'win32'].includes(platform);
  let state = { status: supported ? 'idle' : 'disabled', version: '', percent: 0, error: '' };
  const publish = change => { state = { ...state, ...change }; onState(state); };
  if (!supported) {
    const disabled = () => {};
    disabled.getState = () => state;
    disabled.check = disabled.install = async () => state;
    return disabled;
  }
  let stopped = false, pending = null, prompting = false, dismissed = false, checking = null, lastCheck = 0;
  updater.autoDownload = platform === 'win32';
  // Queue persistence must finish before installation; never install on ordinary quit.
  updater.autoInstallOnAppQuit = false;
  const report = error => {
    if (stopped) return;
    if (state.status === 'installing') {
      rollbackInstall();
      dismissed = true;
    }
    publish({ status: 'error', error: String(error.message || error), canInstall: !!pending });
    warn(`Update check failed: ${error.message || error}`);
  };
  const offer = async () => {
    if (stopped || !pending || prompting || dismissed || state.status === 'installing' || isBusy()) return;
    prompting = true;
    const info = pending;
    try {
      const mac = platform === 'darwin';
      const result = await dialog.showMessageBox({
        type: 'info', title: 'Audiority update',
        message: `Audiority ${info.version} ${mac ? 'is available' : 'is ready to install'}.`,
        detail: mac ? 'This macOS build is unsigned. Download and install the new version manually from the official release page.' : 'Installation will close Audiority. Your queue will be saved. Windows may request administrator permission.',
        buttons: [mac ? 'Open release page' : 'Install and restart', 'Later'],
        defaultId: 1, cancelId: 1
      });
      if (stopped) return;
      if (result.response !== 0) { dismissed = true; return; }
      if (mac) { dismissed = true; await shell.openExternal(releasesPage); }
      else if (isBusy()) pending = info;
      else if (await prepareInstall()) { publish({ status: 'installing', error: '', canInstall: false }); updater.quitAndInstall(false, true); }
      else pending = info;
    } catch (error) { dismissed = true; report(error); }
    finally { prompting = false; }
  };
  const available = info => { publish({ status: platform === 'win32' ? 'downloading' : 'available', version: info.version, error: '', percent: 0 }); if (platform === 'darwin') { pending = info; dismissed = false; void offer(); } };
  const downloaded = info => { if (platform === 'win32') { pending = info; dismissed = false; publish({ status: 'ready', version: info.version, percent: 100, error: '' }); void offer(); } };
  const progress = info => publish({ status: 'downloading', percent: Math.max(0, Math.min(100, Number(info.percent) || 0)) });
  const notAvailable = () => publish({ status: 'current', error: '' });
  updater.on('error', report);
  updater.on('update-available', available);
  updater.on('update-downloaded', downloaded);
  updater.on('download-progress', progress);
  updater.on('update-not-available', notAvailable);
  const check = async () => {
    if (stopped || checking || state.status === 'downloading' || state.status === 'installing') return state;
    if (pending) { publish({ status: platform === 'win32' ? 'ready' : 'available', error: '' }); return state; }
    lastCheck = Date.now(); publish({ status: 'checking', error: '' });
    checking = Promise.resolve().then(() => { if (!stopped) return updater.checkForUpdatesAndNotify(); }).catch(report);
    try { await checking; } finally { checking = null; }
    return state;
  };
  // Builder-generated app-update.yml supplies the feed. Never embed a token.
  void check();
  const timer = setInterval(() => { void offer(); if (!pending && Date.now() - lastCheck >= 4 * 60 * 60 * 1000) void check(); }, 30000);
  timer.unref?.();
  const stop = () => {
    stopped = true; clearInterval(timer);
    // Keep the quiet error listener: an in-flight network request may fail on quit.
    updater.removeListener('update-available', available);
    updater.removeListener('update-downloaded', downloaded);
    updater.removeListener('download-progress', progress);
    updater.removeListener('update-not-available', notAvailable);
  };
  stop.getState = () => state;
  stop.check = check;
  stop.install = async () => { dismissed = false; await offer(); return state; };
  return stop;
}
module.exports = { startUpdates };