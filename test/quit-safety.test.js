const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
    running: false, importing: false, watchBusy: false, watchStopping: false, watchTimer: 1,
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