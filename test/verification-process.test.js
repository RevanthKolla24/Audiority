const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/engine');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const advancingProgress = () => {
  let last = -1;
  return line => {
    if (!/^out_time_us=\d+$/.test(line)) return false;
    const current = Number(line.slice(12));
    if (current <= last) return false;
    last = current; return true;
  };
};

test('separate progress keeps healthy verification alive beyond the stall window without contaminating hashes', { timeout: 10000 }, async () => {
  const script = 'const fs=require("node:fs");let n=0;const timer=setInterval(()=>{fs.writeSync(3,`out_time_us=${++n}\\nprogress=continue\\n`);if(n===8){clearInterval(timer);process.stdout.write("SHA256=reference\\n")}},100)';
  const result = await run(process.execPath, ['-e', script], {
    progressTimeoutMs: 500, onProgressLine: advancingProgress()
  });
  assert.equal(result.stdout, 'SHA256=reference\n');
  assert.equal(result.stderr, '');
});

test('stalled or repeated progress is bounded, drains the child, and allows recovery', { timeout: 10000 }, async () => {
  for (const repeated of [false, true]) {
    const script = `const fs=require("node:fs");fs.writeSync(3,"out_time_us=1\\n");${repeated ? 'setInterval(()=>fs.writeSync(3,"out_time_us=1\\nprogress=continue\\n"),30);' : ''}setInterval(()=>{},1000);`;
    let pid;
    // Record the child PID via the progress channel so process closure can be
    // checked before any caller performs temporary-output cleanup.
    const record = advancingProgress();
    await assert.rejects(run(process.execPath, ['-e', `require("node:fs").writeSync(3,"pid="+process.pid+"\\n");${script}`], {
      progressTimeoutMs: 400, onProgressLine: line => {
        if (line.startsWith('pid=')) pid = Number(line.slice(4));
        return record(line);
      }
    }), /no advancing tool progress/);
    assert.ok(pid);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  const recovered = await run(process.execPath, ['-e', 'process.stdout.write("recovered")']);
  assert.equal(recovered.stdout, 'recovered');
});

test('progress cancellation waits for close; stalled children ignoring SIGTERM are killed before cleanup', { timeout: 10000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-progress-close-'));
  try {
    for (const cancel of [false, true]) {
      if (!cancel && process.platform === 'win32') continue;
      const file = path.join(directory, cancel ? 'cancel.partial' : 'stall.partial');
      const controller = new AbortController();
      let pid;
      const script = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(file)},"private");process.on("SIGTERM",()=>{});fs.writeSync(3,"pid="+process.pid+"\\n");setInterval(()=>{},1000)`;
      await assert.rejects(run(process.execPath, ['-e', script], {
        signal: controller.signal, progressTimeoutMs: 400, onProgressLine: line => {
          if (line.startsWith('pid=')) { pid = Number(line.slice(4)); if (cancel) controller.abort(); }
          return false;
        }
      }), cancel ? /Cancelled/ : /no advancing tool progress/);
      assert.ok(pid);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await fs.unlink(file);
      await assert.rejects(fs.access(file), { code: 'ENOENT' });
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('progress pipe errors, oversized lines, callback failures and spawn failures settle safely', async () => {
  for (const options of [
    { progressTimeoutMs: -1 }, { progressTimeoutMs: Infinity },
    { progressTimeoutMs: 1 }, { onProgressLine: true }
  ]) {
    await assert.rejects(run(process.execPath, ['-e', ''], options), /Invalid progress watchdog/);
  }
  await assert.rejects(run(process.execPath, ['-e', 'require("node:fs").writeSync(3,"x".repeat(4096));setInterval(()=>{},1000)'], {
    progressTimeoutMs: 1000, maxLineBytes: 128, onProgressLine: () => false
  }), /progress line exceeded/);
  const failure = new Error('progress callback failed');
  await assert.rejects(run(process.execPath, ['-e', 'require("node:fs").writeSync(3,"last");'], {
    progressTimeoutMs: 1000, onProgressLine: () => { throw failure; }
  }), error => error === failure);
  await assert.rejects(run(path.join(os.tmpdir(), 'audiority-nonexistent-tool', 'ffmpeg'), [], {
    progressTimeoutMs: 1000, onProgressLine: () => false
  }), { code: 'ENOENT' });
});

test('explicit subprocess disk-full diagnostics retain ENOSPC without masking unrelated failures', async () => {
  for (const diagnostic of ['No space left on device', 'There is not enough space on the disk', 'Disk full']) {
    await assert.rejects(run(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(diagnostic)});process.exit(1)`]),
      error => error.code === 'ENOSPC' && error.message.includes(diagnostic));
  }
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("Permission denied");process.exit(1)']),
    error => error.code === undefined && /Permission denied/.test(error.message));
});

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