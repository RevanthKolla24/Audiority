const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { trashOriginal } = require('../src/trash-original');
const { preferencesDefaults, validatePreferences } = require('../src/app-state');

test('auto-trash defaults off and strictly validates persisted preferences', () => {
  assert.equal(preferencesDefaults().trashOriginals, false);
  const old = preferencesDefaults(); delete old.trashOriginals;
  assert.equal(validatePreferences(old).trashOriginals, false);
  assert.equal(validatePreferences({ ...old, trashOriginals: true }).trashOriginals, true);
  for (const value of ['yes', 1, null]) assert.throws(() => validatePreferences({ ...old, trashOriginals: value }));
});

test('auto-trash calls the OS only for safe successful outputs and reports failures without deleting', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-trash-'));
  try {
    const file = path.join(dir, 'original.mkv'), output = path.join(dir, 'converted.mkv');
    await fs.writeFile(file, 'original'); await fs.writeFile(output, 'verified output');
    const item = { file }, result = { output, sidecars: [] }; let calls = [];
    const options = { enabled: true, trashItem: async file => { calls.push(file); } };
    assert.deepEqual(await trashOriginal(item, result, { ...options, enabled: false }), []);
    assert.equal(calls.length, 0);
    assert.deepEqual(await trashOriginal(item, result, options), []);
    assert.deepEqual(calls, [file]); calls = [];
    const sidecars = [{ file: path.join(dir, 'original.eng.srt') }, { file: path.join(dir, 'original.jpn.ass') }];
    const copied = sidecars.map((_, i) => path.join(dir, `converted-${i}.srt`));
    for (const sidecar of sidecars) await fs.writeFile(sidecar.file, 'subtitle');
    const withSubtitles = { ...item, sidecars }, withCopies = { ...result, sidecars: copied };
    assert.deepEqual(await trashOriginal(withSubtitles, withCopies, options), []);
    assert.deepEqual(calls, [file, ...sidecars.map(s => s.file)]); calls = [];
    const partialWarnings = await trashOriginal(withSubtitles, withCopies, { ...options, trashItem: async target => {
      calls.push(target); if (target === sidecars[0].file) throw new Error('Subtitle locked');
    } });
    assert.deepEqual(calls, [file, ...sidecars.map(s => s.file)]); calls = [];
    assert.match(partialWarnings[0], /Could not move subtitle source.*Subtitle locked/);
    const aborted = new AbortController();
    await trashOriginal(withSubtitles, withCopies, { ...options, signal: aborted.signal, trashItem: async target => { calls.push(target); aborted.abort(); } });
    assert.deepEqual(calls, [file]); calls = [];
    await trashOriginal(withSubtitles, withCopies, { ...options, trashItem: async target => { calls.push(target); throw new Error('Media locked'); } });
    assert.deepEqual(calls, [file]); calls = [];
    assert.match((await trashOriginal(item, result, { ...options, signal: AbortSignal.abort() }))[0], /canceled/);
    assert.match((await trashOriginal({ ...item, sidecars: [{}] }, result, options))[0], /subtitles/);
    assert.match((await trashOriginal(item, { ...result, output: file }, options))[0], /same file/);
    const alias = path.join(dir, 'alias.mkv'); await fs.link(file, alias);
    assert.match((await trashOriginal(item, { ...result, output: alias }, options))[0], /same file/);
    assert.equal(calls.length, 0);
    const warnings = await trashOriginal(item, result, { ...options, trashItem: async () => { throw new Error('File locked'); } });
    assert.match(warnings[0], /Could not move original to Trash: File locked/);
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
    assert.equal(await fs.readFile(output, 'utf8'), 'verified output');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});