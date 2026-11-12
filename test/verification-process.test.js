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

test('captured tool output has a byte limit and rejects rather than returning truncated JSON', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { maxOutputBytes: 1024 }), /output exceeded.*1024/i);
});

test('streamed tool lines are bounded with and without a final newline', async () => {
  for (const newline of [false, true]) {
    let calls = 0;
    await assert.rejects(run(process.execPath, ['-e', `process.stdout.write("x".repeat(4096) + ${JSON.stringify(newline ? '\n' : '')})`],
      { maxLineBytes: 1024, onLine: () => { calls++; } }), /line exceeded.*1024/i);
    assert.equal(calls, 0);
  }
});

test('streamed scans can exceed the capture limit when individual lines are bounded', async () => {
  let lines = 0;
  await run(process.execPath, ['-e', 'process.stdout.write("packet\\n".repeat(1000))'],
    { maxOutputBytes: 64, maxLineBytes: 64, onLine: () => { lines++; } });
  assert.equal(lines, 1000);
});

test('tool output preserves multibyte characters across pipe chunks', async () => {
  const script = 'const b=Buffer.from("日本語\\n");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)';
  const captured = await run(process.execPath, ['-e', script]);
  assert.equal(captured.stdout, '日本語\n');
  const lines = [];
  await run(process.execPath, ['-e', script], { onLine: line => lines.push(line) });
  assert.deepEqual(lines, ['日本語']);
});

test('oversized output terminates and drains a child that ignores graceful termination', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const script = 'process.on("SIGTERM",()=>{});process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)';
  await assert.rejects(run(process.execPath, ['-e', script], { maxOutputBytes: 1024 }), /output exceeded/i);
});

test('tool output limits reject invalid configuration before starting a child', async () => {
  for (const limit of [0, -1, Infinity, 1.5]) {
    await assert.rejects(run(process.execPath, ['-e', ''], { maxOutputBytes: limit }), /Invalid tool output limit/);
    await assert.rejects(run(process.execPath, ['-e', ''], { maxLineBytes: limit }), /Invalid tool output limit/);
  }
});

test('callback failure on an unterminated final line preserves the callback error', async () => {
  const failure = new Error('final line failed');
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("last line")'],
    { onLine: () => { throw failure; } }), error => error === failure);
});