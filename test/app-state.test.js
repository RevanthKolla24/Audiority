const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { preferencesDefaults, validatePreferences, statsDefaults, validateStats, recordJob, loadState, saveState, inspectInOrder } = require('../src/app-state');
const { builtins, contrast, validateTheme } = require('../src/themes');
const { indexSidecars, matchSidecars, discoverMedia } = require('../src/imports');
const { Engine, run, hashFile, hashProbe } = require('../src/engine');
const { toolPaths } = require('../src/tools');
const item = { name: 'Private episode.mkv', size: 2e9, duration: 1200, plan: { tracks: [{ action: 'encode', sourceCodec: 'flac', codec: 'dca', downmix: true, sourceLayout: '7.1', layout: '5.1(side)' }, { action: 'extract', sourceCodec: 'dts', codec: 'dts' }, { action: 'copy', sourceCodec: 'eac3', codec: 'eac3' }] } };

test('preferences validate, whitelist values, remember folders and survive storage corruption safely', async () => {
  for (const extra of [{ threads: 17 }, { inspectionConcurrency: 9 }, { outputSuffix: '../evil' }, { rememberOutput: 'true' }, { outputDirectory: 'relative' }]) assert.throws(() => validatePreferences({ ...preferencesDefaults(), ...extra }));
  assert.equal(validatePreferences({ ...preferencesDefaults(), injected: true }).injected, undefined);
  assert.equal(validatePreferences({ ...preferencesDefaults(), outputDirectory: os.tmpdir(), rememberOutput: false }).outputDirectory, '');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-app-state-'));
  try {
    assert.equal((await loadState(directory, 'app-settings.json', preferencesDefaults, validatePreferences)).warning, '');
    const preferences = { ...preferencesDefaults(), compact: true, outputDirectory: directory };
    await saveState(directory, 'app-settings.json', preferences, validatePreferences);
    assert.deepEqual((await loadState(directory, 'app-settings.json', preferencesDefaults, validatePreferences)).state, preferences);
    await saveState(directory, 'app-settings.json', preferences, validatePreferences);
    assert.ok((await fs.readFile(path.join(directory, 'app-settings.json.bak'), 'utf8')).includes('compact'));
    await fs.writeFile(path.join(directory, 'app-settings.json'), 'broken');
    assert.ok((await loadState(directory, 'app-settings.json', preferencesDefaults, validatePreferences)).warning);
    const backup = await fs.readFile(path.join(directory, 'app-settings.json.bak'), 'utf8');
    await saveState(directory, 'app-settings.json', preferences, validatePreferences);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'app-settings.json'), 'utf8')), preferences);
    assert.equal(await fs.readFile(path.join(directory, 'app-settings.json.bak'), 'utf8'), backup);
    await fs.writeFile(path.join(directory, 'app-settings.json'), 'broken');
    await saveState(directory, 'app-settings.json', preferences, validatePreferences, { reset: true });
    assert.equal(await fs.readFile(path.join(directory, 'app-settings.json.bak'), 'utf8'), backup);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('saveState replaces invalid schemas but rejects new invalid data and filesystem failures', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-save-recovery-'));
  const target = path.join(directory, 'state.json');
  const validate = value => { if (value?.ok !== true) throw new Error('Unsupported saved data'); return value; };
  try {
    await fs.writeFile(target, '{"ok":false}');
    await fs.writeFile(`${target}.bak`, '{"ok":true,"backup":true}');
    await assert.rejects(saveState(directory, 'state.json', { ok: false }, validate), /Unsupported/);
    assert.equal(await fs.readFile(target, 'utf8'), '{"ok":false}');
    await saveState(directory, 'state.json', { ok: true }, validate);
    assert.equal(await fs.readFile(`${target}.bak`, 'utf8'), '{"ok":true,"backup":true}');
    // A directory in place of the backup reliably causes an OS failure, even as root.
    await fs.unlink(`${target}.bak`); await fs.mkdir(`${target}.bak`);
    await assert.rejects(saveState(directory, 'state.json', { ok: true, changed: true }, validate), /backup failed with OS error/);
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { ok: true });
    await fs.unlink(target); await fs.mkdir(target);
    await assert.rejects(saveState(directory, 'state.json', { ok: true }, validate), /previous file unreadable/);
    assert.ok(!(await fs.readdir(directory)).some(name => name.endsWith('.tmp')));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('statistics distinguish success/failure/cancellation, counters, retries and privacy', () => {
  let stats = recordJob(statsDefaults(), { status: 'failed', item, seconds: 3, profile: '__proto__' });
  stats = recordJob(stats, { status: 'cancelled', item, seconds: 2 });
  assert.equal(stats.totals.sourceBytes, 0); assert.equal(stats.totals.encoded, 0);
  const options = { status: 'completed', item, outputBytes: 1.9e9, seconds: 10, profile: '__proto__', id: 'one' };
  stats = recordJob(stats, options);
  assert.deepEqual(stats.totals, { completed: 1, failed: 1, cancelled: 1, sourceBytes: 2e9, outputBytes: 1.9e9, processingSeconds: 15, mediaSeconds: 1200, encoded: 1, extracted: 1, downmixed: 1, copied: 1 });
  assert.equal(stats.codecs['flac → dts'], 1); assert.equal(stats.downmixes['7.1 → 5.1(side)'], 1);
  assert.equal(stats.recent[0].filename, undefined); assert.equal(stats.profiles.__proto__.completed, 1);
  assert.deepEqual(recordJob(stats, options), stats);
  stats = recordJob(stats, { ...options, id: 'two', storeFilenames: true });
  assert.equal(stats.totals.completed, 2); assert.equal(stats.recent[0].filename, item.name);
  assert.throws(() => validateStats({ ...stats, totals: { ...stats.totals, sourceBytes: -1 } }));
});

test('statistics preserve lifetime totals but bound daily, profile and recent history', () => {
  let stats = statsDefaults();
  for (let i = 0; i < 370; i++) stats = recordJob(stats, { status: 'completed', item, profile: 'Living room', at: new Date(Date.UTC(2025, 0, i + 1)).toISOString() });
  assert.equal(stats.totals.completed, 370); assert.equal(stats.recent.length, 200); assert.equal(Object.keys(stats.days).length, 366);
});

test('12 preset themes have readable token pairs and validated colors', () => {
  assert.equal(builtins.length, 12); assert.equal(new Set(builtins.map(t => t.id)).size, 12);
  for (const theme of builtins) {
    validateTheme({ ...theme, version: 1 });
    for (const [a, b] of [['text', 'background'], ['text', 'surface'], ['text', 'sidebar'], ['muted', 'background'], ['muted', 'surface'], ['accentText', 'accent'], ['warning', 'warningBackground'], ['danger', 'dangerBackground']]) assert.ok(contrast(theme.colors[a], theme.colors[b]) >= 4.5, `${theme.name}: ${a}/${b}`);
  }
});

test('bounded parallel inspections retain order, drain errors and cancel discovery', async () => {
  let active = 0, maxActive = 0; const results = [];
  const candidates = async function* () { for (let i = 0; i < 12; i++) yield i; };
  await inspectInOrder(candidates(), async n => { active++; maxActive = Math.max(active, maxActive); await new Promise(resolve => setTimeout(resolve, n === 0 ? 15 : 1)); active--; if (n === 4) throw new Error('bad'); return n; }, async result => results.push(result), 3);
  assert.equal(maxActive, 3); assert.deepEqual(results.map(r => r.candidate), [...Array(12).keys()]); assert.match(results[4].error.message, /bad/);
  const controller = new AbortController(); const cancelled = [];
  await inspectInOrder(candidates(), async n => { if (n === 0) controller.abort(); return n; }, result => cancelled.push(result), 2, controller.signal);
  assert.ok(cancelled.length < 12);
});

test('cached sidecars match original behavior; custom suffix is excluded during discovery', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-index-'));
  try {
    for (const name of ['Ep.mkv', 'Ep.1.mkv', 'Ep.1.eng.ass', 'Ep.eng.srt', 'Other.mp4', 'Other.srt', 'Other.compatible.mkv', 'font.otf']) await fs.writeFile(path.join(directory, name), 'test');
    const entries = await fs.readdir(directory, { withFileTypes: true }); const index = indexSidecars(directory, entries);
    for (const name of ['Ep.mkv', 'Ep.1.mkv', 'Other.mp4']) assert.deepEqual(matchSidecars(path.join(directory, name), entries, index).sidecars, matchSidecars(path.join(directory, name), entries).sidecars);
    const found = []; for await (const media of discoverMedia([directory], { outputSuffix: '.compatible' })) found.push(media.file);
    assert.equal(found.length, 3);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('real conversion honors output suffix, flat output, thread option and streamed hashes', { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-prefs-'));
  try {
    const tools = toolPaths(); const engine = new Engine(tools); await engine.initialize();
    const input = path.join(directory, 'episode.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.2', '-c:a', 'flac', input]);
    const media = await engine.inspect(input); media.relativeDirectory = 'Show/Season 01';
    const result = await engine.convert(media, directory, { preferences: { ...preferencesDefaults(), preserveFolders: false, outputSuffix: '.compatible', threads: 1 } });
    assert.equal(result.output, path.join(await fs.realpath(directory), 'episode.compatible.mkv')); assert.equal(result.outputBytes, (await fs.stat(result.output)).size);
    assert.equal(await hashFile(input), require('node:crypto').createHash('sha256').update(await fs.readFile(input)).digest('hex'));
    const args = ['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json', input];
    assert.equal(await hashProbe(tools.ffprobe, args), require('node:crypto').createHash('sha256').update((await run(tools.ffprobe, args)).stdout.replace(/\r\n/g, '\n')).digest('hex'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});