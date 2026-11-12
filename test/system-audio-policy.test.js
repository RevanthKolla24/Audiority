const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { defaultSettings, validateSettings, resolveProfile } = require('../src/profiles');
const { planTrack } = require('../src/policy');
const { Engine, run } = require('../src/engine');
const { toolPaths } = require('../src/tools');
const { emptyLibrary, mutateLibrary, saveLibrary, loadLibrary } = require('../src/profile-library');
const settings = extra => ({ ...defaultSettings(), advanced: true, pathConfirmed: true, pathCodecs: ['dts', 'ac3', 'pcm'], passthrough: 'enabled', ...extra });
const audio = extra => ({ index: 0, codec_type: 'audio', codec_name: 'ac3', channels: 6, channel_layout: '5.1(side)', sample_rate: '48000', ...extra });
const caps = { ac3: { layouts: ['stereo', '3.1', '5.1(side)'], rates: [48000] }, dca: { layouts: ['stereo', '5.1(side)'], rates: [48000] } };

test('inactive fixed policy does not block explicit modes; switching back enforces its target', () => {
  for (const conversionMode of ['manual', 'dts-core']) for (const speakerLayout of ['unknown', '7.1']) {
    const value = validateSettings(settings({ conversionMode, layoutPolicy: 'fixed', speakerLayout }));
    const profile = resolveProfile(value);
    assert.equal(profile.systemExplanation, '');
    assert.equal(profile.allowDownmix, value.allowDownmix);
    assert.deepEqual(validateSettings(value), value);
    assert.throws(() => validateSettings({ ...value, conversionMode: 'playback' }), /Fixed-layout/);
    assert.doesNotThrow(() => validateSettings({ ...value, conversionMode: 'playback', speakerLayout: 'stereo' }));
  }
  assert.throws(() => validateSettings(settings({ conversionMode: 'manual', speakerLayout: 'bogus' })), /speaker layout/);
  assert.throws(() => validateSettings(settings({ conversionMode: 'dts-core', layoutPolicy: 'bogus' })), /layout policy/);
});

test('system-aware profiles survive library save, reload, switching and inactive mode round-trips', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-system-library-'));
  try {
    let library = emptyLibrary();
    for (const extra of [{ layoutPolicy: 'fixed', speakerLayout: 'stereo' }, { layoutPolicy: 'receiver', speakerLayout: '7.1' },
      { conversionMode: 'dts-core', layoutPolicy: 'fixed', speakerLayout: 'unknown' }]) {
      library = mutateLibrary(library, { type: 'save', name: `Room ${library.profiles.length}`, settings: settings(extra) });
    }
    await saveLibrary(directory, library);
    const loaded = await loadLibrary(directory);
    assert.equal(loaded.warning, ''); assert.deepEqual(loaded.library, library);
    for (const saved of loaded.library.profiles) {
      library = mutateLibrary(library, { type: 'switch', id: saved.id });
      await saveLibrary(directory, library);
      const restarted = await loadLibrary(directory);
      assert.deepEqual(restarted.library, library);
      const active = restarted.library.profiles.find(p => p.id === restarted.library.activeId);
      const profile = resolveProfile(active.settings);
      assert.equal(profile.layoutPolicy, saved.settings.layoutPolicy);
      assert.equal(profile.speakerLayout, saved.settings.speakerLayout);
      const track = planTrack(audio(), caps, profile);
      if (profile.conversionMode === 'playback' && profile.layoutPolicy === 'fixed') assert.equal(track.layout, 'stereo');
      else assert.equal(track.action, 'copy');
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('old profiles keep exact layout rules; system settings validate and round-trip', () => {
  const old = settings({ allowDownmix: true });
  const validated = validateSettings(old);
  assert.equal(validated.layoutPolicy, 'legacy'); assert.equal(validated.speakerLayout, 'unknown');
  assert.deepEqual(validateSettings(validated), validated);
  assert.deepEqual(resolveProfile(old).downmixRules, old.downmixRules);
  for (const extra of [{ speakerLayout: '5.2' }, { layoutPolicy: 'automatic' }, { layoutPolicy: 'fixed' }, { layoutPolicy: 'fixed', speakerLayout: '7.1' }]) {
    assert.throws(() => validateSettings(settings(extra)), /layout|speaker/);
  }
  const fixed = validateSettings(settings({ layoutPolicy: 'fixed', speakerLayout: '3.1' }));
  assert.deepEqual(validateSettings(fixed), fixed);
});

test('receiver-managed layouts copy supported originals and ignore stale downmix rules', () => {
  const profile = resolveProfile(settings({ layoutPolicy: 'receiver', speakerLayout: 'stereo', preserve: false, allowDownmix: true,
    downmixRules: [{ source: '5.1(side)', target: 'stereo' }] }));
  const track = planTrack(audio(), caps, profile);
  assert.equal(track.action, 'copy'); assert.equal(track.downmix, undefined);
  assert.match(track.reason, /Playback system manages/);
  const unsupported = resolveProfile(settings({ layoutPolicy: 'receiver', speakerLayout: '5.1(side)', connection: 'optical',
    pathCodecs: ['pcm'], allowed: ['pcm'] }));
  const unresolved = planTrack(audio(), caps, unsupported);
  assert.equal(unresolved.compatibility, 'unresolved'); assert.equal(unresolved.action, 'copy');
});

test('receiver-managed supported 7.1 is not reduced to match installed 5.1 speakers', () => {
  const profile = resolveProfile(settings({ advanced: false, receiverId: 'denon-avr-x1800h', layoutPolicy: 'receiver', speakerLayout: '5.1(side)',
    pathCodecs: ['eac3', 'ac3'], connection: 'hdmi', allowDownmix: true }));
  const track = planTrack(audio({ codec_name: 'eac3', channels: 8, channel_layout: '7.1' }), caps, profile);
  assert.equal(track.action, 'copy'); assert.equal(track.channels, 8);
});

test('fixed targets downmix even supported larger originals but never upmix smaller tracks', () => {
  for (const target of ['stereo', '3.1', '5.1(side)']) {
    const profile = resolveProfile(settings({ layoutPolicy: 'fixed', speakerLayout: target }));
    const track = planTrack(audio({ codec_name: 'flac', channels: 8, channel_layout: '7.1' }), caps, profile);
    assert.equal(track.action, 'encode'); assert.equal(track.layout, target); assert.equal(track.downmix, true);
    assert.match(track.reason, /Fixed-layout compatibility/);
    const smaller = planTrack(audio({ channels: 2, channel_layout: 'stereo' }), caps, profile);
    assert.equal(smaller.action, 'copy'); assert.equal(smaller.downmix, undefined);
    const equal = planTrack(audio({ channels: target === 'stereo' ? 2 : target === '3.1' ? 4 : 6, channel_layout: target }), caps, profile);
    assert.equal(equal.action, 'copy');
  }
});

test('fixed layouts retain unknown or mismatched positions rather than relabeling or guessing', () => {
  const profile = resolveProfile(settings({ layoutPolicy: 'fixed', speakerLayout: '5.1(side)' }));
  for (const source of [audio({ channels: 8, channel_layout: 'octagonal' }), audio({ channel_layout: '5.1' }),
    audio({ channels: 7, channel_layout: '6.1(front)' })]) {
    const track = planTrack(source, caps, profile);
    assert.equal(track.action, 'copy'); assert.equal(track.compatibility, 'unresolved');
  }
});

test('exclusions, explicit modes and keep rules preserve their precedence', () => {
  const base = settings({ layoutPolicy: 'fixed', speakerLayout: 'stereo', allowDownmix: false });
  const excluded = planTrack(audio(), caps, resolveProfile({ ...base, excludedFormats: ['ac3'] }));
  assert.equal(excluded.action, 'copy'); assert.match(excluded.reason, /Excluded/);
  assert.match(excluded.reason, /Fixed-layout exception/);
  const kept = planTrack(audio(), caps, resolveProfile({ ...base, rules: [{ source: 'ac3', scope: 'any', target: 'copy' }] }));
  assert.equal(kept.action, 'copy');
  assert.match(kept.reason, /not stereo/);
  const explicit = resolveProfile({ ...base, conversionMode: 'manual' });
  assert.equal(explicit.allowDownmix, false); assert.equal(explicit.systemExplanation, '');
  assert.ok(explicit.warnings.some(w => /inactive/.test(w)));
});

test('fixed policy keeps verified DTS cores instead of re-encoding when layout matches', () => {
  const profile = resolveProfile(settings({ layoutPolicy: 'fixed', speakerLayout: '5.1(side)' }));
  const track = planTrack(audio({ codec_name: 'dts', profile: 'DTS-HD MA', channels: 8, channel_layout: '7.1',
    audiorityCore: { channels: 6, layout: '5.1(side)', sampleRate: 48000 } }), caps, profile);
  assert.equal(track.action, 'extract'); assert.equal(track.codec, 'dts');
});

test('real system-aware compatibility output retains source and reports applied policy', { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-system-policy-'));
  try {
    const tools = toolPaths(), engine = new Engine(tools), input = path.join(directory, 'source.mkv');
    await run(tools.ffmpeg, ['-v','error','-f','lavfi','-i','anullsrc=r=48000:cl=5.1(side)','-t','0.5','-c:a','flac',input]);
    engine.setProfile(resolveProfile(settings({ layoutPolicy: 'fixed', speakerLayout: 'stereo', retentionMode: 'keep' })));
    const item = await engine.inspect(input), result = await engine.convert(item, directory);
    const streams = (await engine.probe(result.output)).streams;
    assert.deepEqual(streams.map(s => s.channels), [6, 2]);
    assert.equal(streams[0].codec_name, 'flac'); assert.equal(streams[1].disposition.default, 1);
    assert.match(result.conversionReport, /System policy: Fixed-layout compatibility output for stereo/);
    assert.match(result.conversionReport, /aresample=out_chlayout=stereo/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});