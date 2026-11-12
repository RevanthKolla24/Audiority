const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Engine, run } = require('../src/engine');
const { toolPaths } = require('../src/tools');
const { estimatedAudioBytes } = require('../src/conversion-estimates');
const { createResourceBudget } = require('../src/resource-budget');
const { preferencesDefaults, validatePreferences } = require('../src/app-state');

test('space estimates use planned PCM precision/rate/channels and compressed bitrates', () => {
  const item = { duration: 10, size: 100, probe: { streams: [] }, plan: { tracks: [
    { action: 'encode', codec: 'pcm_s24le', sampleRate: 48000, channels: 2 },
    { action: 'encode', codec: 'dca', bitrate: '1536000' },
    { action: 'encode', codec: 'ac3', bitrate: '384k' },
    { action: 'copy', codec: 'ac3' }
  ] } };
  assert.equal(estimatedAudioBytes(item), 10 * 48000 * 2 * 3 + 10 * (1536000 + 384000) / 8);
  assert.equal(estimatedAudioBytes({ ...item, duration: NaN }), 100);
});

test('adaptive budget requires sustained headroom and backs off on pressure or invalid telemetry', () => {
  let time = 0, total = 0, idle = 0, free = 4 * 1024 ** 3, bad = false;
  const budget = createResourceBudget('adaptive', { now: () => time,
    sample: () => bad ? {} : ({ total, idle, free, cores: 8, memory: 8 * 1024 ** 3 }) });
  const tick = usage => { time += 1000; total += 100; idle += 100 * (1 - usage); return budget.limit(); };
  try {
    assert.equal(budget.limit(), 1);
    for (let i = 0; i < 4; i++) assert.equal(tick(0.1), 1);
    assert.equal(tick(0.1), 2);
    assert.equal(tick(0.9), 1);
    for (let i = 0; i < 5; i++) tick(0.1);
    assert.equal(budget.limit(), 2);
    free = 100; assert.equal(tick(0.1), 1);
    bad = true; assert.equal(tick(0), 1);
  } finally { budget.close(); }
  assert.equal(preferencesDefaults().performanceMode, 'balanced');
  assert.equal(validatePreferences({ ...preferencesDefaults(), performanceMode: 'adaptive' }).performanceMode, 'adaptive');
  assert.throws(() => validatePreferences({ ...preferencesDefaults(), performanceMode: 'unlimited' }));
});

test('subprocess callback exceptions reject safely after the child drains', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'console.log("packet"); setInterval(() => {}, 1000)'], {
    onLine() { throw new Error('Invalid packet'); }
  }), /Invalid packet/);
});

test('real conversion rejects source changes and consolidated audio checks detect changed copied payloads', { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-conversion-safety-'));
  try {
    const tools = toolPaths(), engine = new Engine(tools);
    const input = path.join(dir, 'source.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*440*t)|sin(2*PI*550*t):s=48000:c=stereo',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
      '-map', '0:a', '-map', '1:a', '-map', '2:a', '-t', '1', '-c:a:0', 'flac', '-c:a:1', 'ac3', '-c:a:2', 'ac3', input]);
    const stale = await engine.inspect(input);
    await fs.appendFile(input, Buffer.from([0]));
    await assert.rejects(engine.convert(stale, dir), /Source changed since inspection/);
    const item = await engine.inspect(input);
    const stages = [];
    const result = await engine.convert(item, dir, { preferences: { ...preferencesDefaults(), performanceMode: 'adaptive' },
      onVerification: label => stages.push(label) });
    assert.deepEqual(Object.keys(result.timings).sort(), ['audio', 'conversion', 'publication', 'structure', 'subtitlesAndAttachments', 'total', 'video']);
    for (const seconds of Object.values(result.timings)) assert.ok(Number.isFinite(seconds) && seconds >= 0);
    const measured = Object.entries(result.timings).filter(([key]) => key !== 'total').reduce((sum, [, seconds]) => sum + seconds, 0);
    assert.ok(result.timings.total >= measured);
    assert.match(result.conversionReport, /"codec":"pcm_s24le","channels":2/);
    assert.ok(stages.some(label => label.startsWith('Checking copied audio: source')));
    assert.ok(!stages.some(label => label.startsWith('Checking retained audio')));
    const changed = path.join(dir, 'changed.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-i', result.output, '-map', '0', '-c', 'copy', '-c:a:1', 'ac3', '-b:a:1', '192k', changed]);
    await assert.rejects(engine.verifyCopiedAudio(item, changed), /copied or retained original audio changed/);
    const swapped = path.join(dir, 'swapped.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-i', result.output, '-map', '0:a:0', '-map', '0:a:2', '-map', '0:a:1', '-c', 'copy', swapped]);
    await assert.rejects(engine.verifyCopiedAudio(item, swapped), /copied or retained original audio changed/);
    const fresh = await engine.inspect(input);
    let published = false;
    await assert.rejects(engine.convert(fresh, dir, {
      onStage(stage) { if (stage === 'Verifying') fsSyncTouch(); },
      onPublished() { published = true; }
    }), /Source changed during processing/);
    function fsSyncTouch() { require('node:fs').appendFileSync(input, Buffer.from([0])); }
    assert.equal(published, false);
    assert.equal((await fs.readdir(dir)).some(name => name.includes('.partial.')), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});