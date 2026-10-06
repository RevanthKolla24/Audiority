const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Engine } = require('../src/engine');

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-probe-pool-'));
  const log = path.join(directory, 'events');
  const binary = path.join(directory, 'probe');
  await fs.writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const log = ${JSON.stringify(log)};
const record = event => fs.appendFileSync(log, JSON.stringify({ event, pid: process.pid }) + '\\n');
record('start');
process.on('exit', () => record('end'));
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => { console.log(process.argv.at(-1) === 'changed' ? 'different' : 'identical'); }, 100);
`, { mode: 0o755 });
  const engine = new Engine({ ffprobe: binary });
  const item = { file: 'source', plan: { needsConversion: true }, probe: { streams: Array.from({ length: 6 }, (_, index) => ({ index, codec_type: index % 2 ? 'attachment' : 'subtitle' })) } };
  const events = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  return { directory, engine, item, events };
}

test('subtitle verification overlaps hashes with at most four processes', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await f.engine.verifySubtitles(f.item, 'output');
    let active = 0, peak = 0;
    const events = await f.events();
    for (const entry of events) { active += entry.event === 'start' ? 1 : -1; peak = Math.max(peak, active); }
    assert.ok(peak > 1); assert.ok(peak <= 4); assert.equal(active, 0);
    assert.equal(events.filter(e => e.event === 'start').length, 12);
  } finally { await fs.rm(f.directory, { recursive: true, force: true }); }
});

test('subtitle mismatch cancels peers and drains them before returning', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.engine.verifySubtitles(f.item, 'changed'), /Verification failed.*stream/);
    const events = await f.events();
    assert.equal(events.filter(e => e.event === 'start').length, events.filter(e => e.event === 'end').length);
  } finally { await fs.rm(f.directory, { recursive: true, force: true }); }
});

test('subtitle verification handles empty targets, skipped conversions and cancellation', async () => {
  const engine = new Engine({ ffprobe: '/nonexistent-probe' });
  await engine.verifySubtitles({ plan: { needsConversion: false } }, 'output');
  await engine.verifySubtitles({ plan: { needsConversion: true }, probe: { streams: [] } }, 'output');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(engine.verifySubtitles({ file: 'source', plan: { needsConversion: true }, probe: { streams: [{ index: 0, codec_type: 'subtitle' }] } }, 'output', controller.signal), /Cancelled/);
});