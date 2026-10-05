const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { defaultSettings, resolveProfile, validateSettings } = require('../src/profiles');
const { planTrack, planFile } = require('../src/policy');
const { Engine, run } = require('../src/engine');
const { toolPaths } = require('../src/tools');
const settings = extra => ({ ...defaultSettings(), receiverId: 'bose-lifestyle-v20', deviceId: 'shield-tv-pro', passthrough: 'enabled', pathConfirmed: true, pathCodecs: ['dts', 'ac3', 'pcm'], ...extra });
const caps = { dca: { layouts: ['stereo', '5.1(side)'], rates: [48000] }, ac3: { layouts: ['stereo', '3.1', '5.1(side)'], rates: [48000] } };
const audio = extra => ({ index: 0, codec_type: 'audio', codec_name: 'flac', channels: 8, channel_layout: '7.1', sample_rate: '48000', ...extra });

test('legacy defaults migrate safely and reject unsafe/duplicate rules', () => {
  const old = settings(); delete old.extractDtsCore; delete old.allowDownmix; delete old.downmixRules; delete old.excludedFormats;
  assert.equal(validateSettings(old).extractDtsCore, true);
  assert.equal(validateSettings(old).allowDownmix, false);
  for (const extra of [{ excludedFormats: ['bad'] }, { extractDtsCore: 'yes' }, { downmixRules: [{ source: '7.1', target: '7.1' }] }, { downmixRules: [{ source: '5.1', target: '5.1(side)' }] }, { downmixRules: [{ source: '7.1', target: '3.1' }, { source: '7.1', target: 'stereo' }] }]) assert.throws(() => validateSettings(settings(extra)));
});

test('core extraction avoids encoding; exclusions and explicit smaller layout take priority', () => {
  const source = audio({ codec_name: 'dts', profile: 'DTS-HD MA', audiorityCore: { channels: 6, layout: '5.1(side)', sampleRate: 48000 } });
  let profile = resolveProfile(settings());
  assert.equal(planTrack(source, caps, profile).action, 'extract');
  assert.equal(planFile({ streams: [source] }, caps, profile).needsConversion, true);
  profile = resolveProfile(settings({ excludedFormats: ['dtshd'], allowDownmix: true }));
  assert.equal(planTrack(source, caps, profile).action, 'copy');
  profile = resolveProfile(settings({ allowDownmix: true, downmixRules: [{ source: '7.1', target: '3.1' }] }));
  const smaller = planTrack(source, caps, profile);
  assert.equal(smaller.action, 'encode'); assert.equal(smaller.codec, 'ac3'); assert.equal(smaller.layout, '3.1');
  assert.equal(planTrack({ ...source, audiorityCore: null }, caps, resolveProfile(settings())).action, 'copy');
  assert.equal(planTrack(source, caps, resolveProfile(settings({ extractDtsCore: false }))).action, 'copy');
});

test('downmix only follows approved layouts, exclusions bypass all changes', () => {
  const profile = resolveProfile(settings({ allowDownmix: true, excludedFormats: ['eac3'] }));
  const track = planTrack(audio(), caps, profile);
  assert.equal(track.channels, 6); assert.equal(track.layout, '5.1(side)'); assert.equal(track.sourceChannels, 8);
  assert.equal(planTrack(audio({ codec_name: 'eac3' }), caps, profile).action, 'copy');
  assert.equal(planTrack(audio({ channel_layout: undefined }), caps, profile).action, 'copy');
  assert.equal(planTrack(audio({ channel_layout: '7.1(wide)' }), caps, profile).action, 'copy');
  const unsupported = resolveProfile(settings({ advanced: true, allowed: ['dts'], allowDownmix: true, downmixRules: [{ source: '7.1', target: '3.1' }] }));
  assert.equal(planTrack(audio(), caps, unsupported).compatibility, 'unresolved');
});

test('real FFmpeg downmixes 7.1 to 5.1, 3.1 and stereo; excluded E-AC-3 packets are unchanged', { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-downmix-'));
  try {
    const tools = toolPaths(); const engine = new Engine(tools); await engine.initialize();
    const input = path.join(directory, 'surround.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=7.1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1(side)', '-map', '0:a', '-map', '1:a', '-t', '0.3', '-c:a:0', 'flac', '-c:a:1', 'eac3', input]);
    for (const [layout, channels, codec] of [['5.1(side)', 6, 'dts'], ['3.1', 4, 'ac3'], ['stereo', 2, 'pcm_s16le']]) {
      engine.setProfile(resolveProfile(settings({ allowDownmix: true, downmixRules: [{ source: '7.1', target: layout }], excludedFormats: ['eac3'] })));
      const item = await engine.inspect(input);
      const result = await engine.convert(item, directory); const probe = await engine.probe(result.output);
      assert.equal(probe.streams[0].channels, channels); assert.equal(probe.streams[0].codec_name, codec);
      const args = ['-v', 'error', '-select_streams', 'a:1', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json'];
      assert.deepEqual(JSON.parse((await run(tools.ffprobe, [...args, input])).stdout), JSON.parse((await run(tools.ffprobe, [...args, result.output])).stdout));
    }
    const coreFile = path.join(directory, 'core.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1(side)', '-t', '0.3', '-c:a', 'dca', '-strict', 'experimental', coreFile]);
    const core = await engine.inspectDtsCore(coreFile, 0);
    assert.equal(core.channels, 6); assert.equal(core.layout, '5.1(side)');
    const item = await engine.inspect(coreFile);
    // Exercise real extraction/publication/verification without pretending this fixture has HD extensions.
    item.plan = { needsConversion: true, warnings: [], tracks: [{ ...item.plan.tracks[0], action: 'extract', codec: 'dts', ...core }] };
    const result = await engine.convert(item, directory);
    assert.equal((await engine.probe(result.output)).streams[0].channels, 6);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});