const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { audioOutputMap, audioOutputPreview } = require('../src/audio-output-map');
const { conversionReport } = require('../src/conversion-report');
const { Engine, run, verifyOutput } = require('../src/engine');
const { toolPaths } = require('../src/tools');

function fixture() {
  const streams = [
    { index: 3, codec_type: 'audio', codec_name: 'flac', channels: 6, channel_layout: '5.1(side)', tags: { language: 'jpn', title: 'Surround' }, disposition: { default: 1 } },
    { index: 7, codec_type: 'audio', codec_name: 'ac3', channels: 2, channel_layout: 'stereo', tags: { language: 'eng', title: 'Commentary' }, disposition: { default: 0 } }
  ];
  return { probe: { streams }, plan: { tracks: [
    { index: 3, action: 'encode', codec: 'dca', channels: 6, layout: '5.1(side)', title: 'Surround', keepOriginal: true },
    { index: 7, action: 'copy', codec: 'ac3', channels: 2, layout: 'stereo' }
  ] } };
}

test('audio map retains absolute source indices and moves default only to its compatibility counterpart', () => {
  const item = fixture(), mapping = audioOutputMap(item);
  assert.deepEqual(mapping.map(entry => [entry.source.index, entry.ordinal, entry.default]), [[3, 0, 0], [7, 1, 0], [3, 2, 1]]);
  const output = { streams: [
    { ...item.probe.streams[0], disposition: { default: 0 } }, item.probe.streams[1],
    { ...item.probe.streams[0], codec_name: 'dts', tags: { language: 'jpn', title: 'Surround · Compatibility (DTS)' } }
  ] };
  verifyOutput(item, output);
  for (const change of [
    actual => { actual.streams[2].disposition.default = 0; },
    actual => { actual.streams[2].tags.language = 'eng'; },
    actual => { actual.streams[2].tags.title = 'Wrong title'; },
    actual => { [actual.streams[0], actual.streams[1]] = [actual.streams[1], actual.streams[0]]; }
  ]) {
    const changed = structuredClone(output); change(changed);
    assert.throws(() => verifyOutput(item, changed), /Verification failed/);
  }
});

test('copy-only audio without a surviving default does not invent one', () => {
  const item = fixture(); item.probe.streams.shift(); item.plan.tracks.shift();
  assert.equal(audioOutputMap(item)[0].default, 0);
});

test('output preview separates retained source layout from compatibility target and exposes default flags', () => {
  const item = fixture();
  Object.assign(item.plan.tracks[0], { codec: 'ac3', channels: 2, layout: 'stereo' });
  const preview = audioOutputPreview(item);
  assert.equal(preview.blocked, false);
  assert.deepEqual(preview.outputs.map(entry => [entry.ordinal, entry.sourceIndex, entry.role, entry.codec, entry.layout, entry.channels, entry.default]), [
    [0, 3, 'Retained original', 'flac', '5.1(side)', 6, 0],
    [1, 7, 'Original (copied)', 'ac3', 'stereo', 2, 0],
    [2, 3, 'Compatibility track', 'ac3', 'stereo', 2, 1]
  ]);
  assert.equal(preview.outputs[2].title, 'Surround · Compatibility (AC3)');
  assert.equal(preview.outputs[2].language, 'jpn');
});

test('output preview preserves copy defaults, replacement semantics and unknown source layouts', () => {
  const item = fixture();
  item.plan.tracks[0].keepOriginal = false;
  assert.equal(audioOutputPreview(item).outputs[0].role, 'Converted track');
  assert.deepEqual(audioOutputPreview(item).outputs.map(entry => entry.default), [1, 0]);
  item.plan.tracks[0].action = 'copy';
  delete item.probe.streams[0].channel_layout;
  assert.equal(audioOutputPreview(item).outputs[0].layout, 'unknown layout');
  for (const source of item.probe.streams) source.disposition.default = 0;
  assert.deepEqual(audioOutputPreview(item).outputs.map(entry => entry.default), [0, 0]);
  item.plan.blocked = true;
  assert.deepEqual(audioOutputPreview(item), { blocked: true, outputs: [] });
});

test('default flags remain with the selected source unless that source has a compatibility counterpart', () => {
  const item = fixture();
  item.probe.streams[0].disposition.default = 0;
  item.probe.streams[1].disposition.default = 1;
  assert.deepEqual(audioOutputPreview(item).outputs.map(entry => entry.default), [0, 1, 0]);
  item.probe.streams[1].disposition.default = 0;
  assert.deepEqual(audioOutputPreview(item).outputs.map(entry => entry.default), [0, 0, 1]);
});

test('conversion report pairs absolute source/output indices with probed properties and retained originals', () => {
  const item = fixture();
  const output = { streams: [
    { ...item.probe.streams[0], index: 0, disposition: { default: 0 } },
    { ...item.probe.streams[1], index: 1 },
    { ...item.probe.streams[0], index: 2, codec_name: 'dts', tags: { language: 'jpn', title: 'Surround · Compatibility (DTS)' } }
  ] };
  const report = conversionReport(item, output);
  assert.match(report, /Source {"index":3,"codec":"flac","channels":6/);
  assert.match(report, /ordinal 0 \(retained original\) {"index":0,"codec":"flac"/);
  assert.match(report, /ordinal 1 \(copy\) {"index":1,"codec":"ac3","channels":2/);
  assert.match(report, /ordinal 2 \(encode, compatibility\) {"index":2,"codec":"dts","channels":6/);
  assert.match(report, /"layout":"5.1\(side\)"/);
  assert.match(report, /"language":"jpn"/);
  assert.match(report, /"default":1/);
  assert.match(report, /receiver passthrough are not measured/);
  assert.throws(() => conversionReport(item, { streams: [] }), /missing output/);
  item.probe.streams[0].tags.title = '<script>\nnot HTML';
  assert.match(conversionReport(item, output), /<script>\\nnot HTML/);
});

test('real filtered copy-only output preserves no-default intent and track metadata', { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-default-mapping-'));
  try {
    const tools = toolPaths(), engine = new Engine(tools), input = path.join(dir, 'source.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-map', '0:a', '-map', '0:a', '-t', '1', '-c:a', 'ac3',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
      '-metadata:s:a:1', 'title=Japanese stereo', '-disposition:a:0', 'default', '-disposition:a:1', '0', input]);
    const item = await engine.inspect(input);
    item.plan = { ...item.plan, needsConversion: true, tracks: [item.plan.tracks[1]], droppedStreams: [0], streamsToDrop: ['0:0'] };
    const snapshots = [];
    const result = await engine.convert(item, dir, { onTemporaryOutput: async (temp, snapshot) => {
      if (snapshot) {
        assert.deepEqual(snapshot, await require('../src/source-safety').sourceIdentity(temp));
        snapshots.push(snapshot);
      }
    } });
    assert.equal(snapshots.length, 1);
    const output = await engine.probe(result.output);
    assert.equal(output.streams.length, 1);
    assert.equal(output.streams[0].disposition.default, 0);
    assert.equal(output.streams[0].tags.language, 'jpn');
    assert.equal(output.streams[0].tags.title, 'Japanese stereo');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});