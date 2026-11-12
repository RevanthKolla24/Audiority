const test = require('node:test');
const assert = require('node:assert/strict');
const { verificationWorkers } = require('../src/verification-workers');
const { audioFingerprints } = require('../src/audio-fingerprints');

const flush = () => new Promise(resolve => setImmediate(resolve));

test('verification refills an available slot without waiting for its slow peer', async () => {
  const started = [], finish = new Map();
  const pending = verificationWorkers([0, 1, 2, 3], target => {
    started.push(target); return new Promise(resolve => finish.set(target, resolve));
  });
  await flush(); assert.deepEqual(started, [0, 1]);
  finish.get(1)(); await flush(); assert.deepEqual(started, [0, 1, 2]);
  finish.get(2)(); await flush(); assert.deepEqual(started, [0, 1, 2, 3]);
  finish.get(3)(); finish.get(0)(); await pending;
});

test('verification respects reduced budgets and drains active work on cancellation', async () => {
  const controller = new AbortController(), finish = new Map(), started = [];
  let limit = 2;
  const pending = verificationWorkers([0, 1, 2, 3], target => {
    started.push(target); return new Promise(resolve => finish.set(target, resolve));
  }, { limit: () => limit, signal: controller.signal });
  await flush(); limit = 1;
  finish.get(1)(); await flush(); assert.deepEqual(started, [0, 1]);
  finish.get(0)(); await flush(); assert.deepEqual(started, [0, 1, 2]);
  controller.abort(); finish.get(2)(); await assert.rejects(pending, /Cancelled/);
  assert.deepEqual(started, [0, 1, 2]);
});

test('verification failures stop new work and drain peers before rejection', async () => {
  let fail, finish, drained = false;
  const pending = verificationWorkers([0, 1, 2], target => {
    if (target === 2) throw new Error('Unexpected new work');
    return target === 0 ? new Promise((_resolve, reject) => { fail = reject; }) : new Promise(resolve => { finish = () => { drained = true; resolve(); }; });
  });
  await flush(); fail(new Error('Mismatch')); await flush();
  assert.equal(drained, false); finish(); await assert.rejects(pending, /Mismatch/);
  assert.equal(drained, true);
});

test('audio fingerprints require complete hashes, indices and nonempty selected streams', () => {
  const packet = (index, char) => `stream_index=${index}|pos=20|data_hash=SHA256:${char.repeat(64)}`;
  const scan = audioFingerprints([1, 3]);
  scan.packet(packet(1, 'a')); scan.packet(packet(3, 'b')); scan.packet(packet(1, 'b'));
  assert.deepEqual(scan.finish().map(entry => entry.count), [2, 1]);
  assert.throws(() => audioFingerprints([1]).packet('data_hash=SHA256:abc'), /stream index/);
  assert.throws(() => audioFingerprints([1]).packet('stream_index=1|data_hash=SHA256:abc'), /malformed/);
  assert.throws(() => audioFingerprints([1]).finish(), /no verifiable packets/);
  const missing = audioFingerprints([1, 3]); missing.packet(packet(1, 'a'));
  assert.throws(() => missing.finish(), /stream 3/);
  const first = audioFingerprints([1]), reversed = audioFingerprints([1]);
  first.packet(packet(1, 'a')); first.packet(packet(1, 'b'));
  reversed.packet(packet(1, 'b')); reversed.packet(packet(1, 'a'));
  assert.notEqual(first.finish()[0].hash, reversed.finish()[0].hash);
});