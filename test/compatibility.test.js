const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Engine, run } = require('../src/engine');
const { toolPaths } = require('../src/tools');
const { defaultSettings, resolveProfile } = require('../src/profiles');
const { preferencesDefaults, validatePreferences } = require('../src/app-state');

test('compatibility settings default off and reject non-booleans', () => {
  assert.equal(defaultSettings().keepOriginal, false);
  assert.equal(preferencesDefaults().keepOriginal, false);
  assert.throws(() => validatePreferences({ ...preferencesDefaults(), keepOriginal: 'yes' }));
  assert.throws(() => resolveProfile({ ...defaultSettings(), advanced: true, keepOriginal: 'yes' }));
});

test('real compatibility tracks preserve originals, subtitles and attachments with one default', { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-compatibility-'));
  try {
    const tools = toolPaths(); const engine = new Engine(tools); await engine.initialize();
    const captions = path.join(directory, 'captions.srt'), font = path.join(directory, 'font.ttf');
    await fs.writeFile(captions, '1\n00:00:00,000 --> 00:00:01,000\nCompatibility test\n');
    await fs.writeFile(font, 'attachment payload');
    const input = path.join(directory, 'sample.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=7.1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-i', captions, '-map', '0:a', '-map', '1:a', '-map', '1:a', '-map', '2:s', '-t', '2', '-c:a:0', 'flac', '-c:a:1', 'flac', '-c:a:2', 'eac3', '-c:s', 'srt', '-metadata:s:a:0', 'title=Original surround', '-metadata:s:a:0', 'language=jpn', '-disposition:a:0', 'default', '-disposition:a:1', '0', '-disposition:a:2', '0', '-attach', font, '-metadata:s:t:0', 'mimetype=application/x-truetype-font', input]);
    const base = { ...defaultSettings(), advanced: true, pathConfirmed: true, pathCodecs: ['ac3', 'pcm'], allowed: ['ac3', 'pcm'], passthrough: 'enabled', allowDownmix: true, downmixRules: [{ source: '7.1', target: '3.1' }], excludedFormats: ['eac3'], normalizeVolume: true };
    const packets = async (file, index) => JSON.parse((await run(tools.ffprobe, ['-v', 'error', '-select_streams', `a:${index}`, '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json', file])).stdout);
    for (const global of [false, true]) {
      engine.setProfile(resolveProfile({ ...base, keepOriginal: !global }));
      engine.setPreferences({ keepOriginal: global });
      const item = await engine.inspect(input);
      assert.deepEqual(item.plan.tracks.map(t => !!t.keepOriginal), [true, true, false]);
      const result = await engine.convert(item, directory, { preferences: { ...preferencesDefaults(), keepOriginal: global } });
      const probe = await engine.probe(result.output), audio = probe.streams.filter(s => s.codec_type === 'audio');
      assert.deepEqual(audio.map(s => s.codec_name), ['flac', 'flac', 'eac3', 'ac3', 'pcm_s16le']);
      assert.equal(audio[3].channels, 4);
      assert.equal(audio[3].tags.language, 'jpn');
      assert.match(audio[3].tags.title, /Compatibility/);
      assert.equal(audio.filter(s => s.disposition.default).length, 1);
      assert.equal(audio[3].disposition.default, 1);
      for (let i = 0; i < 3; i++) assert.deepEqual(await packets(input, i), await packets(result.output, i));
    }
    // Ordinary DTS fixture exercises duplicate-core mapping without a DTS-HD sample.
    const dtsInput = path.join(directory, 'core.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1(side)', '-t', '1', '-c:a', 'dca', '-strict', 'experimental', dtsInput]);
    engine.setProfile(null); engine.setPreferences({ keepOriginal: false });
    const coreItem = await engine.inspect(dtsInput);
    coreItem.plan = { needsConversion: true, warnings: [], tracks: [{ ...coreItem.plan.tracks[0], action: 'extract', keepOriginal: true, sampleRate: 48000 }] };
    const coreResult = await engine.convert(coreItem, directory);
    const coreAudio = (await engine.probe(coreResult.output)).streams.filter(s => s.codec_type === 'audio');
    assert.equal(coreAudio.length, 2); assert.equal(coreAudio[1].codec_name, 'dts');
    assert.deepEqual(await packets(dtsInput, 0), await packets(coreResult.output, 0));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});