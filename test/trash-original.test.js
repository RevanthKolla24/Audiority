const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { trashOriginal } = require('../src/trash-original');
const { preferencesDefaults, validatePreferences } = require('../src/app-state');
const { sourceIdentity } = require('../src/source-safety');
const { hashFile } = require('../src/engine');

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
    const item = { file }, result = { output, sidecars: [], sourceSnapshot: await sourceIdentity(file), outputSnapshot: await sourceIdentity(output) }; let calls = [];
    const options = { enabled: true, trashItem: async file => { calls.push(file); } };
    assert.deepEqual(await trashOriginal(item, result, { ...options, enabled: false }), []);
    assert.equal(calls.length, 0);
    assert.deepEqual(await trashOriginal(item, result, options), []);
    assert.deepEqual(calls, [file]); calls = [];
    const sidecars = [{ file: path.join(dir, 'original.eng.srt') }, { file: path.join(dir, 'original.jpn.ass') }];
    const copied = sidecars.map((_, i) => path.join(dir, `converted-${i}.srt`));
    for (const sidecar of sidecars) await fs.writeFile(sidecar.file, 'subtitle');
    for (const target of copied) await fs.writeFile(target, 'subtitle');
    const verifiedSidecars = await Promise.all(sidecars.map(async (s, i) => ({ file: s.file, output: copied[i], identity: await sourceIdentity(s.file), hash: await hashFile(s.file) })));
    const withSubtitles = { ...item, sidecars }, withCopies = { ...result, sidecars: copied, verifiedSidecars };
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
    // Creating the hard-link alias changed ctime; refresh this unrelated failure fixture.
    result.sourceSnapshot = await sourceIdentity(file);
    const warnings = await trashOriginal(item, result, { ...options, trashItem: async () => { throw new Error('File locked'); } });
    assert.match(warnings[0], /Could not move original to Trash: File locked/);
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
    assert.equal(await fs.readFile(output, 'utf8'), 'verified output');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('auto-trash retains changed media, changed subtitles and unverified subtitle copies', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-trash-changed-'));
  try {
    const file = path.join(dir, 'media.mkv'), output = path.join(dir, 'converted.mkv');
    const subtitle = path.join(dir, 'media.srt'), copy = path.join(dir, 'converted.srt');
    for (const failure of ['media', 'subtitle', 'copy', 'missing', 'during-trash', 'output', 'output-missing']) {
      await fs.writeFile(file, 'media'); await fs.writeFile(output, 'output');
      await fs.writeFile(subtitle, 'captions'); await fs.writeFile(copy, 'captions');
      const result = { output, outputSnapshot: await sourceIdentity(output), sidecars: [copy], sourceSnapshot: await sourceIdentity(file),
        verifiedSidecars: [{ file: subtitle, output: copy, identity: await sourceIdentity(subtitle), hash: await hashFile(subtitle) }] };
      if (failure === 'media') await fs.writeFile(file, 'changed media');
      if (failure === 'subtitle') await fs.writeFile(subtitle, 'new captions');
      if (failure === 'copy') await fs.writeFile(copy, 'damaged captions');
      if (failure === 'missing') result.verifiedSidecars = [];
      if (failure === 'output') await fs.writeFile(output, 'replaced output');
      if (failure === 'output-missing') delete result.outputSnapshot;
      const calls = [];
      const warnings = await trashOriginal({ file, sidecars: [{ file: subtitle }] }, result, {
        enabled: true, trashItem: async target => {
          calls.push(target);
          if (failure === 'during-trash') await fs.writeFile(subtitle, 'edited during media trash');
        }
      });
      assert.ok(warnings.length > 0, failure);
      assert.deepEqual(calls, failure === 'during-trash' ? [file] : [], failure);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});