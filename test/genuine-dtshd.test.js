const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Engine, hashFile } = require('../src/engine');
const { defaultSettings, resolveProfile } = require('../src/profiles');
const { toolPaths } = require('../src/tools');

// Opt-in only: the ordinary suite must not convert a user's movie accidentally.
// Set the fixture path AND consent flag to authorize temporary output creation.
const requested = process.env.AUDIORITY_TEST_DTSHD === '1';
test('genuine DTS-HD 5.1 automatically plans, extracts and verifies a standard DTS 5.1 core',
  { skip: !requested, timeout: 120000 }, async t => {
    assert.ok(process.env.AUDIORITY_DTSHD_FIXTURE, 'Set AUDIORITY_DTSHD_FIXTURE to a genuine, short, legally usable DTS-HD 5.1 fixture.');
    const input = path.resolve(process.env.AUDIORITY_DTSHD_FIXTURE);
    const stat = await fs.stat(input);
    assert.ok(stat.isFile() && stat.size < 128 * 1024 * 1024, 'Use a short fixture under 128 MiB, not a full movie.');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-genuine-dtshd-'));
    try {
      const engine = new Engine(toolPaths());
      engine.setProfile(resolveProfile({ ...defaultSettings(), conversionMode: 'dts-core', retentionMode: 'replace', languageMode: 'all' }));
      const before = await hashFile(input);
      const item = await engine.inspect(input);
      const hd = item.probe.streams.filter(stream => stream.codec_type === 'audio' &&
        stream.codec_name === 'dts' && /DTS-HD (MA|HRA)/i.test(stream.profile || ''));
      assert.ok(hd.length, 'Fixture must actually probe as DTS-HD MA/HRA; ordinary DTS is not acceptance evidence.');
      assert.ok(item.duration > 0 && item.duration <= 60, 'Use a fixture no longer than 60 seconds.');
      assert.equal(item.plan.blocked, false);
      for (const source of hd) {
        assert.equal(source.channels, 6);
        assert.equal(source.audiorityCore?.channels, 6, 'The embedded core must actually be 5.1.');
        const track = item.plan.tracks.find(track => track.index === source.index);
        assert.equal(track.action, 'extract');
        assert.equal(track.channels, 6);
      }
      const result = await engine.convert(item, directory);
      const output = await engine.probe(result.output);
      for (const source of hd) {
        const ordinal = item.plan.tracks.findIndex(track => track.index === source.index);
        const actual = output.streams.filter(stream => stream.codec_type === 'audio')[ordinal];
        assert.equal(actual.codec_name, 'dts');
        assert.equal(actual.profile, 'DTS');
        assert.equal(actual.channels, 6);
        assert.equal(actual.channel_layout, source.audiorityCore.layout);
        assert.equal(Number(actual.sample_rate), source.audiorityCore.sampleRate);
      }
      assert.equal(await hashFile(input), before, 'Source content must remain unchanged.');
      t.diagnostic(JSON.stringify({ platform: process.platform, tools: await engine.toolVersions(),
        sourceSha256: before, inputProfiles: hd.map(stream => stream.profile), timings: result.timings }));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });