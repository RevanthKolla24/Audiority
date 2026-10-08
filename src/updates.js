/*
 * updates.js
 * Runs in Electron's main process. Checks packaged apps for GitHub releases.
 * Windows downloads updates; unsigned macOS offers a manual release download.
 * Tests inject a fake updater without contacting GitHub or installing software.
 */
const releasesPage = 'https://github.com/RevanthKolla24/Audiority/releases/latest';

// Receives OS services and queue guards; returns a shutdown cleanup function.
function startUpdates({ app, updater, dialog, shell, platform = process.platform, isBusy, prepareInstall, warn = console.warn }) {
  if (!app.isPackaged || !['darwin', 'win32'].includes(platform)) return () => {};
  let stopped = false, pending = null, prompting = false;
  updater.autoDownload = platform === 'win32';
  // Queue persistence must finish before installation; never install on ordinary quit.
  updater.autoInstallOnAppQuit = false;
  const report = error => { if (!stopped) warn(`Update check failed: ${error.message || error}`); };
  const offer = async () => {
    if (stopped || !pending || prompting || isBusy()) return;
    prompting = true;
    const info = pending;
    pending = null;
    try {
      const mac = platform === 'darwin';
      const result = await dialog.showMessageBox({
        type: 'info', title: 'Audiority update',
        message: `Audiority ${info.version} ${mac ? 'is available' : 'is ready to install'}.`,
        detail: mac ? 'This macOS build is unsigned. Download and install the new version manually from the official release page.' : 'Installation will close Audiority. Your queue will be saved. Windows may request administrator permission.',
        buttons: [mac ? 'Open release page' : 'Install and restart', 'Later'],
        defaultId: 1, cancelId: 1
      });
      if (stopped || result.response !== 0) return;
      if (mac) await shell.openExternal(releasesPage);
      else if (isBusy()) pending = info;
      else if (await prepareInstall()) updater.quitAndInstall(false, true);
      else pending = info;
    } catch (error) { report(error); }
    finally { prompting = false; }
  };
  const available = info => { if (platform === 'darwin') { pending = info; void offer(); } };
  const downloaded = info => { if (platform === 'win32') { pending = info; void offer(); } };
  updater.on('error', report);
  updater.on('update-available', available);
  updater.on('update-downloaded', downloaded);
  // Builder-generated app-update.yml supplies the feed. Never embed a token.
  Promise.resolve().then(() => { if (!stopped) return updater.checkForUpdatesAndNotify(); }).catch(report);
  const timer = setInterval(() => { void offer(); }, 30000);
  timer.unref?.();
  return () => {
    stopped = true; clearInterval(timer);
    // Keep the quiet error listener: an in-flight network request may fail on quit.
    updater.removeListener('update-available', available);
    updater.removeListener('update-downloaded', downloaded);
  };
}
module.exports = { startUpdates };