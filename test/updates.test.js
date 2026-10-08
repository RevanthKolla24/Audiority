const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startUpdates } = require('../src/updates');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(overrides = {}) {
  const updater = new EventEmitter();
  const calls = { checks: 0, installs: 0, prepared: 0, dialogs: [], pages: [], warnings: [] };
  updater.checkForUpdatesAndNotify = async () => { calls.checks++; };
  updater.quitAndInstall = (silent, restart) => { assert.equal(silent, false); assert.equal(restart, true); calls.installs++; };
  const options = {
    app: { isPackaged: true }, updater, platform: 'win32',
    dialog: { showMessageBox: async value => { calls.dialogs.push(value); return { response: 0 }; } },
    shell: { openExternal: async url => { calls.pages.push(url); } },
    isBusy: () => false,
    prepareInstall: async () => { calls.prepared++; return true; },
    warn: message => calls.warnings.push(message), ...overrides
  };
  return { calls, updater, stop: startUpdates(options) };
}

test('development and unsupported platforms never check for updates', async () => {
  for (const overrides of [{ app: { isPackaged: false } }, { platform: 'linux' }]) {
    const f = fixture(overrides); await flush();
    assert.equal(f.calls.checks, 0); assert.equal(f.updater.listenerCount('update-available'), 0); f.stop();
  }
});

test('Windows downloads updates but installs only after confirmation and queue preparation', async () => {
  const f = fixture();
  try {
    await flush(); assert.equal(f.calls.checks, 1);
    assert.equal(f.updater.autoDownload, true); assert.equal(f.updater.autoInstallOnAppQuit, false);
    f.updater.emit('update-available', { version: '1.0.4' }); await flush();
    assert.equal(f.calls.dialogs.length, 0);
    f.updater.emit('update-downloaded', { version: '1.0.4' }); await flush();
    assert.equal(f.calls.prepared, 1); assert.equal(f.calls.installs, 1);
    assert.deepEqual(f.calls.dialogs[0].buttons, ['Install and restart', 'Later']);
  } finally { f.stop(); }
});

test('unsigned macOS checks but never downloads or installs and opens only the fixed release page', async () => {
  const f = fixture({ platform: 'darwin' });
  try {
    await flush(); assert.equal(f.updater.autoDownload, false);
    f.updater.emit('update-available', { version: '1.0.4', url: 'https://untrusted.invalid' }); await flush();
    assert.deepEqual(f.calls.pages, ['https://github.com/RevanthKolla24/Audiority/releases/latest']);
    assert.equal(f.calls.installs, 0); assert.equal(f.calls.prepared, 0);
  } finally { f.stop(); }
});

test('busy work defers prompts and rechecks work started while a dialog was open', async () => {
  let busy = true;
  const f = fixture({ isBusy: () => busy, dialog: { showMessageBox: async () => { busy = true; return { response: 0 }; } } });
  try {
    f.updater.emit('update-downloaded', { version: '1.0.4' }); await flush();
    assert.equal(f.calls.installs, 0);
    busy = false; f.updater.emit('update-downloaded', { version: '1.0.4' }); await flush();
    assert.equal(f.calls.prepared, 0); assert.equal(f.calls.installs, 0);
  } finally { f.stop(); }
});

test('Later never installs, and persistence failure leaves installation blocked', async () => {
  for (const overrides of [
    { dialog: { showMessageBox: async () => ({ response: 1 }) } },
    { prepareInstall: async () => { throw new Error('Queue save failed'); } }
  ]) {
    const f = fixture(overrides);
    try { f.updater.emit('update-downloaded', { version: '1.0.4' }); await flush(); assert.equal(f.calls.installs, 0); }
    finally { f.stop(); }
  }
});

test('network errors and shutdown are safe and do not reject app startup', async () => {
  const f = fixture();
  await flush(); f.updater.emit('error', new Error('Offline')); assert.match(f.calls.warnings[0], /Offline/);
  f.stop(); f.updater.emit('error', new Error('Request aborted')); f.updater.emit('update-downloaded', { version: '1.0.4' });
  await flush(); assert.equal(f.calls.warnings.length, 1); assert.equal(f.calls.installs, 0);
});