const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { previewBatch, storageBudget, checkSpace } = require('../src/batch-preflight');
const { removeQueueItems } = require('../src/queue-actions');
const job = (id, extra = {}) => ({ id, name: 'Movie.mkv', status: 'Ready', size: 1000, duration: 1,
  plan: { needsConversion: true, tracks: [] }, ...extra });
const preferences = { preserveFolders: true, outputSuffix: '.audiority' };

test('retry-failed runner excludes ready/cancelled jobs and stops after an ENOSPC failure', async () => {
  const vm = require('node:vm');
  const { nextQueueItem } = require('../src/queue-priority');
  const source = await fs.readFile(path.join(__dirname, '../src/main.js'), 'utf8');
  for (const diskFull of [false, true]) {
    const jobs = [job('ready'), job('failed1', { status: 'Error' }), job('failed2', { status: 'Error' }), job('cancelled', { status: 'Cancelled' })];
    const items = new Map(jobs.map(item => [item.id, item]));
    const converted = [], warnings = [];
    let handler;
    const context = vm.createContext({
      handle: (_name, fn) => { handler = fn; }, items, nextQueueItem,
      running: false, profileBusy: false, appStateBusy: false, importing: false,
      settings: {}, preferences: {}, outputDirectory: '/output', isQueuePaused: false,
      resumeQueue() {}, AbortController, persistQueue: async () => {},
      performance: { now: () => 0 }, process: { platform: 'test', arch: 'test' }, app: { getVersion: () => 'test' },
      send: (type, data) => { if (type === 'status') Object.assign(items.get(data.id), data); if (type === 'queue-warning') warnings.push(data.message); },
      engine: { convert: async item => { converted.push(item.id); throw Object.assign(new Error(diskFull ? 'disk full' : 'test conversion failure'), { code: diskFull ? 'ENOSPC' : 'EIO' }); } }
    });
    vm.runInContext(source.slice(source.indexOf("handle('start',"), source.indexOf('  window.loadFile(page)')), context);
    await handler({ failedOnly: true });
    assert.deepEqual(converted, diskFull ? ['failed1'] : ['failed1', 'failed2']);
    assert.equal(items.get('ready').status, 'Ready');
    assert.equal(items.get('cancelled').status, 'Cancelled');
    assert.equal(warnings.length, diskFull ? 1 : 0);
    assert.equal(context.running, false);
  }
});

test('preview reserves numbered alternatives without creating folders or overwriting files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-preview-'));
  try {
    await fs.writeFile(path.join(root, 'Movie.audiority.mkv'), 'existing');
    const result = await previewBatch([job('a'), job('b'), job('c', { relativeDirectory: 'Season 01' }),
      job('done', { output: '/done' }), job('blocked', { plan: { blocked: true, needsConversion: true } })], root, preferences);
    const canonicalRoot = await fs.realpath(root);
    assert.deepEqual(result.rows.map(row => path.relative(canonicalRoot, row.destination)), ['Movie.audiority (1).mkv', 'Movie.audiority (2).mkv', path.join('Season 01', 'Movie.audiority.mkv')]);
    assert.deepEqual(result.rows.map(row => row.conflicts), [1, 2, 0]);
    assert.equal(await fs.readFile(path.join(root, 'Movie.audiority.mkv'), 'utf8'), 'existing');
    await assert.rejects(fs.access(path.join(root, 'Season 01')), { code: 'ENOENT' });
    assert.equal(result.requiredBytes, 4 * 1000 + 64 * 1024 * 1024);
    assert.equal(result.outputBytes, 3000);
    await assert.rejects(previewBatch([job('bad', { relativeDirectory: '../escape' })], root, preferences), /Unsafe/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('space checks include fallback copies and fail closed on unavailable/invalid storage', async () => {
  const item = job('a');
  const budget = storageBudget(item);
  assert.equal(budget.requiredBytes, 2000 + 64 * 1024 * 1024);
  for (const size of [Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => storageBudget(job('invalid', { size })), /safely estimate/);
  await assert.rejects(checkSpace('/out', item, { statfs: async () => ({ bavail: 0, bsize: 4096 }) }), { code: 'ENOSPC' });
  await assert.rejects(checkSpace('/out', item, { statfs: async () => ({ bavail: NaN, bsize: 4096 }) }), /determine/);
  await assert.rejects(checkSpace('/out', item, { statfs: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal((await checkSpace('/out', item, { statfs: async () => ({ bavail: BigInt(budget.requiredBytes), bsize: 1n }) })).freeBytes, budget.requiredBytes);
});

test('preview rejects output subfolder symlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-preview-link-'));
  try {
    await fs.mkdir(path.join(root, 'actual'));
    await fs.symlink(path.join(root, 'actual'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(previewBatch([job('a', { relativeDirectory: 'linked' })], root, preferences), /real directories/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('targeted queue removals roll back order after save failure and protect recovery jobs', async () => {
  const a = job('a'), b = job('b', { status: 'Complete', output: '/verified' }), c = job('c', { status: 'Error' });
  const items = new Map([a, b, c].map(item => [item.id, item]));
  await assert.rejects(removeQueueItems(items, { type: 'completed' }, async () => { throw new Error('save failed'); }), /save failed/);
  assert.deepEqual([...items.keys()], ['a', 'b', 'c']);
  b.persistencePending = true;
  await assert.rejects(removeQueueItems(items, { type: 'completed' }, async () => {}), /recovery/);
  delete b.persistencePending;
  assert.deepEqual(await removeQueueItems(items, { type: 'completed' }, async () => {}), ['b']);
  assert.equal(b.output, '/verified');
  await assert.rejects(removeQueueItems(items, { type: 'selected', ids: ['missing'] }, async () => {}), /Unknown/);
  assert.deepEqual(await removeQueueItems(items, { type: 'selected', ids: ['a'] }, async () => {}), ['a']);
  assert.deepEqual([...items.keys()], ['c']);
});