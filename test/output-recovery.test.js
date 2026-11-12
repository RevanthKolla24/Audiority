const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { sourceIdentity, validOutput, outputState } = require('../src/source-safety');
const { validateQueue, saveQueue, loadQueue, cleanupOrphanedTempFiles, cleanupInterrupted } = require('../src/app-state');

test('restart cleanup refreshes identities only for verified hard-linked outputs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-linked-recovery-'));
  try {
    const output = path.join(dir, 'converted.mkv');
    const temp = path.join(dir, '.movie.12345678-1234-1234-1234-123456789abc.partial.mkv');
    await fs.writeFile(temp, 'verified media'); await fs.link(temp, output);
    const item = { id: 'job', file: path.join(dir, 'original.mkv'), output, temporaryOutput: temp,
      status: 'Complete', outputSnapshot: await sourceIdentity(output), temporaryOutputSnapshot: await sourceIdentity(temp) };
    await saveQueue(dir, new Map([[item.id, item]]));
    const restored = (await loadQueue(dir)).state.items;
    assert.equal(await cleanupOrphanedTempFiles(dir, { items: restored }), 1);
    assert.equal(await validOutput(output, restored[0].outputSnapshot), true);
    await assert.rejects(fs.access(temp), { code: 'ENOENT' });
    await saveQueue(dir, new Map(restored.map(value => [value.id, value])));
    assert.equal(await validOutput(output, (await loadQueue(dir)).state.items[0].outputSnapshot), true);

    // Explicit interrupted cleanup must apply the same refresh, including when
    // the shallow startup sweep did not see a temporary path.
    await fs.link(output, temp);
    restored[0].outputSnapshot = await sourceIdentity(output);
    restored[0].status = 'Converting';
    restored[0].temporaryOutputSnapshot = await sourceIdentity(temp);
    assert.deepEqual(await cleanupInterrupted(restored), []);
    assert.equal(await validOutput(output, restored[0].outputSnapshot), true);

    // Never bless a changed output by refreshing its snapshot during cleanup.
    await fs.link(output, temp);
    restored[0].outputSnapshot = await sourceIdentity(output);
    await fs.writeFile(output, 'changed after publication');
    const previous = { ...restored[0].outputSnapshot };
    assert.equal(await cleanupOrphanedTempFiles(dir, { items: restored }), 0);
    assert.deepEqual(restored[0].outputSnapshot, previous);
    assert.equal(await validOutput(output, previous), false);
    assert.ok((await fs.stat(temp)).isFile());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('invalid output recovery clears stale unavailable and persistence flags', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-stale-recovery-'));
  try {
    const source = await fs.readFile(path.join(__dirname, '../src/main.js'), 'utf8');
    const block = source.slice(source.indexOf('  if (restore) for'), source.indexOf('  if (!recovered.warning)'));
    for (const available of [true, false]) {
      const saved = { id: 'job', file: path.join(dir, 'source.mkv'), output: path.join(dir, 'missing.mkv'),
        status: 'Needs attention', outputUnavailable: true, publicationPending: true, persistencePending: true, persistenceWarning: 'Old save failure' };
      const items = new Map();
      const context = vm.createContext({ restore: true, recovered: { state: { items: [saved] } }, items, path, validOutput, outputState,
        engine: { inspect: async () => { if (!available) throw new Error('Source missing'); return { plan: { needsConversion: true } }; } },
        publishItem: item => { if (item.outputUnavailable) item.status = 'Needs attention'; } });
      await vm.runInContext(`(async () => {${block}})()`, context);
      const item = items.get('job');
      assert.equal(item.output, '');
      assert.equal(item.outputUnavailable, false);
      assert.equal(item.publicationPending, false);
      assert.equal(item.persistencePending, false);
      assert.equal(item.persistenceWarning, '');
      assert.equal(item.status, available ? 'Ready' : 'Error');
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('output checks distinguish inaccessible storage from missing or invalid files', async () => {
  const error = code => Object.assign(new Error(code), { code });
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ENODEV', 'ESTALE']) {
    assert.equal(await outputState('/drive/output.mkv', undefined, { lstat: async () => { throw error(code); } }), 'unavailable');
  }
  const io = { lstat: async () => { throw error('ENOENT'); }, access: async () => {} };
  assert.equal(await outputState('/drive/output.mkv', undefined, io), 'invalid');
  io.access = async () => { throw error('ENOENT'); };
  assert.equal(await outputState('/drive/output.mkv', undefined, io), 'unavailable');
});

test('recovery retains unavailable outputs and reports interrupted subtitle processing without probing sources', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/main.js'), 'utf8');
  const block = source.slice(source.indexOf('  if (restore) for'), source.indexOf('  if (!recovered.warning)'));
  const items = new Map();
  const saved = { id: 'published', file: '/source.mkv', output: '/offline/output.mkv', publicationPending: true, status: 'Converting' };
  const context = vm.createContext({ restore: true, recovered: { state: { items: [saved] } }, items, path,
    outputState: async () => 'unavailable', engine: { inspect: () => assert.fail('Must not probe source') },
    publishItem: item => { item.status = item.outputUnavailable ? 'Needs attention' : 'Complete'; } });
  await vm.runInContext(`(async () => {${block}})()`, context);
  assert.equal(items.get(saved.id).output, saved.output);
  assert.equal(items.get(saved.id).outputUnavailable, true);
  assert.match(items.get(saved.id).warnings[0], /subtitle.*interrupted/);
});

test('both recovery branches reject missing, empty, directory, symlink and replaced outputs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-recovery-'));
  try {
    const source = await fs.readFile(path.join(__dirname, '../src/main.js'), 'utf8');
    const block = source.slice(source.indexOf('  if (restore) for'), source.indexOf('  if (!recovered.warning)'));
    const output = path.join(dir, 'output.mkv'); await fs.writeFile(output, 'verified output');
    const snapshot = await sourceIdentity(output);
    const empty = path.join(dir, 'empty.mkv'); await fs.writeFile(empty, '');
    const alias = path.join(dir, 'link.mkv'); await fs.symlink(output, alias);
    const replacement = path.join(dir, 'replacement.mkv'); await fs.writeFile(replacement, 'replacement');
    for (const available of [true, false]) for (const [candidate, expected] of [[output, true], [empty, false], [dir, false], [alias, false], [replacement, false], [path.join(dir, 'missing'), false]]) {
      const items = new Map();
      const saved = { id: 'job', file: path.join(dir, 'source.mkv'), status: 'Complete', output: candidate, outputSnapshot: snapshot };
      let probes = 0;
      const context = vm.createContext({ restore: true, recovered: { state: { items: [saved] } },
        engine: { inspect: async () => { probes++; if (!available) throw new Error('Source missing'); return { plan: { needsConversion: true } }; } },
        validOutput, outputState, items, path, publishItem: item => { if (item.output) item.status = 'Complete'; } });
      await vm.runInContext(`(async () => {${block}})()`, context);
      assert.equal(!!items.get('job').output, expected, `${available}: ${candidate}`);
      assert.equal(probes, expected ? 0 : 1);
    }
    assert.equal(await validOutput(output), true); // Legacy queue without snapshots.
    assert.equal(await validOutput(empty), false);
    const queue = { version: 1, items: [{ id: 'one', file: output, status: 'Complete', output, outputSnapshot: snapshot }] };
    assert.deepEqual(validateQueue(queue).items[0].outputSnapshot, snapshot);
    assert.throws(() => validateQueue({ ...queue, items: [{ ...queue.items[0], outputSnapshot: { size: 1 } }] }), /identity/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});