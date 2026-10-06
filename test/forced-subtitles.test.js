const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Engine, run, verifyOutput } = require('../src/engine');
const { toolPaths } = require('../src/tools');
const { preferencesDefaults } = require('../src/app-state');

test('title-based forced flags preserve ASS and dispositions after language filtering', { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-forced-'));
  try {
    const tools = toolPaths(), engine = new Engine(tools);
    const subtitles = path.join(directory, 'text.srt');
    await fs.writeFile(subtitles, '1\n00:00:00,000 --> 00:00:01,000\nSubtitle preservation test\n');
    const input = path.join(directory, 'source.mkv');
    const args = ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-i', subtitles,
      '-map', '0:a', '-c:a', 'flac', '-t', '1'];
    const titles = ['French (Forced)', 'English (FoRcEd)', 'Reinforced signs', 'Already Forced'];
    for (let i = 0; i < titles.length; i++) args.push('-map', '1:s', `-c:s:${i}`, 'ass', `-metadata:s:s:${i}`, `title=${titles[i]}`, `-metadata:s:s:${i}`, `language=${i ? 'eng' : 'fra'}`, `-disposition:s:${i}`, i === 1 ? 'default+hearing_impaired' : i === 3 ? 'forced' : '0');
    await run(tools.ffmpeg, [...args, input]);
    engine.setPreferences({ ...preferencesDefaults(), allowedLanguages: ['eng'], keepDefaultTrack: false, keepOriginal: true });
    const item = await engine.inspect(input);
    const source = item.probe.streams.filter(s => s.codec_type === 'subtitle');
    assert.equal(source[1].disposition.forced, 0);
    assert.ok(item.plan.droppedStreams.includes(source[0].index));
    const result = await engine.convert(item, directory, { preferences: { ...preferencesDefaults(), allowedLanguages: ['eng'], keepDefaultTrack: false, keepOriginal: true } });
    const output = await engine.probe(result.output);
    const retained = output.streams.filter(s => s.codec_type === 'subtitle');
    assert.deepEqual(retained.map(s => s.tags.title), titles.slice(1));
    assert.deepEqual(retained.map(s => s.disposition.forced), [1, 0, 1]);
    assert.equal(retained[0].disposition.default, 1);
    assert.equal(retained[0].disposition.hearing_impaired, 1);
    assert.ok(retained.every(s => s.codec_name === 'ass'));
    await engine.verifySubtitles(item, result.output);
    // Compare only content hashes: forced disposition is intentionally changed.
    const hashes = async (file, selector) => {
      const probe = JSON.parse((await run(tools.ffprobe, ['-v', 'error', '-select_streams', selector, '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'stream=extradata_hash:packet=data_hash', '-of', 'json', file])).stdout);
      return { headers: probe.streams.map(s => s.extradata_hash), packets: probe.packets.map(p => p.data_hash) };
    };
    for (let i = 0; i < 3; i++) assert.deepEqual(await hashes(input, `s:${i + 1}`), await hashes(result.output, `s:${i}`));
    const changed = structuredClone(output);
    changed.streams.find(s => s.codec_type === 'subtitle').disposition.forced = 0;
    assert.throws(() => verifyOutput(item, changed), /forced subtitle flag/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});