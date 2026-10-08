const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WatchFolder } = require('../src/watch-folder');
const { preferencesDefaults, validatePreferences } = require('../src/app-state');

test('watch preferences default off and validate paths and boolean types', () => {
  assert.equal(preferencesDefaults().watchEnabled, false);
  assert.equal(preferencesDefaults().watchFolder, '');
  for (const extra of [{ watchEnabled: 'true' }, { watchFolder: '../relative' }, { watchEnabled: true }]) {
    assert.throws(() => validatePreferences({ ...preferencesDefaults(), ...extra }));
  }
  assert.equal(validatePreferences({ ...preferencesDefaults(), watchEnabled: true, watchFolder: os.tmpdir() }).watchEnabled, true);
});

test('watch scans wait for stable MKVs, skip outputs, deduplicate and reset', async () => {
  const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-watch-')));
  try {
    await fs.mkdir(path.join(folder, 'Season'));
    const file = path.join(folder, 'Season', 'episode.mkv');
    for (const name of ['output.audiority.mkv', 'output.fixed (1).mkv', '.episode.uuid.partial.mkv', 'not-video.mp4']) await fs.writeFile(path.join(folder, name), 'data');
    await fs.writeFile(file, 'first');
    const watch = new WatchFolder(), options = { outputSuffix: '.fixed' };
    assert.deepEqual(await watch.scan(folder, options), []);
    await fs.appendFile(file, 'more');
    assert.deepEqual(await watch.scan(folder, options), []);
    assert.deepEqual(await watch.scan(folder, options), [file]);
    watch.mark([file]);
    assert.deepEqual(await watch.scan(folder, options), []);
    assert.equal(watch.processedWatchFiles.size, 1);
    await assert.rejects(watch.scan(path.join(folder, 'missing')));
    assert.equal(watch.processedWatchFiles.size, 1);
    await fs.unlink(file);
    assert.deepEqual(await watch.scan(folder, options), []);
    assert.equal(watch.processedWatchFiles.size, 0);
    await fs.writeFile(file, 'returned');
    assert.deepEqual(await watch.scan(folder, options), []);
    assert.deepEqual(await watch.scan(folder, options), [file]);
    watch.reset();
    assert.deepEqual(await watch.scan(folder, options), []);
    assert.deepEqual(await watch.scan(folder, options), [file]);
    // Same length but changed modification time must not be considered stable.
    await fs.utimes(file, new Date(), new Date(Date.now() + 10000));
    assert.deepEqual(await watch.scan(folder, options), []);
    await assert.rejects(watch.scan(path.join(folder, 'missing')));
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});