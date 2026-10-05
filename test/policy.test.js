const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planTrack, planFile, classify } = require('../src/policy');
const { parseCapabilities, verifyOutput } = require('../src/engine');
const caps = { dca: { layouts: ['mono', 'stereo', '5.1(side)'], rates: [44100, 48000] }, ac3: { layouts: ['mono', 'stereo', '5.1', '5.1(side)'], rates: [32000, 44100, 48000] } };
const audio = (codec, channels = 6, layout = '5.1(side)', extra = {}) => ({ index: 1, codec_type: 'audio', codec_name: codec, channels, channel_layout: layout, sample_rate: '48000', ...extra });
test('lossless surround → DTS and lossy surround → AC-3', () => {
  for (const codec of ['flac', 'alac', 'truehd', 'pcm_s24le']) assert.equal(planTrack(audio(codec), caps).codec, 'dca');
  for (const codec of ['aac', 'opus', 'vorbis', 'mp3']) assert.equal(planTrack(audio(codec), caps).codec, 'ac3');
});
test('PCM remains stereo only, precision is retained', () => {
  assert.equal(planTrack(audio('flac', 2, 'stereo', { bits_per_raw_sample: '24' }), caps).codec, 'pcm_s24le');
  assert.equal(planTrack(audio('flac', 2, 'stereo', { bits_per_raw_sample: '16' }), caps).codec, 'pcm_s16le');
  assert.equal(planTrack(audio('aac', 2, 'stereo', { sample_fmt: 'fltp' }), caps).codec, 'pcm_s32le');
  assert.equal(planTrack(audio('pcm_f64le', 2, 'stereo'), caps).action, 'copy');
});
test('compatible DTS/AC-3/E-AC-3 and PCM stereo are skipped', () => {
  for (const codec of ['dts', 'ac3', 'eac3']) assert.equal(planTrack(audio(codec), caps).action, 'copy');
  assert.equal(planTrack(audio('pcm_s16le', 2, 'stereo'), caps).action, 'copy');
});
test('unsupported layouts and unknown compression are never downmixed or guessed', () => {
  for (const source of [audio('flac', 8, '7.1'), audio('flac', 6, '5.1'), audio('aac', 6, null), audio('mystery'), audio('wavpack')]) {
    const track = planTrack(source, caps); assert.equal(track.action, 'copy'); assert.ok(track.warning);
  }
  assert.equal(classify(audio('wavpack')), 'unknown');
});
test('supported mono does not become PCM stereo', () => {
  assert.equal(planTrack(audio('flac', 1, 'mono'), caps).codec, 'dca');
  assert.equal(planTrack(audio('aac', 1, 'mono'), caps).codec, 'ac3');
});
test('AC-3 back-surround input is retained instead of relabeled', () => {
  const track = planTrack(audio('aac', 6, '5.1'), caps);
  assert.equal(track.action, 'copy'); assert.match(track.reason, /back-surround/);
});
test('resampling is explicit and missing encoders are safe', () => {
  const result = planTrack(audio('flac', 6, '5.1(side)', { sample_rate: '96000' }), caps);
  assert.equal(result.sampleRate, 48000); assert.match(result.reason, /Resampled/);
  assert.equal(planTrack(audio('flac'), {}).action, 'copy');
});
test('mixed tracks plan independently', () => {
  const result = planFile({ streams: [audio('dts'), audio('aac'), audio('flac', 8, '7.1')] }, caps);
  assert.equal(result.needsConversion, true); assert.deepEqual(result.tracks.map(t => t.action), ['copy', 'encode', 'copy']); assert.equal(result.warnings.length, 1);
});
test('encoder capabilities are parsed from installed binary help', () => {
  assert.deepEqual(parseCapabilities('Supported sample rates: 44100 48000\nSupported channel layouts: mono stereo 5.1(side)\n'), { rates: [44100, 48000], layouts: ['mono', 'stereo', '5.1(side)'] });
});
test('verification rejects lost channels and changed copied video', () => {
  const stream = audio('flac');
  const item = { duration: 2, probe: { streams: [{ codec_type: 'video', codec_name: 'h264' }, stream] }, plan: { tracks: [planTrack(stream, caps)] } };
  const output = { streams: [{ codec_type: 'video', codec_name: 'h264' }, { ...stream, codec_name: 'dts' }], format: { duration: '2' } };
  verifyOutput(item, output);
  assert.throws(() => verifyOutput(item, { ...output, streams: [output.streams[0], { ...output.streams[1], channels: 2 }] }), /channel count/);
  assert.throws(() => verifyOutput(item, { ...output, streams: [{ codec_type: 'video', codec_name: 'hevc' }, output.streams[1]] }), /copied stream/);
});