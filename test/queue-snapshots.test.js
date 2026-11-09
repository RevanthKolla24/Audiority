const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateQueue } = require('../src/app-state');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

test('renderer reload snapshots preserve pending saves and runtime warnings', () => {
  let published;
  const context = vm.createContext({ send: (_type, data) => { published = data.item; } });
  vm.runInContext(source.slice(source.indexOf('function publishItem('), source.indexOf('app.whenReady()')), context);
  context.item = { id: 'job', file: '/source.mkv', output: '/verified.mkv', status: 'Complete', persistencePending: true,
    warnings: ['Recovery save failed'], importWarnings: ['Import warning'], plan: { tracks: [], needsConversion: false, warnings: [] } };
  vm.runInContext('publishItem(item)', context);
  assert.equal(published.persistencePending, true);
  assert.deepEqual(Array.from(published.warnings), ['Import warning', 'Recovery save failed']);
  const saved = validateQueue({ version: 1, items: [context.item] }).items[0];
  assert.equal(saved.persistencePending, true);
  assert.deepEqual(saved.warnings, ['Recovery save failed']);
  assert.throws(() => validateQueue({ version: 1, items: [{ ...context.item, persistencePending: 'yes' }] }), /persistence/);
  assert.throws(() => validateQueue({ version: 1, items: [{ ...context.item, warnings: [42] }] }), /warnings/);
});

test('profile changes preserve completed outputs and replan only unfinished jobs', async () => {
  let handler, replans = 0;
  const completed = { id: 'done', file: '/trashed-source.mkv', output: '/verified.mkv', outputSnapshot: { size: 5 }, persistencePending: true };
  const pending = { id: 'pending', probe: {}, plan: { needsConversion: true } };
  const items = new Map([['done', completed], ['pending', pending]]);
  const context = vm.createContext({
    handle: (_channel, fn) => { handler = fn; }, running: false, importing: false, profileBusy: false, appStateBusy: false,
    library: { activeId: 'old' }, settings: {}, app: { getPath: () => '/data' }, items,
    mutateLibrary: () => ({ activeId: 'new', profiles: [{ id: 'new', settings: {} }] }), saveLibrary: async (_dir, value) => value,
    resolveProfile: value => value, engine: { setProfile() {}, replan: () => replans++ },
    publishItem: item => { assert.equal(item, pending); }, persistQueue: async () => {}, setupState: () => ({})
  });
  vm.runInContext(source.slice(source.indexOf("handle('profile-operation',"), source.indexOf("  handle('pick-output',")), context);
  await handler({ type: 'switch', id: 'new' });
  assert.equal(replans, 1);
  assert.equal(completed.output, '/verified.mkv');
  assert.equal(completed.outputSnapshot.size, 5);
  assert.equal(completed.persistencePending, true);
});

test('idle footer makes no unsupported claim that originals were retained', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../src/ui/renderer.js'), 'utf8');
  const statement = renderer.split('\n').find(line => line.includes("$('summary').textContent ="));
  const node = {};
  vm.runInNewContext(statement, { $: () => node, running: false, importing: false, output: '/chosen-output', items: new Map([['done', { status: 'Complete' }]]) });
  assert.equal(node.textContent, '1 completed · See job details for warnings');
});