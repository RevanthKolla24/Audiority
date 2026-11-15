const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Engine, run, verifyOutput } = require('../src/engine');
const { toolPaths } = require('../src/tools');
const { verificationPhases } = require('../src/verification-progress');

test('changed audio verification remains a visible pending phase until payload and decode checks finish', () => {
  const progress = verificationPhases({ video: 1, changedAudio: 3 });
  assert.ok(progress('Checking video 1', { done: true }).pending.includes('Changed audio integrity'));
  progress('Checking extracted audio 1: source core', { done: true });
  progress('Checking extracted audio 1: output', { done: true });
  const complete = progress('Decoding changed audio across full duration…', { done: true });
  assert.equal(complete.phase, 'Changed audio integrity');
  assert.equal(complete.fraction, 1);
});

test('structure verification rejects lost chapters, chapter edits and global metadata changes', () => {
  const stream = { index: 0, codec_type: 'audio', codec_name: 'ac3', channels: 2,
    channel_layout: 'stereo', sample_rate: '48000' };
  const probe = { streams: [stream], format: { duration: '2', tags: { TITLE: 'Movie', encoder: 'source' } },
    chapters: [{ start_time: '0', end_time: '2', tags: { title: 'Opening' } }] };
  const item = { duration: 2, probe, plan: { tracks: [{ ...stream, action: 'copy', codec: 'ac3', layout: 'stereo' }] } };
  const output = structuredClone(probe);
  output.format.tags = { title: 'Movie', encoder: 'new muxer' };
  verifyOutput(item, output);
  for (const change of [
    value => { value.chapters = []; },
    value => { value.chapters[0].end_time = '1'; },
    value => { value.chapters[0].tags.title = 'Wrong'; },
    value => { value.format.tags.title = 'Wrong'; }
  ]) {
    const changed = structuredClone(output); change(changed);
    assert.throws(() => verifyOutput(item, changed), /Verification failed/);
  }
});

test('metadata accepts only equivalent valid creation times and recognized Matroska aliases', () => {
  const stream = { index: 0, codec_type: 'audio', codec_name: 'ac3', channels: 2, channel_layout: 'stereo' };
  const sourceTags = { creation_time: '2020-01-01T00:00:00.123456Z', performer: 'Artist', track: '03', CUSTOM: 'Keep me', constructor: 'Literal user tag' };
  const item = { probe: { streams: [stream], format: { tags: sourceTags } },
    plan: { tracks: [{ index: 0, action: 'copy', codec: 'ac3', channels: 2, layout: 'stereo' }] } };
  const output = tags => ({ streams: [stream], format: { tags } });
  const equivalent = { creation_time: '2020-01-01T01:00:00.123456000+01:00', LEAD_PERFORMER: 'Artist', PART_NUMBER: '03', custom: 'Keep me', CONSTRUCTOR: 'Literal user tag' };
  verifyOutput(item, output(equivalent));
  verifyOutput(item, output({ ...equivalent, performer: 'Artist', track: '03' }));
  const whole = structuredClone(item);
  whole.probe.format.tags.creation_time = '2020-01-01T00:00:00Z';
  verifyOutput(whole, output({ ...equivalent, creation_time: '2019-12-31T19:00:00.000000-0500' }));
  for (const change of [
    tags => { tags.creation_time = '2020-01-01T00:00:00.123457Z'; },
    tags => { delete tags.creation_time; },
    tags => { tags.LEAD_PERFORMER = 'Other artist'; },
    tags => { delete tags.PART_NUMBER; },
    tags => { tags.custom = 'Changed'; },
    tags => { tags.CONSTRUCTOR = 'Changed'; },
    tags => { tags.performer = 'Conflicting'; },
    tags => { tags.TRACK = 'Conflicting'; },
    tags => { tags.creation_time = '2020-02-30T00:00:00Z'; }
  ]) {
    const changed = { ...equivalent }; change(changed);
    assert.throws(() => verifyOutput(item, output(changed)), /Verification failed/);
  }
  // Invalid and timezone-less values remain literal, never guessed or normalized.
  for (const value of ['not a date', '2020-02-30T00:00:00Z', '2020-01-01T00:00:00', '2020-01-01T00:00:00+25:00']) {
    const invalid = structuredClone(item); invalid.probe.format.tags.creation_time = value;
    verifyOutput(invalid, output({ ...equivalent, creation_time: value }));
    assert.throws(() => verifyOutput(invalid, output(equivalent)), /metadata changed/);
  }
  const conflict = structuredClone(item); conflict.probe.format.tags.LEAD_PERFORMER = 'Conflicting';
  assert.throws(() => verifyOutput(conflict, output(equivalent)), /conflicting metadata aliases/);
});

test('complete core payload verification rejects wrong-track and truncated DTS; decode rejects invalid audio', { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-core-integrity-'));
  try {
    const tools = toolPaths(), engine = new Engine(tools);
    const input = path.join(directory, 'source.mkv'), wrong = path.join(directory, 'wrong.mkv');
    const short = path.join(directory, 'short.mkv'), invalid = path.join(directory, 'invalid.mkv');
    for (const [file, frequency] of [[input, 440], [wrong, 880]]) {
      await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`,
        '-t', '1', '-c:a', 'dca', '-strict', 'experimental', file]);
    }
    const probe = await engine.probe(input);
    const item = { file: input, probe, plan: { tracks: [{ index: 0, action: 'extract', codec: 'dts' }] } };
    // Ordinary DTS exercises integrity mechanics, not genuine DTS-HD acceptance.
    await engine.verifyChangedAudio(item, input);
    await assert.rejects(engine.verifyChangedAudio(item, wrong), /payload differs/);
    await run(tools.ffmpeg, ['-v', 'error', '-i', input, '-t', '0.3', '-c', 'copy', short]);
    await assert.rejects(engine.verifyChangedAudio(item, short), /payload differs/);
    await fs.writeFile(invalid, 'not media');
    const encoded = { ...item, plan: { tracks: [{ index: 0, action: 'encode', codec: 'ac3' }] } };
    await assert.rejects(engine.verifyChangedAudio(encoded, invalid), /exited/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(engine.verifyChangedAudio(item, input, controller.signal), /Cancelled/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('real conversion preserves chapters and stable global metadata', { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-chapter-integrity-'));
  try {
    const engine = new Engine(toolPaths()), input = path.join(directory, 'source.mkv');
    const metadata = path.join(directory, 'chapters.txt');
    await fs.writeFile(metadata, ';FFMETADATA1\ntitle=Garden fixture\nartist=Audiority QA\nperformer=Test performer\ntrack=3\ncreation_time=2020-01-01T00:00:00Z\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Opening\n');
    await run(engine.tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-f', 'ffmetadata', '-i', metadata, '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-t', '1', '-c:a', 'flac', input]);
    const item = await engine.inspect(input);
    const result = await engine.convert(item, directory);
    const output = await engine.probe(result.output);
    verifyOutput(item, output);
    assert.equal(output.chapters[0].tags.title, 'Opening');
    assert.equal(output.format.tags.title, 'Garden fixture');
    // Exercise generic aliases and source timestamp spelling against a genuine
    // Matroska muxer's transformed tag names and creation-time representation.
    const source = structuredClone(item);
    source.probe.format.tags = { ...source.probe.format.tags, performer: 'Test performer', track: '3', creation_time: '2020-01-01T00:00:00Z' };
    verifyOutput(source, output);
    const remux = path.join(directory, 'remux.mkv');
    await run(engine.tools.ffmpeg, ['-v', 'error', '-i', input, '-map', '0', '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy', remux]);
    const copied = { ...source, plan: { tracks: [{ ...source.plan.tracks[0], action: 'copy', codec: 'flac' }] } };
    verifyOutput(copied, await engine.probe(remux));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});