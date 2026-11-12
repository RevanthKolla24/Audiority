const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateQueue, saveQueue, loadQueue } = require('../src/app-state');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

test('application snapshot saves and reloads timings and reports without later edits leaking into the write', async () => {
  const directory = await fs.promises.mkdtemp(path.join(require('node:os').tmpdir(), 'audiority-snapshot-report-'));
  try {
    const timings = { conversion: 1, structure: 0.1, video: 0.2, audio: 0.3, subtitlesAndAttachments: 0, publication: 0.01, total: 2 };
    const item = { id: 'job', file: path.join(directory, 'source.mkv'), status: 'Complete', timings, conversionReport: 'Verified audio report' };
    const context = vm.createContext({ items: new Map([[item.id, item]]), structuredClone, saveQueue,
      app: { getPath: () => directory }, send() { assert.fail('Save should succeed'); } });
    vm.runInContext(`let queueWrites = Promise.resolve();\n${source.slice(source.indexOf('function persistQueue('), source.indexOf('// Send:'))}`, context);
    const write = vm.runInContext('persistQueue(true)', context);
    item.timings.audio = 99; item.conversionReport = 'Newer edit';
    await write;
    const loaded = await loadQueue(directory);
    assert.equal(loaded.warning, '');
    assert.equal(loaded.state.items[0].timings.audio, 0.3);
    assert.equal(loaded.state.items[0].conversionReport, 'Verified audio report');
    assert.equal(JSON.parse(await fs.promises.readFile(path.join(directory, 'queue.json'), 'utf8')).items[0].timings.audio, 0.3);
  } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
});

test('queue rejects malformed and oversized conversion reports', () => {
  for (const conversionReport of [null, {}, 42, 'x'.repeat(1024 * 1024 + 1)]) {
    assert.throws(() => validateQueue({ version: 1, items: [{ id: 'job', file: '/source.mkv', status: 'Complete', conversionReport }] }), /conversion report/);
  }
});

test('queue stage timings round-trip without accepting malformed or unbounded values', () => {
  const item = { id: 'timed', file: '/source.mkv', status: 'Complete' };
  const save = timings => validateQueue({ version: 1, items: [{ ...item, ...(timings === undefined ? {} : { timings }) }] }).items[0];
  const timings = { conversion: 1, structure: 0.1, video: 0.2, audio: 0.3, subtitlesAndAttachments: 0, publication: 0.01, total: 2 };
  assert.deepEqual(save(timings).timings, timings);
  assert.equal(Object.hasOwn(save(), 'timings'), false);
  for (const invalid of [null, [], {}, { ...timings, audio: -1 }, { ...timings, total: Infinity }, { ...timings, video: NaN }, { ...timings, audio: '1' }, { ...timings, extra: 0 }]) {
    assert.throws(() => save(invalid), /timings/);
  }
  assert.match(source, /item\.timings = result\.timings/);
});

test('renderer reload snapshots preserve pending saves and runtime warnings', () => {
  let published;
  const context = vm.createContext({ audioOutputPreview: require('../src/audio-output-map').audioOutputPreview,
    send: (_type, data) => { published = data.item; } });
  vm.runInContext(source.slice(source.indexOf('function publishItem('), source.indexOf('app.whenReady()')), context);
  context.item = { id: 'job', file: '/source.mkv', output: '/verified.mkv', status: 'Complete', persistencePending: true,
    conversionReport: 'Verified mapping', timings: { total: 2 },
    warnings: ['Recovery save failed'], importWarnings: ['Import warning'], plan: { tracks: [], needsConversion: false, warnings: [] } };
  vm.runInContext('publishItem(item)', context);
  assert.equal(published.persistencePending, true);
  assert.equal(published.outputPreview, null);
  assert.equal(published.conversionReport, 'Verified mapping');
  assert.equal(published.timings.total, 2);
  assert.deepEqual(Array.from(published.warnings), ['Import warning', 'Recovery save failed']);
  delete context.item.timings;
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

test('failed queue clear restores original jobs and locks concurrent mutations until persistence settles', async () => {
  let handler, rejectSave;
  const job = { id: 'job', output: '/verified.mkv', plan: { tracks: [] } };
  const items = new Map([['job', job]]), events = [];
  const context = vm.createContext({
    handle: (_channel, fn) => { handler = fn; }, items,
    running: false, importing: false, appStateBusy: false, profileBusy: false,
    send: (_type, data) => events.push(data.value),
    persistQueue: () => new Promise((_resolve, reject) => { rejectSave = reject; })
  });
  vm.runInContext(source.slice(source.indexOf("handle('clear',"), source.indexOf("  handle('cancel',")), context);
  const clear = handler();
  assert.equal(context.appStateBusy, true);
  await assert.rejects(handler(), /busy/);
  rejectSave(new Error('disk full'));
  await assert.rejects(clear, /disk full/);
  assert.equal(items.get('job'), job);
  assert.equal(context.appStateBusy, false);
  assert.deepEqual(events, [true, false]);
  context.persistQueue = async () => {};
  await handler();
  assert.equal(items.size, 0);
});

test('global settings changes preserve completed execution plans and replan only unfinished jobs', async () => {
  let handler;
  const completed = { output: '/verified.mkv', probe: {}, plan: { tracks: [{ action: 'copy' }] } };
  const original = completed.plan;
  const pending = { probe: {} }, replanned = [], published = [];
  const context = vm.createContext({
    handle: (_channel, fn) => { handler = fn; }, running: false, importing: false, profileBusy: false, appStateBusy: false,
    items: new Map([['done', completed], ['pending', pending]]), preferences: {}, outputDirectory: '/output',
    validatePreferences: value => value, saveState: async (_dir, _name, value) => value,
    app: { getPath: () => '/data' }, watcher: { reset() {} },
    engine: { setPreferences() {}, replan: item => replanned.push(item) },
    publishItem: item => published.push(item), persistQueue: async () => {}
  });
  vm.runInContext(source.slice(source.indexOf("handle('save-app-settings',"), source.indexOf("  handle('get-statistics',")), context);
  await handler({ storeFilenames: true });
  assert.deepEqual(replanned, [pending]);
  assert.deepEqual(published, [pending]);
  assert.equal(completed.plan, original);
});