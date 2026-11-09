const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/engine');

test('verification subprocess stops on inactivity and drains before rejecting', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { idleTimeoutMs: 100 }), /Verification stalled/);
});

test('tool activity resets the inactivity deadline', async () => {
  const script = 'let n = 0; const timer = setInterval(() => { console.log(++n); if (n === 4) clearInterval(timer); }, 60)';
  const result = await run(process.execPath, ['-e', script], { idleTimeoutMs: 1000 });
  assert.match(result.stdout, /4/);
});

test('verification subprocess remains cancellable', async () => {
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, idleTimeoutMs: 10000 });
  controller.abort();
  await assert.rejects(pending, /Cancelled/);
});