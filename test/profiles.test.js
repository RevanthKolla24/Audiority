const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { receivers, devices } = require('../src/catalog');
const { defaultSettings, resolveProfile, validateSettings, sourceFormat } = require('../src/profiles');
const { planTrack, planFile } = require('../src/policy');
const { loadSettings, saveSettings } = require('../src/settings');
const caps = { dca: { layouts: ['mono', 'stereo', '5.1(side)'], rates: [44100, 48000] }, ac3: { layouts: ['mono', 'stereo', '5.1', '5.1(side)'], rates: [32000, 44100, 48000] } };
const audio = (codec, extra = {}) => ({ index: 0, codec_type: 'audio', codec_name: codec, channels: 6, channel_layout: '5.1(side)', sample_rate: '48000', ...extra });
const settings = overrides => ({ ...defaultSettings(), receiverId: 'bose-lifestyle-v20', deviceId: 'shield-tv-pro', passthrough: 'enabled', pathConfirmed: true, pathCodecs: ['dts', 'ac3', 'pcm', 'eac3', 'dtshd', 'truehd'], ...overrides });

test('catalog has unique alphabetical models, verified references, and honest unknowns', () => {
  assert.ok(receivers.length > 100); assert.equal(new Set(receivers.map(r => r.id)).size, receivers.length);
  assert.deepEqual(receivers.map(r => r.name), [...receivers.map(r => r.name)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
  for (const receiver of receivers) {
    if (receiver.status === 'directory-only') assert.deepEqual(receiver.codecs, []);
    else assert.ok(receiver.sources.every(s => s.startsWith('https://')) && receiver.sources.length);
  }
  assert.equal(new Set(devices.map(d => d.id)).size, devices.length);
});
test('Bose V20 only enables reported DTS/AC-3/PCM stereo; E-AC-3 converts', () => {
  const profile = resolveProfile(settings()); assert.deepEqual(profile.allowed, ['dts', 'ac3', 'pcm']);
  assert.ok(profile.warnings.some(w => /reported/.test(w)));
  assert.equal(planTrack(audio('eac3'), caps, profile).codec, 'ac3');
  assert.equal(planTrack(audio('dts', { profile: 'DTS' }), caps, profile).action, 'copy');
  assert.equal(planTrack(audio('dts', { profile: 'DTS-HD MA' }), caps, profile).action, 'encode');
});
test('documented modern HDMI profile can preserve TrueHD and DTS-HD', () => {
  const profile = resolveProfile(settings({ receiverId: 'denon-avr-x3800h' }));
  for (const source of [audio('truehd', { channels: 8, channel_layout: '7.1' }), audio('dts', { profile: 'DTS-HD MA' })]) assert.equal(planTrack(source, caps, profile).compatibility, 'supported');
  assert.equal(sourceFormat(audio('dts', { profile: 'DTS-HD HRA' })), 'dtshd');
});
test('unknown playback device and disabled passthrough do not assume surround', () => {
  for (const overrides of [{ deviceId: 'custom', pathConfirmed: false }, { passthrough: 'disabled' }, { passthrough: 'unknown' }]) {
    const profile = resolveProfile(settings(overrides)); assert.deepEqual(profile.allowed, ['pcm']);
    const track = planTrack(audio('flac'), caps, profile); assert.equal(track.compatibility, 'unresolved'); assert.equal(track.action, 'copy');
  }
});
test('Apple TV upper bound removes DTS preference and falls back to AC-3', () => {
  const profile = resolveProfile(settings({ deviceId: 'apple-tv-4k', pathConfirmed: false }));
  assert.deepEqual(profile.allowed, ['ac3', 'pcm']); assert.equal(planTrack(audio('flac'), caps, profile).codec, 'ac3');
});
test('ARC/optical/coaxial filter HD formats, TV path requires confirmation', () => {
  for (const connection of ['arc', 'optical', 'coaxial']) {
    const profile = resolveProfile(settings({ receiverId: 'denon-avr-x3800h', connection, advanced: true }));
    assert.ok(!profile.supported.includes('truehd')); assert.ok(!profile.supported.includes('dtshd')); assert.equal(profile.pcmRate, 48000);
  }
  assert.deepEqual(resolveProfile(settings({ receiverId: 'denon-avr-x3800h', connection: 'earc', pathConfirmed: false })).allowed, ['pcm']);
});
test('PCM precision/sample rate are constrained and explicit', () => {
  const profile = resolveProfile(settings());
  const source = audio('flac', { channels: 2, channel_layout: 'stereo', bits_per_raw_sample: '24', sample_rate: '96000' });
  const track = planTrack(source, caps, profile); assert.equal(track.codec, 'pcm_s16le'); assert.equal(track.sampleRate, 48000); assert.ok(track.warning);
  assert.equal(planTrack(audio('pcm_s32le', { channels: 2, channel_layout: 'stereo', bits_per_sample: 32 }), caps, profile).action, 'encode');
});
test('nonstandard DTS rate does not bypass profile checks', () => {
  const profile = resolveProfile(settings());
  const track = planTrack(audio('dts', { profile: 'DTS', sample_rate: '96000' }), caps, profile);
  assert.equal(track.action, 'encode'); assert.equal(track.sampleRate, 48000);
});
test('advanced overrides work; unsupported explicit target is unresolved, not substituted', () => {
  const profile = resolveProfile(settings({ advanced: true, allowed: ['ac3', 'pcm'], rules: [{ source: 'flac', scope: 'surround', target: 'dts' }] }));
  assert.equal(planTrack(audio('flac'), caps, profile).compatibility, 'unresolved');
  const ac3Profile = resolveProfile(settings({ advanced: true, rules: [{ source: 'flac', scope: 'surround', target: 'ac3' }] }));
  assert.equal(planTrack(audio('flac'), caps, ac3Profile).codec, 'ac3');
  const keep = resolveProfile(settings({ advanced: true, rules: [{ source: 'eac3', scope: 'any', target: 'copy' }] }));
  assert.equal(planTrack(audio('eac3'), caps, keep).compatibility, 'unresolved');
});
test('channel-specific rule takes priority; mono never turns into PCM stereo', () => {
  const profile = resolveProfile(settings({ advanced: true, rules: [{ source: 'flac', scope: 'any', target: 'ac3' }, { source: 'flac', scope: 'stereo', target: 'pcm' }] }));
  assert.equal(planTrack(audio('flac', { channels: 2, channel_layout: 'stereo', bits_per_raw_sample: '16' }), caps, profile).codec, 'pcm_s16le');
  assert.equal(planTrack(audio('flac', { channels: 1, channel_layout: 'mono' }), caps, profile).codec, 'ac3');
});
test('unsupported 7.1 and AC-3 back-surround remain flagged, not called compatible', () => {
  const profile = resolveProfile(settings());
  const file = planFile({ streams: [audio('flac', { channels: 8, channel_layout: '7.1' }), audio('aac', { channel_layout: '5.1' })] }, caps, profile);
  assert.equal(file.needsConversion, false); assert.equal(file.unresolved, true);
});
test('validation rejects bogus models, unsafe rates/rules and strips injected capabilities', () => {
  for (const overrides of [{ receiverId: 'bogus' }, { allowed: [] }, { pcmRate: -1 }, { pcmBits: 64 }, { rules: [{ source: 'flac', scope: 'any', target: 'shell-command' }] }, { pathConfirmed: 'true' }]) assert.throws(() => validateSettings(settings(overrides)));
  assert.equal(validateSettings(settings({ supported: ['truehd'] })).supported, undefined);
  const directory = receivers.find(r => r.status === 'directory-only');
  assert.throws(() => validateSettings(settings({ receiverId: directory.id })), /Advanced/);
  assert.doesNotThrow(() => validateSettings(settings({ receiverId: directory.id, advanced: true })));
});
test('settings persist locally and malformed files return safe onboarding state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-settings-'));
  try {
    assert.equal((await loadSettings(directory)).settings, null);
    await saveSettings(directory, settings()); assert.deepEqual((await loadSettings(directory)).settings, settings());
    await fs.writeFile(path.join(directory, 'playback-profile.json'), '{broken');
    const loaded = await loadSettings(directory); assert.equal(loaded.settings, null); assert.match(loaded.warning, /setup again/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});