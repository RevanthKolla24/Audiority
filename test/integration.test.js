const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Engine, run } = require('../src/engine');
const { toolPaths } = require('../src/tools');
const { defaultSettings, resolveProfile } = require('../src/profiles');
const { preferencesDefaults, validatePreferences } = require('../src/app-state');

test('normalization defaults off, validates booleans, and encodes with downmix without touching excluded audio', { timeout: 60000 }, async () => {
  assert.equal(preferencesDefaults().normalizeVolume, false);
  assert.equal(defaultSettings().normalizeVolume, false);
  assert.throws(() => validatePreferences({ ...preferencesDefaults(), normalizeVolume: 'yes' }));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-normalize-'));
  try {
    const tools = toolPaths(); const engine = new Engine(tools); await engine.initialize();
    const input = path.join(directory, 'normalize.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=7.1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-map', '0:a', '-map', '1:a', '-t', '3', '-c:a:0', 'flac', '-c:a:1', 'eac3', input]);
    const settings = { ...defaultSettings(), advanced: true, allowed: ['ac3', 'pcm'], pathConfirmed: true, pathCodecs: ['ac3', 'pcm'], passthrough: 'enabled', normalizeVolume: true, allowDownmix: true, downmixRules: [{ source: '7.1', target: '3.1' }], excludedFormats: ['eac3'] };
    const profile = resolveProfile(settings); assert.equal(profile.settings.normalizeVolume, true);
    assert.throws(() => resolveProfile({ ...settings, normalizeVolume: 'yes' }));
    const legacy = { ...settings }; delete legacy.normalizeVolume;
    assert.equal(resolveProfile(legacy).settings.normalizeVolume, false);
    const hashes = file => run(tools.ffprobe, ['-v', 'error', '-select_streams', 'a:1', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json', file]);
    for (const global of [false, true]) {
      engine.setProfile(resolveProfile({ ...settings, normalizeVolume: !global }));
      const item = await engine.inspect(input);
      const result = await engine.convert(item, directory, { preferences: { ...preferencesDefaults(), normalizeVolume: global } });
      const probe = await engine.probe(result.output);
      assert.equal(probe.streams[0].channels, 4);
      assert.equal(probe.streams[0].codec_name, 'ac3');
      assert.deepEqual(JSON.parse((await hashes(input)).stdout), JSON.parse((await hashes(result.output)).stdout));
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('real FFmpeg: mixed surround/stereo, metadata, subtitles, copy safety and cancellation', { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-test-'));
  try {
    const tools = toolPaths(); const engine = new Engine(tools); await engine.initialize();
    const subtitle = path.join(directory, 'captions.srt');
    await fs.writeFile(subtitle, '1\n00:00:00,000 --> 00:00:01,000\nAudiority test\n');
    const input = path.join(directory, 'Mixed ünicode sample.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1(side)', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-i', subtitle, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1', '-map', '0:v', '-map', '1:a', '-map', '4:a', '-map', '2:a', '-map', '1:a', '-map', '3:s', '-c:v', 'mpeg4', '-c:a:0', 'flac', '-c:a:1', 'aac', '-c:a:2', 'flac', '-c:a:3', 'ac3', '-c:s', 'srt', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=Lossless surround', '-disposition:a:0', 'default', '-t', '2', input]);
    const original = await fs.readFile(input);
    const item = await engine.inspect(input);
    assert.deepEqual(item.plan.tracks.map(t => t.codec), ['dca', 'aac', 'pcm_s16le', 'ac3']);
    const progress = [];
    const result = await engine.convert(item, directory, { onProgress: p => progress.push(p) });
    const probe = await engine.probe(result.output);
    assert.deepEqual(probe.streams.filter(s => s.codec_type === 'audio').map(s => s.codec_name), ['dts', 'aac', 'pcm_s16le', 'ac3']);
    const audio = probe.streams.filter(s => s.codec_type === 'audio');
    assert.deepEqual(audio.map(s => s.channels), [6, 6, 2, 6]);
    assert.equal(audio[0].tags.language, 'eng'); assert.equal(audio[0].tags.title, 'Lossless surround'); assert.equal(audio[0].disposition.default, 1);
    assert.ok(probe.streams.some(s => s.codec_type === 'subtitle'));
    assert.ok(progress.includes(1));
    assert.deepEqual(await fs.readFile(input), original);
    const second = await engine.convert(item, directory);
    assert.notEqual(second.output, result.output);
    const converted = await engine.inspect(result.output); assert.equal(converted.plan.needsConversion, false);
    assert.equal((await engine.convert(converted, directory)).skipped, true);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(engine.convert(item, directory, { signal: controller.signal }), /Cancelled/);
    assert.equal((await fs.readdir(directory)).some(name => name.includes('.partial.')), false);
    // Packet hashes confirm copied video and already-compatible audio are byte-identical.
    for (const select of ['v:0', 'a:3', 's:0']) {
      const args = ['-v', 'error', '-select_streams', select, '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json'];
      const source = await run(tools.ffprobe, [...args, input]);
      const target = await run(tools.ffprobe, [...args, result.output]);
      assert.deepEqual(JSON.parse(target.stdout), JSON.parse(source.stdout));
    }
    const unsupported = path.join(directory, '7.1.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=7.1', '-t', '1', '-c:a', 'flac', unsupported]);
    const retained = await engine.inspect(unsupported); assert.equal(retained.plan.needsConversion, false); assert.ok(retained.plan.warnings.length);
    const corrupt = path.join(directory, 'broken.mkv'); await fs.writeFile(corrupt, 'not a media file');
    await assert.rejects(engine.inspect(corrupt));
    const mono = path.join(directory, 'mono.mp3');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', mono]);
    const monoItem = await engine.inspect(mono); assert.equal(monoItem.plan.tracks[0].codec, 'ac3');
    const monoResult = await engine.convert(monoItem, directory);
    assert.equal((await engine.probe(monoResult.output)).streams[0].channels, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('real FFmpeg: receiver profile converts E-AC-3, constrains PCM, and replans queue', { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-profile-conversion-'));
  try {
    const tools = toolPaths(); const engine = new Engine(tools); await engine.initialize();
    const input = path.join(directory, 'profile.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1(side)', '-f', 'lavfi', '-i', 'anullsrc=r=96000:cl=stereo', '-map', '0:a', '-map', '1:a', '-t', '1', '-c:a:0', 'eac3', '-c:a:1', 'pcm_s24le', input]);
    const base = { ...defaultSettings(), receiverId: 'denon-avr-x3800h', deviceId: 'shield-tv-pro', passthrough: 'enabled', pathConfirmed: true, pathCodecs: ['dts', 'ac3', 'eac3', 'pcm', 'truehd', 'dtshd'], pcmRate: 192000 };
    engine.setProfile(resolveProfile(base));
    const item = await engine.inspect(input); assert.equal(item.plan.needsConversion, false);
    engine.setProfile(resolveProfile({ ...base, receiverId: 'bose-lifestyle-v20' })); engine.replan(item);
    assert.deepEqual(item.plan.tracks.map(t => t.codec), ['ac3', 'pcm_s16le']);
    const result = await engine.convert(item, directory);
    const output = await engine.probe(result.output);
    assert.deepEqual(output.streams.map(s => s.codec_name), ['ac3', 'pcm_s16le']);
    assert.deepEqual(output.streams.map(s => s.channels), [6, 2]);
    assert.equal(output.streams[1].sample_rate, '48000');
    engine.setProfile(resolveProfile({ ...base, advanced: true, receiverId: '', allowed: ['ac3'], lossless: 'ac3', rules: [{ source: 'eac3', scope: 'surround', target: 'dts' }] }));
    engine.replan(item); assert.equal(item.plan.tracks[0].compatibility, 'unresolved');
    assert.equal(item.plan.tracks[0].action, 'copy');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});