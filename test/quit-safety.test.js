const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('recovery retry durably clears flags, rolls back failures, and survives repeated reloads', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const io = require('node:fs/promises');
  const { saveQueue, loadQueue } = require('../src/app-state');
  const dir = await io.mkdtemp(path.join(require('node:os').tmpdir(), 'audiority-retry-'));
  try {
    const item = { id: 'job', file: path.join(dir, 'source.mkv'), output: path.join(dir, 'output.mkv'),
      status: 'Complete', persistencePending: true, publicationPending: true, persistenceWarning: 'disk full', warnings: ['Existing warning'] };
    const items = new Map([[item.id, item]]);
    await saveQueue(dir, items);
    let handler, fail = true, notifications = 0;
    const before = structuredClone(item);
    const context = vm.createContext({
      handle: (_name, fn) => { handler = fn; }, running: false, profileBusy: false, appStateBusy: false, importing: false,
      items, persistQueue: async required => {
        assert.equal(required, true);
        assert.equal(item.persistencePending, false);
        assert.equal(item.publicationPending, false);
        assert.equal(notifications, 0);
        if (fail) throw new Error('disk full');
        await saveQueue(dir, items);
      }, send: (type, data) => {
        if (type === 'status') { notifications++; Object.assign(item, data); }
      }
    });
    vm.runInContext(source.slice(source.indexOf("handle('start',"), source.indexOf('  window.loadFile(page)')), context);
    await assert.rejects(handler(), /disk full/);
    assert.deepEqual(item, before);
    assert.equal(context.appStateBusy, false);
    assert.equal((await loadQueue(dir)).state.items[0].persistencePending, true);
    fail = false;
    await handler();
    assert.equal(notifications, 1);
    for (let restart = 0; restart < 2; restart++) {
      const restored = (await loadQueue(dir)).state.items[0];
      assert.equal(restored.persistencePending, false);
      assert.equal(restored.publicationPending, false);
      assert.equal(restored.persistenceWarning, '');
      assert.equal(restored.status, 'Complete');
      assert.ok(restored.warnings.some(warning => warning.includes('finalization was interrupted')));
      assert.equal(restored.warnings.filter(warning => warning.includes('retried successfully')).length, 1);
      await saveQueue(dir, new Map([[restored.id, restored]]));
    }
  } finally { await io.rm(dir, { recursive: true, force: true }); }
});

test('completed conversions survive failed recovery saves and retry without converting or trashing', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  let handler, conversions = 0, trashes = 0, failSave = true;
  const statuses = [];
  const item = { id: 'job', status: 'Ready' }, items = new Map([['job', item]]);
  const context = vm.createContext({
    handle: (_name, fn) => { handler = fn; }, running: false, profileBusy: false, appStateBusy: false,
    importing: false, settings: {}, outputDirectory: '/output', resumeQueue() {}, AbortController,
    preferences: { preventSleep: false, statsEnabled: true, trashOriginals: true },
    items, isQueuePaused: false, performance, library: { profiles: [] }, stats: {},
    app: { getPath: () => '/data' }, validateStats: value => value,
    recordJob: (stats, event) => { statuses.push(event.status); return stats; }, saveState: async (_dir, _name, value) => value,
    nextQueueItem: (_items, attempted) => !item.output && !attempted.has(item.id) ? item : null,
    engine: { convert: async () => { conversions++; return { output: '/verified.mkv', outputSnapshot: { size: 10 }, warnings: [], outputBytes: 10 }; } },
    persistQueue: async () => { if (failSave) throw new Error('disk full'); },
    trashOriginal: async () => { trashes++; return []; },
    send: (type, data) => { if (type === 'status') Object.assign(item, data); }
  });
  vm.runInContext(source.slice(source.indexOf("handle('start',"), source.indexOf('  window.loadFile(page)')), context);
  await assert.rejects(handler(), /disk full/); // Final flush also fails; controls still unlock.
  assert.equal(item.status, 'Complete');
  assert.equal(item.persistencePending, true);
  assert.match(item.persistenceWarning, /queue recovery could not be saved/);
  assert.ok(!item.warnings.some(warning => warning.includes('queue recovery could not be saved')));
  assert.equal(item.output, '/verified.mkv');
  assert.equal(context.running, false);
  assert.deepEqual(statuses, ['completed']);
  await assert.rejects(handler(), /disk full/);
  assert.equal(context.appStateBusy, false);
  failSave = false;
  // Saving existing results does not require an output folder or active profile.
  context.outputDirectory = ''; context.settings = null;
  await handler();
  assert.equal(item.persistencePending, false);
  assert.equal(item.persistenceWarning, '');
  assert.equal(conversions, 1); assert.equal(trashes, 0);
});

test('shutdown waits for profile, settings and appearance saves before quitting', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  let handler, saves = 0, quits = 0;
  const context = vm.createContext({
    app: { on: (name, fn) => { if (name === 'before-quit') handler = fn; }, quit: () => quits++ },
    running: false, importing: false, watchBusy: false, profileBusy: true, appStateBusy: true, appearanceBusy: true,
    watchStopping: false, watchTimer: 1, clearInterval() {}, cancelQueue() {}, importController: null,
    setTimeout, stopUpdates() {}, persistQueue: async () => { saves++; }
  });
  vm.runInContext(source.slice(source.indexOf('let queueQuitReady = false')), context);
  handler({ preventDefault() {} });
  assert.equal(saves, 0);
  context.profileBusy = false; context.appStateBusy = false;
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(saves, 0); assert.equal(quits, 0);
  context.appearanceBusy = false;
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(saves, 1); assert.equal(quits, 1);
});

test('publication persistence failure preserves verified media and stops finalization', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  let handler, savedPublication = false;
  const item = { id: 'job', status: 'Ready' };
  const context = vm.createContext({
    handle: (_channel, fn) => { handler = fn; }, running: false, importing: false, profileBusy: false, appStateBusy: false,
    settings: {}, outputDirectory: '/output', resumeQueue() {}, AbortController, performance,
    preferences: { statsEnabled: false }, items: new Map([['job', item]]), isQueuePaused: false,
    nextQueueItem: () => item.output ? null : item,
    engine: { convert: async (_item, _dir, options) => {
      await options.onPublished({ output: '/verified.mkv', outputSnapshot: { size: 100 } });
      assert.fail('Finalization must stop when publication persistence fails');
    } },
    persistQueue: async required => {
      if (required) { savedPublication = item.publicationPending && item.output === '/verified.mkv'; throw new Error('disk full'); }
    }, send: (type, data) => { if (type === 'status') Object.assign(item, data); }
  });
  vm.runInContext(source.slice(source.indexOf("handle('start',"), source.indexOf('  window.loadFile(page)')), context);
  await handler();
  assert.equal(savedPublication, true);
  assert.equal(item.status, 'Complete');
  assert.equal(item.persistencePending, true);
  assert.match(item.persistenceWarning, /subtitles may be incomplete/);
});

test('recheck outputs retains inaccessible references and unlocks valid restored outputs', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  let handler, state = 'unavailable';
  const item = { id: 'job', output: '/offline/output.mkv', outputUnavailable: true, plan: { tracks: [], warnings: [] } };
  const context = vm.createContext({
    handle: (_channel, fn) => { handler = fn; }, running: false, importing: false, profileBusy: false, appStateBusy: false,
    items: new Map([['job', item]]), nextQueueItem: () => null, send() {}, outputState: async () => state, persistQueue: async () => {}, publishItem() {}
  });
  vm.runInContext(source.slice(source.indexOf("handle('start',"), source.indexOf('  window.loadFile(page)')), context);
  await handler();
  assert.equal(item.outputUnavailable, true);
  assert.equal(item.output, '/offline/output.mkv');
  state = 'valid'; await handler();
  assert.equal(item.outputUnavailable, false);
  assert.equal(item.error, '');
  assert.equal(context.appStateBusy, false);
});

test('offline completed outputs do not prevent ready jobs from converting', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  let handler, converted = 0;
  const ready = { id: 'ready', status: 'Ready', plan: { needsConversion: true } };
  const offline = { id: 'offline', output: '/offline/verified.mkv', outputUnavailable: true };
  const items = new Map([['ready', ready], ['offline', offline]]);
  const context = vm.createContext({
    handle: (_name, fn) => { handler = fn; }, running: false, importing: false, profileBusy: false, appStateBusy: false,
    items, nextQueueItem: require('../src/queue-priority').nextQueueItem,
    settings: {}, outputDirectory: '/output', resumeQueue() {}, AbortController, performance, isQueuePaused: false,
    preferences: { statsEnabled: false }, persistQueue: async () => {},
    outputState: () => assert.fail('Unrelated conversions must not wait for offline output checks'),
    engine: { convert: async () => { converted++; return { output: '/new.mkv', outputSnapshot: { size: 10 }, warnings: [], outputBytes: 10 }; } },
    trashOriginal: async () => [], send: (type, data) => { if (type === 'status') Object.assign(items.get(data.id), data); }
  });
  vm.runInContext(source.slice(source.indexOf("handle('start',"), source.indexOf('  window.loadFile(page)')), context);
  await handler();
  assert.equal(converted, 1);
  assert.equal(ready.status, 'Complete');
  assert.equal(offline.output, '/offline/verified.mkv');
});

test('clear is rejected throughout delayed recovery saves and profile operations', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const handlers = {};
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const item = { id: 'job', output: '/verified.mkv', persistencePending: true };
  const context = vm.createContext({
    handle: (name, fn) => { handlers[name] = fn; }, running: false, importing: false, profileBusy: false, appStateBusy: false,
    items: new Map([['job', item]]), send() {}, persistQueue: () => pending
  });
  vm.runInContext(source.slice(source.indexOf("handle('clear',"), source.indexOf("  handle('cancel',")), context);
  vm.runInContext(source.slice(source.indexOf("handle('start',"), source.indexOf('  window.loadFile(page)')), context);
  const operation = handlers.start();
  assert.equal(context.appStateBusy, true);
  assert.throws(() => handlers.clear(), /busy/);
  assert.equal(context.items.size, 1);
  release(); await operation;
  context.profileBusy = true;
  assert.throws(() => handlers.clear(), /busy/);
  context.profileBusy = false;
  await handlers.clear();
  assert.equal(context.items.size, 0);
});

test('IPC rejects new work once shutdown begins', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  let handler, invoked = 0;
  const window = { webContents: {} }, page = '/trusted.html';
  const { pathToFileURL } = require('node:url');
  const context = vm.createContext({ ipcMain: { handle: (_name, fn) => { handler = fn; } }, window, page, pathToFileURL, queueQuitPending: true });
  vm.runInContext(source.slice(source.indexOf('function handle('), source.indexOf('// Add files:')), context);
  context.fn = () => invoked++;
  vm.runInContext("handle('save', fn)", context);
  await assert.rejects(handler({ sender: window.webContents, senderFrame: { url: pathToFileURL(page).href } }), /shutdown/);
  assert.equal(invoked, 0);
});

test('queue lifecycle unlocks after sleep-blocker start, stop or persistence errors', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  for (const failure of ['start', 'stop', 'save', 'none']) {
    let handler, saves = 0;
    const events = [];
    const context = vm.createContext({
      handle: (_name, fn) => { handler = fn; }, running: false, profileBusy: false,
      appStateBusy: false, importing: false, settings: {}, outputDirectory: '/output',
      resumeQueue() {}, AbortController, preferences: { preventSleep: true },
      send: (type, data) => events.push([type, data.value]),
      powerSaveBlocker: {
        start() { if (failure === 'start') throw new Error('start failed'); return 1; },
        stop() { if (failure === 'stop') throw new Error('stop failed'); }
      },
      nextQueueItem: () => null, items: new Map(),
      persistQueue: async () => { saves++; if (failure === 'save') throw new Error('save failed'); }
    });
    vm.runInContext(source.slice(source.indexOf("handle('start',"), source.indexOf('  window.loadFile(page)')), context);
    if (failure === 'none') await handler();
    else await assert.rejects(handler(), new RegExp(`${failure} failed`));
    assert.equal(context.running, false);
    assert.equal(context.controller, null);
    assert.equal(saves, 1);
    assert.deepEqual(events, [['running', true], ['running', false]]);
  }
});

test('cancel aborts and wakes the runner without prematurely unlocking the queue', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const controller = new AbortController();
  let resumed = 0;
  const context = vm.createContext({ controller, running: true, resumeQueue: () => resumed++, send: () => assert.fail('Cancellation must not announce idle') });
  vm.runInContext(source.slice(source.indexOf('function cancelQueue()'), source.indexOf('let importController')), context);
  vm.runInContext('cancelQueue()', context);
  assert.equal(controller.signal.aborted, true);
  assert.equal(resumed, 1);
  assert.equal(context.running, true);
});

// Exercise the actual shutdown handler without quitting the test runner.
test('failed final queue save blocks quit and allows a successful retry', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  let handler, fail = true;
  const calls = { saves: 0, quits: 0, warnings: [], stopped: 0, restarted: 0 };
  const context = vm.createContext({
    app: { on: (name, fn) => { if (name === 'before-quit') handler = fn; }, quit: () => calls.quits++ },
    running: false, importing: false, watchBusy: false, profileBusy: false, appStateBusy: false, appearanceBusy: false, watchStopping: false, watchTimer: 1,
    stopUpdates: () => calls.stopped++, cancelQueue() {}, importController: null,
    clearInterval() {}, setInterval: () => { calls.restarted++; return 2; }, pollWatchFolder() {},
    dialog: { showMessageBoxSync: value => calls.warnings.push(value) },
    persistQueue: async required => { assert.equal(required, true); calls.saves++; if (fail) throw new Error('disk full'); }
  });
  vm.runInContext(source.slice(source.indexOf('let queueQuitReady = false')), context);
  let prevented = 0;
  handler({ preventDefault: () => prevented++ });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.quits, 0); assert.equal(calls.stopped, 0);
  assert.equal(calls.warnings[0].message, 'Queue Save Failed');
  assert.match(calls.warnings[0].detail, /disk full/);
  assert.equal(calls.restarted, 1);
  assert.equal(vm.runInContext('queueQuitPending || queueQuitReady || watchStopping', context), false);
  fail = false;
  handler({ preventDefault: () => prevented++ });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.saves, 2); assert.equal(calls.quits, 1); assert.equal(calls.stopped, 1);
  handler({ preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
});

test('terminal status events schedule controls refresh; active progress avoids full render', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/renderer.js'), 'utf8');
  let handler, renders = 0, patches = 0;
  const items = new Map([['job', {}]]);
  const context = vm.createContext({
    api: { onUpdate: fn => { handler = fn; } }, items,
    patchProgress: () => patches++, scheduleRender: () => renders++, render() {}
  });
  vm.runInContext(source.slice(source.indexOf('api.onUpdate(update => {')), context);
  for (const status of ['Converting', 'Verifying']) handler({ type: 'status', id: 'job', status });
  assert.equal(patches, 2); assert.equal(renders, 0);
  for (const status of ['Complete', 'Error', 'Cancelled', 'Ready']) handler({ type: 'status', id: 'job', status });
  assert.equal(renders, 4);
});

test('queue lifecycle controls render immediately without an animation frame', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/renderer.js'), 'utf8');
  let handler, renders = 0;
  const context = vm.createContext({
    api: { onUpdate: fn => { handler = fn; } }, items: new Map(), running: false,
    queuePaused: false, importing: false, render: () => renders++,
    scheduleRender: () => assert.fail('Lifecycle controls must not wait for requestAnimationFrame')
  });
  vm.runInContext(source.slice(source.indexOf('api.onUpdate(update => {')), context);
  renders = 0;
  handler({ type: 'running', value: true });
  handler({ type: 'paused', value: true });
  handler({ type: 'running', value: false });
  handler({ type: 'importing', value: true });
  assert.equal(renders, 4);
  assert.equal(context.running, false);
  assert.equal(context.queuePaused, false);
  assert.equal(context.importing, true);
});

test('recovery busy events lock renderer controls immediately and unlock on completion', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/renderer.js'), 'utf8');
  let handler;
  const observed = [];
  const context = vm.createContext({
    api: { onUpdate: fn => { handler = fn; } }, recoveryBusy: false,
    render: () => observed.push(context.recoveryBusy)
  });
  vm.runInContext(source.slice(source.indexOf('api.onUpdate(update => {')), context);
  observed.length = 0;
  handler({ type: 'recovery-busy', value: true });
  handler({ type: 'recovery-busy', value: false });
  assert.deepEqual(observed, [true, false]);
});