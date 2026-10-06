const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { languageDrops, planFile } = require('../src/policy');
const { defaultSettings, resolveProfile, validateLanguages } = require('../src/profiles');
const { preferencesDefaults, validatePreferences } = require('../src/app-state');
const { Engine, run } = require('../src/engine');
const { toolPaths } = require('../src/tools');

test('language selection protects undefined, default and forced streams and validates preferences', () => {
  const probe = { streams: [
    { index: 0, codec_type: 'video', tags: { language: 'fra' } },
    { index: 1, codec_type: 'audio', codec_name: 'ac3', tags: { language: 'ENG' } },
    { index: 2, codec_type: 'audio', tags: { language: 'fra' }, disposition: { default: 1 } },
    { index: 3, codec_type: 'subtitle', tags: { language: 'fra' }, disposition: { forced: 1 } },
    { index: 4, codec_type: 'subtitle', tags: { language: 'fra' } },
    { index: 5, codec_type: 'subtitle', tags: { language: 'und' } },
    { index: 6, codec_type: 'audio' },
    { index: 7, codec_type: 'attachment', tags: { language: 'fra' } }
  ] };
  assert.deepEqual(languageDrops(probe, { allowedLanguages: [] }), []);
  assert.deepEqual(languageDrops(probe, { allowedLanguages: ['eng'], keepDefaultTrack: true }), [4]);
  assert.deepEqual(languageDrops(probe, { allowedLanguages: ['eng'], keepDefaultTrack: false }), [2, 3, 4]);
  assert.deepEqual(validateLanguages(['ENG', 'eng', 'jpn']), ['eng', 'jpn']);
  assert.throws(() => validateLanguages(['en']));
  assert.throws(() => validatePreferences({ ...preferencesDefaults(), keepDefaultTrack: 'yes' }));
  const filteringOnly = planFile({ streams: [probe.streams[1], probe.streams[4]] }, {}, resolveProfile({ ...defaultSettings(), advanced: true, allowedLanguages: ['eng'], keepDefaultTrack: true, excludedFormats: ['ac3'] }));
  assert.equal(filteringOnly.needsConversion, true);
  assert.deepEqual(filteringOnly.streamsToDrop, ['0:4']);
  assert.equal(defaultSettings().keepDefaultTrack, true);
});

test('real language filtering remaps compatibility audio and preserved ASS/font verification', { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-language-'));
  try {
    const tools = toolPaths(); const engine = new Engine(tools); await engine.initialize();
    const subtitle = path.join(dir, 'text.srt'); const font = path.join(dir, 'font.ttf');
    await fs.writeFile(subtitle, '1\n00:00:00,000 --> 00:00:01,000\nLanguage test\n');
    await fs.writeFile(font, 'attachment payload');
    const input = path.join(dir, 'show.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=16x16:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-i', subtitle,
      '-map', '0:v', '-map', '1:a', '-map', '1:a', '-map', '2:s', '-map', '2:s', '-t', '2', '-c:v', 'ffv1', '-c:a', 'flac', '-c:s', 'ass',
      '-metadata:s:a:0', 'language=fra', '-metadata:s:a:1', 'language=jpn', '-disposition:a:0', '0', '-disposition:a:1', 'default',
      '-metadata:s:s:0', 'language=fra', '-metadata:s:s:1', 'language=eng', '-disposition:s:0', '0', '-disposition:s:1', '0',
      '-attach', font, '-metadata:s:t:0', 'mimetype=application/x-truetype-font', input]);
    engine.setProfile(resolveProfile({ ...defaultSettings(), advanced: true, allowed: ['pcm'], pathConfirmed: true, pathCodecs: ['pcm'], keepOriginal: true }));
    engine.setPreferences({ ...preferencesDefaults(), allowedLanguages: ['jpn', 'eng'], keepDefaultTrack: false });
    const item = await engine.inspect(input);
    assert.equal(item.plan.droppedStreams.length, 2);
    assert.equal(item.plan.tracks.length, 1);
    const result = await engine.convert(item, dir, () => {}, undefined, { ...preferencesDefaults(), allowedLanguages: ['jpn', 'eng'], keepDefaultTrack: false });
    const output = await engine.probe(result.output);
    assert.deepEqual(output.streams.filter(s => s.codec_type === 'audio').map(s => s.codec_name), ['flac', 'pcm_s16le']);
    assert.equal(output.streams.filter(s => s.codec_type === 'subtitle').length, 1);
    assert.equal(output.streams.filter(s => s.codec_type === 'subtitle')[0].tags.language, 'eng');
    assert.equal(output.streams.filter(s => s.codec_type === 'attachment').length, 1);
    // A profile list overrides global preferences and filtering-only jobs still remux.
    engine.setProfile(resolveProfile({ ...defaultSettings(), advanced: true, allowedLanguages: ['fra'], keepDefaultTrack: false, excludedFormats: ['flac'] }));
    const remux = await engine.inspect(input);
    assert.equal(remux.plan.tracks[0].action, 'copy');
    assert.equal(remux.plan.needsConversion, true);
    const second = await engine.convert(remux, dir, () => {}, undefined, preferencesDefaults());
    assert.equal((await engine.probe(second.output)).streams.filter(s => s.codec_type === 'audio').length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});