const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { loadQueue, saveQueue, validateQueue, cleanupInterrupted, preferencesDefaults, validatePreferences } = require('../src/app-state');

test('queue round trips, filters completed only when requested, and refuses corrupt storage', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-queue-'));
  try {
    const ready = { id: 'one', file: path.join(directory, 'one.mkv'), status: 'Ready', relativeDirectory: 'Show/Season 01' };
    const complete = { id: 'two', file: path.join(directory, 'two.mkv'), status: 'Complete', output: path.join(directory, 'two.audiority.mkv') };
    await saveQueue(directory, new Map([[ready.id, ready], [complete.id, complete]]));
    assert.equal((await loadQueue(directory)).state.items.length, 2);
    assert.equal((await loadQueue(directory, { clearCompletedOnRestart: true })).state.items.length, 1);
    assert.equal(validatePreferences({ ...preferencesDefaults(), clearCompletedOnRestart: true }).clearCompletedOnRestart, true);
    assert.throws(() => validateQueue({ version: 1, items: [{ ...ready, relativeDirectory: '../escape' }] }));
    assert.throws(() => validateQueue({ version: 1, items: [ready, ready] }));
    await fs.writeFile(path.join(directory, 'queue.json'), 'broken');
    assert.ok((await loadQueue(directory)).warning);
    await assert.rejects(saveQueue(directory, new Map()));
    assert.equal(await fs.readFile(path.join(directory, 'queue.json'), 'utf8'), 'broken');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('recovery cleanup removes exact interrupted partial only, never other outputs or symlinks', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-cleanup-'));
  try {
    const file = path.join(directory, 'source.mkv');
    const temp = path.join(directory, '.source.audiority.12345678-1234-1234-1234-123456789abc.partial.mkv');
    const other = path.join(directory, '.other.12345678-1234-1234-1234-123456789abc.partial.mkv');
    await Promise.all([file, temp, other].map(p => fs.writeFile(p, 'keep')));
    await cleanupInterrupted([{ file, status: 'Verifying', temporaryOutput: temp }]);
    await assert.rejects(fs.access(temp));
    assert.equal(await fs.readFile(other, 'utf8'), 'keep');
    await fs.symlink(file, temp);
    await cleanupInterrupted([{ file, status: 'Converting', temporaryOutput: temp }]);
    assert.ok((await fs.lstat(temp)).isSymbolicLink());
    await cleanupInterrupted([{ file, status: 'Complete', temporaryOutput: other }]);
    assert.equal(await fs.readFile(other, 'utf8'), 'keep');
    assert.equal(await fs.readFile(file, 'utf8'), 'keep');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});