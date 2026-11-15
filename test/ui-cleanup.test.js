const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('filtered queues reconcile status transitions instead of leaving ineligible cards visible', () => {
  const source = read('src/ui/renderer.js');
  for (const queueFilter of ['all', 'runnable', 'failed', 'blocked']) {
    let callback, scheduled = 0, patched = 0;
    const item = { id: 'job', status: 'Error' };
    const context = vm.createContext({ queueFilter, items: new Map([['job', item]]),
      api: { onUpdate: fn => { callback = fn; } }, render() {},
      patchProgress() { patched++; }, scheduleRender() { scheduled++; } });
    vm.runInContext(source.slice(source.lastIndexOf('api.onUpdate(update =>')), context);
    callback({ type: 'status', id: 'job', status: 'Converting', progress: 0 });
    assert.equal(item.status, 'Converting');
    assert.equal(patched, 1);
    assert.equal(scheduled, queueFilter === 'all' ? 0 : 1);
  }
});

test('batch selection discloses hidden selections and prunes removed jobs', () => {
  const source = read('src/ui/batch.js');
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
  const context = vm.createContext({ $, items: new Map([['a', { status: 'Complete' }], ['b', { status: 'Error' }]]),
    running: false, importing: false, recoveryBusy: false, output: '/out',
    isRunnable: () => true, document: { querySelectorAll: () => [] } });
  vm.runInContext(source.slice(0, source.indexOf('async function removeJobs(')), context);
  vm.runInContext("selectedJobs.add('a'); selectedJobs.add('b'); selectedJobs.add('gone'); queueFilter = 'failed'; updateBatchControls()", context);
  assert.equal($('remove-selected').textContent, 'Remove selected (2; 1 hidden)');
  assert.equal($('remove-selected').disabled, false);
  context.running = true;
  vm.runInContext('updateBatchControls()', context);
  assert.equal($('remove-selected').disabled, true);
});

test('blocked, copy-only and completed plans are not runnable; retries remain eligible', () => {
  const source = read('src/ui/renderer.js');
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { setAttribute() {} });
    return nodes.get(id);
  };
  const blocked = { status: 'Ready', needsConversion: true, outputPreview: { blocked: true } };
  const items = new Map([['blocked', blocked]]);
  const context = vm.createContext({ $, items, output: '/out', running: false, importing: false,
    recoveryBusy: false, queuePaused: false, pauseRequestPending: false });
  vm.runInContext(source.slice(source.indexOf('function isRunnable('), source.indexOf('// Create item card:')), context);
  vm.runInContext(source.slice(source.indexOf('function updateControls()'), source.indexOf('// Safe:')), context);
  vm.runInContext('updateControls()', context);
  assert.equal($('start').disabled, true);
  assert.equal($('start').textContent, 'Resolve blocked plans');
  assert.equal(context.isRunnable(blocked), false);
  assert.equal(context.isRunnable({ status: 'Ready', needsConversion: false, tracks: [{ action: 'encode' }] }), false);
  assert.equal(context.isRunnable({ status: 'Complete', needsConversion: true, output: '/done' }), false);
  for (const status of ['Ready', 'Error', 'Cancelled']) {
    const item = { status, needsConversion: true, outputPreview: { blocked: false } };
    assert.equal(context.isRunnable(item), true);
    items.set('retry', item);
    vm.runInContext('updateControls()', context);
    assert.equal($('start').disabled, false);
  }
  items.delete('retry'); blocked.persistencePending = true;
  vm.runInContext('updateControls()', context);
  assert.equal($('start').disabled, false);
  assert.equal($('start').textContent, 'Retry queue save');
});

test('Settings navigation preserves a dirty draft instead of reloading saved preferences', async () => {
  const source = read('src/ui/pages.js');
  let requests = 0, fills = 0;
  const shown = [];
  const context = vm.createContext({ preferencesDirty: true, profileEditing: false,
    api: { getAppSettings: async () => { requests++; return {}; } },
    fillPreferences() { fills++; }, showPage: name => shown.push(name) });
  vm.runInContext(source.slice(source.indexOf('let navigationVersion'), source.indexOf("\nfor (const name of ['queue'")), context);
  await vm.runInContext("navigatePage('queue'); navigatePage('settings')", context);
  assert.equal(requests, 0); assert.equal(fills, 0);
  assert.deepEqual(shown, ['queue', 'settings']);
  context.preferencesDirty = false;
  await vm.runInContext("navigatePage('settings')", context);
  assert.equal(requests, 1); assert.equal(fills, 1);
});

test('late Settings responses cannot replace edits made while loading', async () => {
  const source = read('src/ui/pages.js');
  let resolve;
  const context = vm.createContext({ preferencesDirty: false, profileEditing: false,
    api: { getAppSettings: () => new Promise(done => { resolve = done; }) },
    fillPreferences() { throw new Error('Draft overwritten'); }, showPage() {} });
  vm.runInContext(source.slice(source.indexOf('let navigationVersion'), source.indexOf("\nfor (const name of ['queue'")), context);
  const pending = vm.runInContext("navigatePage('settings')", context);
  context.preferencesDirty = true; resolve({}); await pending;
});