const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { publishSidecar, hashFile } = require('../src/engine');

test('successful subtitle publication retains its verified record when temporary cleanup fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-subtitle-cleanup-'));
  try {
    const file = path.join(dir, 'source.srt'), target = path.join(dir, 'output.srt');
    await fs.writeFile(file, 'captions');
    const record = await publishSidecar({ file }, target, { io: { ...fs, unlink: async () => { throw Object.assign(new Error('locked'), { code: 'EACCES' }); } } });
    assert.equal(record.output, target);
    assert.equal(record.hash, await hashFile(target));
    assert.match(record.warning, /published and verified.*cleanup failed.*locked/);
    assert.equal((await fs.readdir(dir)).filter(name => name.startsWith('.subtitle-')).length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('sidecars publish verified bytes and preserve existing destinations', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-sidecar-'));
  try {
    const file = path.join(dir, 'source.srt'), target = path.join(dir, 'output.srt');
    await fs.writeFile(file, 'verified subtitles');
    const record = await publishSidecar({ file }, target);
    assert.equal(record.hash, await hashFile(target));
    assert.equal(record.file, file);
    await assert.rejects(publishSidecar({ file }, target), /unused output filename/);
    assert.equal(await fs.readFile(target, 'utf8'), 'verified subtitles');
    const fallback = path.join(dir, 'fallback.ass');
    await publishSidecar({ file }, fallback, { io: { ...fs, link: async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); } } });
    assert.equal(await fs.readFile(fallback, 'utf8'), 'verified subtitles');
    assert.ok(!(await fs.readdir(dir)).some(name => name.endsWith('.tmp')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('failed hashes, changed sources, cancellation and source read failures leave no subtitle output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-sidecar-error-'));
  try {
    const file = path.join(dir, 'source.srt'), target = path.join(dir, 'output.srt');
    for (const failure of ['mismatch', 'hash', 'changed', 'cancel', 'read']) {
      await fs.writeFile(file, 'original subtitles');
      const controller = new AbortController();
      let hashes = 0;
      const hash = async candidate => {
        hashes++;
        if (failure === 'hash') throw new Error('Hash read failed');
        if (failure === 'cancel') controller.abort();
        if (failure === 'changed' && hashes === 1) await fs.writeFile(file, 'replacement');
        return failure === 'mismatch' ? String(hashes) : hashFile(candidate);
      };
      const io = { ...fs, open: async (...args) => {
        const handle = await fs.open(...args);
        if (failure === 'read') await fs.unlink(file);
        return handle;
      } };
      await assert.rejects(publishSidecar({ file }, target, { hash, io, signal: controller.signal }));
      await assert.rejects(fs.access(target), { code: 'ENOENT' });
      assert.ok(!(await fs.readdir(dir)).some(name => name.endsWith('.tmp')));
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});