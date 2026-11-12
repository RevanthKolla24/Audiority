const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultSettings, validateSettings, resolveProfile } = require('../src/profiles');
const { Engine } = require('../src/engine');
const { planFile } = require('../src/policy');
const { nextQueueItem } = require('../src/queue-priority');
const { preferencesDefaults } = require('../src/app-state');

const core = { channels: 6, layout: '5.1(side)', sampleRate: 48000 };
const audio = (index, hd) => ({ index, codec_type: 'audio', codec_name: hd ? 'dts' : 'ac3', profile: hd ? 'DTS-HD MA' : '', channels: hd ? 6 : 2, channel_layout: hd ? '5.1(side)' : 'stereo', sample_rate: '48000', tags: { language: index < 2 ? 'jpn' : 'eng' }, ...(hd ? { audiorityCore: core } : {}) });
const movie = () => ({ streams: [audio(0, true), audio(1, false), audio(2, true), audio(3, false),
  ...[4, 5].map(index => ({ index, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'jpn' } })),
  ...Array.from({ length: 58 }, (_, i) => ({ index: i + 6, codec_type: 'attachment', codec_name: 'ttf' }))] });

test('legacy settings migrate without changing playback, retention or language semantics', () => {
  const legacy = { ...defaultSettings(), receiverId: 'bose-lifestyle-v20' };
  const migrated = validateSettings(legacy);
  assert.equal(migrated.conversionMode, 'playback');
  assert.equal(migrated.retentionMode, 'inherit');
  assert.equal(migrated.languageMode, 'inherit');
  assert.deepEqual(validateSettings(migrated), migrated);
  for (const field of ['conversionMode', 'retentionMode', 'languageMode']) assert.throws(() => validateSettings({ ...legacy, [field]: 'invalid' }));
});

test('movie-shaped explicit DTS core plan extracts both HD tracks without changing stereo, ASS or fonts', () => {
  const profile = resolveProfile({ ...defaultSettings(), conversionMode: 'dts-core' });
  assert.equal(profile.settings.passthrough, 'unknown');
  const plan = planFile(movie(), {}, profile);
  assert.deepEqual(plan.tracks.map(track => track.action), ['extract', 'copy', 'extract', 'copy']);
  assert.equal(plan.tracks[0].sourceProfile, 'DTS-HD MA');
  assert.equal(plan.tracks[0].codec, 'dts');
  assert.deepEqual(plan.droppedStreams, []);
  assert.equal(plan.unresolved, false);
  assert.equal(plan.blocked, false);
});

test('missing DTS core blocks entire explicit job even if other tracks could run', async () => {
  const probe = movie(); delete probe.streams[0].audiorityCore;
  const plan = planFile(probe, {}, resolveProfile({ ...defaultSettings(), conversionMode: 'dts-core' }));
  assert.equal(plan.blocked, true);
  assert.equal(plan.needsConversion, true);
  assert.equal(nextQueueItem(new Map([['job', { status: 'Ready', plan }]]), new Set()), undefined);
  await assert.rejects(new Engine({}).convert({ plan }, '/not-accessed'), /Conversion blocked/);
});

test('profile replace and keep-all override global retention and language filtering', () => {
  const engine = new Engine({});
  engine.setPreferences({ ...preferencesDefaults(), keepOriginal: true, allowedLanguages: ['eng'] });
  engine.setProfile(resolveProfile({ ...defaultSettings(), conversionMode: 'dts-core', retentionMode: 'replace', languageMode: 'all' }));
  const item = engine.replan({ probe: movie() });
  assert.equal(item.plan.tracks[0].keepOriginal, false);
  assert.deepEqual(item.plan.droppedStreams, []);
  engine.setProfile(resolveProfile({ ...defaultSettings(), conversionMode: 'dts-core', retentionMode: 'keep', languageMode: 'custom', allowedLanguages: ['eng'], keepDefaultTrack: false }));
  const filtered = engine.replan({ probe: movie() });
  assert.equal(filtered.plan.tracks[0].keepOriginal, true);
  assert.deepEqual(filtered.plan.droppedStreams, [0, 1, 4, 5]);
});

test('manual formats do not falsely claim target playback support', () => {
  const profile = resolveProfile({ ...defaultSettings(), conversionMode: 'manual', allowed: ['ac3'], rules: [{ source: 'flac', scope: 'any', target: 'ac3' }] });
  const probe = { streams: [{ ...audio(0, true), codec_name: 'flac', profile: '' }] };
  const plan = planFile(probe, { ac3: { layouts: ['5.1(side)'], rates: [48000] } }, profile);
  assert.equal(plan.tracks[0].action, 'encode');
  assert.equal(plan.tracks[0].codec, 'ac3');
  assert.ok(profile.warnings.some(warning => /Playback compatibility is not confirmed/.test(warning)));
});

test('explicit rules conflicting with playback limits are blocked, not silently copied', () => {
  const profile = resolveProfile({ ...defaultSettings(), receiverId: 'bose-lifestyle-v20', advanced: true, rules: [{ source: 'dtshd', scope: 'any', target: 'dts' }] });
  const plan = planFile(movie(), {}, profile);
  assert.equal(plan.blocked, true);
  assert.equal(plan.tracks[0].blocked, true);
});

test('keep-all ignores stale profile languages without losing planned audio or ASS streams', () => {
  const engine = new Engine({});
  engine.setPreferences({ ...preferencesDefaults(), allowedLanguages: ['eng'] });
  engine.setProfile(resolveProfile({ ...defaultSettings(), conversionMode: 'dts-core', languageMode: 'all', allowedLanguages: ['eng'], keepDefaultTrack: false }));
  const plan = engine.plan(movie());
  assert.deepEqual(plan.tracks.map(track => track.index), [0, 1, 2, 3]);
  assert.deepEqual(plan.droppedStreams, []);
  assert.deepEqual(plan.streamsToDrop, []);
  assert.equal(plan.warnings.some(warning => /Language filter removes/.test(warning)), false);
  const unchanged = engine.plan({ streams: [audio(1, false)] });
  assert.equal(unchanged.tracks.length, 1);
  assert.equal(unchanged.needsConversion, false);
});

test('effective copy, automatic and exclusion choices do not inherit overridden explicit blocking', () => {
  const stream = { ...audio(1, false), codec_name: 'flac' };
  for (const target of ['copy', 'auto']) {
    const profile = resolveProfile({ ...defaultSettings(), conversionMode: 'manual', allowed: ['dts'], rules: [
      { source: 'flac', scope: 'any', target: 'dts' },
      { source: 'flac', scope: 'stereo', target }
    ] });
    const plan = planFile({ streams: [stream] }, {}, profile);
    assert.equal(plan.unresolved, true);
    assert.equal(plan.blocked, false);
  }
  const excluded = resolveProfile({ ...defaultSettings(), conversionMode: 'manual', excludedFormats: ['flac'], rules: [{ source: 'flac', scope: 'any', target: 'dts' }] });
  const plan = planFile({ streams: [stream] }, {}, excluded);
  assert.equal(plan.tracks[0].action, 'copy');
  assert.equal(plan.blocked, false);
  const specific = resolveProfile({ ...defaultSettings(), conversionMode: 'manual', rules: [
    { source: 'flac', scope: 'any', target: 'copy' },
    { source: 'flac', scope: 'stereo', target: 'dts' }
  ] });
  assert.equal(planFile({ streams: [stream] }, {}, specific).blocked, true);
});