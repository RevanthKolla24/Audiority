const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startUpdates } = require('../src/updates');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('update state surfaces download progress and errors, retries, and retains Later installs', async () => {
  let prompts = 0;
  const f = fixture({ dialog: { showMessageBox: async () => { prompts++; return { response: 1 }; } } });
  try {
    await flush();
    f.updater.emit('update-available', { version: '2.0.0' });
    f.updater.emit('download-progress', { percent: 42.7 });
    assert.equal(f.stop.getState().percent, 42.7);
    f.updater.emit('error', new Error('HTTP 404'));
    assert.equal(f.stop.getState().status, 'error');
    assert.match(f.stop.getState().error, /404/);
    await f.stop.check();
    assert.equal(f.calls.checks, 2);
    f.updater.emit('update-downloaded', { version: '2.0.0' }); await flush();
    assert.equal(f.stop.getState().status, 'ready');
    assert.equal(prompts, 1);
    await f.stop.install();
    assert.equal(prompts, 2);
    assert.equal(f.calls.checks, 2);
  } finally { f.stop(); }
});

test('manual update checks do not overlap', async () => {
  const f = fixture();
  try {
    await flush();
    let release;
    f.updater.checkForUpdatesAndNotify = () => new Promise(resolve => { release = resolve; f.calls.checks++; });
    const pending = f.stop.check(); await flush();
    await f.stop.check();
    assert.equal(f.calls.checks, 2);
    release(); await pending;
  } finally { f.stop(); }
});

test('installer exceptions and emitted errors roll back shutdown locks and allow retry', async () => {
  for (const emitted of [false, true]) {
    let locked = false, rollbacks = 0;
    const f = fixture({ isBusy: () => locked,
      prepareInstall: async () => { locked = true; return true; },
      rollbackInstall: () => { locked = false; rollbacks++; }
    });
    try {
      await flush();
      f.updater.quitAndInstall = () => {
        if (emitted) f.updater.emit('error', new Error('installer failed'));
        else throw new Error('installer failed');
      };
      f.updater.emit('update-downloaded', { version: '2.0.0' }); await flush();
      assert.equal(locked, false);
      assert.equal(rollbacks, 1);
      assert.equal(f.stop.getState().status, 'error');
      assert.equal(f.stop.getState().canInstall, true);
      assert.equal(f.updater.listenerCount('update-downloaded'), 1);
      f.updater.quitAndInstall = () => { f.calls.installs++; };
      await f.stop.install();
      assert.equal(f.calls.installs, 1);
      assert.equal(locked, true);
      assert.equal(f.stop.getState().status, 'installing');
    } finally { f.stop(); }
  }
});

test('main-process install rollback restores shutdown gates and watch polling without removing update listeners', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  let options, polls = 0, stopped = 0, saved = 0;
  const context = vm.createContext({
    startUpdates: value => { options = value; return () => stopped++; },
    app: {}, autoUpdater: {}, dialog: {}, shell: {}, send() {},
    running: false, importing: false, watchBusy: false, profileBusy: false, appStateBusy: false, appearanceBusy: false,
    queueQuitPending: false, queueQuitReady: false, watchStopping: false, watchTimer: 1,
    clearInterval() {}, setInterval: () => { polls++; return polls; }, pollWatchFolder() {},
    persistQueue: async () => saved++, queueWrites: Promise.resolve()
  });
  vm.runInContext(source.slice(source.indexOf('stopUpdates = startUpdates('), source.indexOf('\n});\nlet queueQuitReady')), context);
  assert.equal(await options.prepareInstall(), true);
  assert.equal(saved, 1);
  assert.equal(context.watchStopping, true);
  assert.equal(context.queueQuitReady, true);
  assert.equal(options.isBusy(), true);
  options.rollbackInstall();
  assert.equal(options.isBusy(), false);
  assert.equal(context.queueQuitReady, false);
  assert.equal(context.watchStopping, false);
  assert.equal(polls, 2);
  assert.equal(stopped, 0);
  assert.equal(await options.prepareInstall(), true);
});

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