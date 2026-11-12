const test = require('node:test');
const assert = require('node:assert/strict');
const { verificationProgress } = require('../src/verification-progress');
const { verificationPhases } = require('../src/verification-progress');

test('font-heavy movies estimate long video scans independently of cheap attachment checks', () => {
  let time = 0;
  const update = verificationPhases({ video: 2, audio: 0, subtitle: 4, attachment: 116 }, () => time);
  update('Checking video 1: source', { fraction: 0 });
  time = 10000;
  const video = update('Checking video 1: output', { fraction: 0.5 });
  assert.equal(video.total, 2);
  assert.equal(video.fraction, 0.25);
  assert.equal(video.remainingHigh, 60);
  assert.deepEqual(video.pending, ['Subtitle checks', 'Font / attachment checks']);
  time = 600000;
  update('Checking video 1: source', { done: true });
  assert.equal(update('Checking video 1: output', { done: true }).fraction, 1);
  const font = update('Checking attachment stream 9: source', { done: true });
  assert.equal(font.phase, 'Font / attachment checks');
  assert.equal(font.elapsed, 0);
  assert.equal(font.remainingHigh, null);
  assert.equal(update('Checking output structure…'), undefined);
});

test('verification combines parallel scans, counts pending checks and estimates only after warmup', () => {
  let time = 0;
  const update = verificationProgress(4, () => time);
  assert.equal(update('source', { fraction: 0.5 }).remainingLow, null);
  time = 10000;
  const state = update('output', { fraction: 0.5 });
  assert.equal(state.fraction, 0.25);
  assert.equal(state.remainingLow, 15);
  assert.equal(state.remainingHigh, 60);
  assert.equal(update('source', { fraction: 0.1 }).fraction, 0.25);
  assert.equal(update('source', { done: true }).completed, 1);
  assert.equal(update('output', { done: true }).completed, 2);
  assert.equal(update('sparse', { fraction: 0 }).fraction, 0.5);
  update('sparse', { done: true });
  assert.equal(update('font', { done: true }).fraction, 1);
  assert.equal(update('font').remainingLow, null);
});

test('empty verification has no fabricated time remaining', () => {
  assert.equal(verificationProgress(0)('none').remainingLow, null);
});

test('sparse or missing scan positions do not fabricate an ETA and long scans use measured phase throughput', () => {
  let time = 0;
  const update = verificationPhases({ video: 2, attachment: 100 }, () => time);
  update('Checking video 1: source', { fraction: 0 });
  time = 600000;
  assert.equal(update('Checking video 1: source', {}).remainingHigh, null);
  assert.equal(update('Checking video 1: output', { fraction: 0 }).remainingLow, null);
  update('Checking video 1: source', { fraction: 0.5 });
  const halfway = update('Checking video 1: output', { fraction: 0.5 });
  assert.equal(halfway.remainingLow, 300);
  assert.equal(halfway.remainingHigh, 1200);
  assert.equal(update('Checking video 1: source', { fraction: 0.1 }).fraction, 0.5);
  update('Checking video 1: source', { done: true });
  assert.equal(update('Checking video 1: output', { done: true }).remainingHigh, null);
});

test('scan offsets including unavailable positions never affect content fingerprints', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { hashProbe } = require('../src/engine');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-offsets-'));
  try {
    const script = path.join(dir, 'probe.js');
    await fs.writeFile(script, `console.log('    "pos": "' + process.argv.at(-1) + '",'); console.log('    "data_hash": "SHA256:identical"');`);
    const activity = [];
    const fingerprint = value => hashProbe(process.execPath, [script, value], undefined, (_count, state) => activity.push(state));
    assert.equal(await fingerprint('10'), await fingerprint('999'));
    assert.equal(await fingerprint('N/A'), await fingerprint('-1'));
    assert.equal(await fingerprint('10'), await fingerprint('N/A'));
    assert.ok(activity.some(state => state.done));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});