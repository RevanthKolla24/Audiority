const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Engine, run } = require('../src/engine');
const { toolPaths } = require('../src/tools');
const { preferencesDefaults, validatePreferences } = require('../src/app-state');
const { defaultSettings, validateSettings, resolveProfile } = require('../src/profiles');

test('dialogue boost defaults off, validates booleans and resolves into profiles', () => {
  assert.equal(preferencesDefaults().dialogueBoost, false);
  assert.equal(defaultSettings().dialogueBoost, false);
  for (const value of ['true', 1, null]) {
    if (value === null) continue; // Missing/null legacy fields use the false default.
    assert.throws(() => validatePreferences({ ...preferencesDefaults(), dialogueBoost: value }));
    assert.throws(() => validateSettings({ ...defaultSettings(), dialogueBoost: value }));
  }
  assert.equal(resolveProfile({ ...defaultSettings(), advanced: true, dialogueBoost: true }).dialogueBoost, true);
  assert.equal(validatePreferences({ ...preferencesDefaults(), dialogueBoost: true }).dialogueBoost, true);
});

for (const layout of ['7.1', '7.1(wide)', '7.1(wide-side)']) {
test(`FLAC ${layout} compatibility output defaults correctly and boosts only center`, { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-dialogue-'));
  try {
    const tools = toolPaths(), engine = new Engine(tools); await engine.initialize();
    const input = path.join(directory, 'flac.mkv');
    // Low-amplitude tones provide headroom to measure gain without clipping.
    const expressions = Array.from({ length: 8 }, (_, i) => `0.02*sin(2*PI*${300 + i * 100}*t)`).join('|');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${expressions}:s=48000:c=${layout}`, '-t', '1', '-c:a', 'flac', '-disposition:a:0', '0', input]);
    const settings = { ...defaultSettings(), advanced: true, allowed: ['ac3'], pathConfirmed: true, pathCodecs: ['ac3'], passthrough: 'enabled', allowDownmix: true, downmixRules: [{ source: layout, target: '5.1(side)' }], keepOriginal: true };
    const outputs = [];
    for (const boost of [false, true]) {
      engine.setProfile(resolveProfile(settings));
      const item = await engine.inspect(input);
      assert.equal(item.plan.tracks[0].sourceLayout, layout);
      const result = await engine.convert(item, directory, { preferences: { ...preferencesDefaults(), dialogueBoost: boost } });
      const audio = (await engine.probe(result.output)).streams.filter(s => s.codec_type === 'audio');
      assert.deepEqual(audio.map(s => s.codec_name), ['flac', 'ac3']);
      assert.equal(audio[0].disposition.default, 0);
      assert.equal(audio[1].disposition.default, 1);
      assert.equal(audio[1].channels, 6);
      const raw = path.join(directory, `decoded-${boost}.f32`);
      await run(tools.ffmpeg, ['-v', 'error', '-i', result.output, '-map', '0:a:1', '-c:a', 'pcm_f32le', '-f', 'f32le', raw]);
      const bytes = await fs.readFile(raw), energy = Array(6).fill(0);
      for (let i = 0; i < bytes.length / 4; i++) energy[i % 6] += bytes.readFloatLE(i * 4) ** 2;
      outputs.push(energy.map(n => Math.sqrt(n)));
    }
    for (let channel = 0; channel < 6; channel++) {
      const ratio = outputs[1][channel] / outputs[0][channel];
      assert.ok(Math.abs(ratio - (channel === 2 ? 1.5 : 1)) < 0.08, `channel ${channel}: ratio ${ratio}`);
    }
    // Profile-only boost, normalization and replacement mode must coexist.
    engine.setProfile(resolveProfile({ ...settings, dialogueBoost: true, normalizeVolume: true, keepOriginal: false }));
    const result = await engine.convert(await engine.inspect(input), directory);
    const audio = (await engine.probe(result.output)).streams.filter(s => s.codec_type === 'audio');
    assert.equal(audio.length, 1);
    assert.equal(audio[0].codec_name, 'ac3');
    assert.equal(audio[0].disposition.default, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
}