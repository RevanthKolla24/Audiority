const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cleanupOrphanedTempFiles, cleanupInterrupted } = require('../src/app-state');
const partial = '.Episode.audiority.12345678-1234-1234-1234-123456789abc.partial.mkv';

test('startup sweep preserves recovered sources, outputs and subtitles with temp-looking names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-protected-cleanup-'));
  try {
    const protectedPaths = [
      path.join(root, partial),
      path.join(root, partial.replace('Episode', 'Published')),
      path.join(root, '.subtitle-12345678-1234-1234-1234-123456789abc.tmp')
    ];
    const orphan = path.join(root, partial.replace('Episode', 'Orphan'));
    for (const file of [...protectedPaths, orphan]) await fs.writeFile(file, 'keep media');
    // Lexically different spellings must receive the same protection.
    const normalizedSource = `${root}/unused/../${path.basename(protectedPaths[0])}`;
    const items = [{ file: normalizedSource, output: protectedPaths[1], sidecars: [{ file: protectedPaths[2], suffix: '.srt' }] }];
    assert.equal(await cleanupOrphanedTempFiles(root, { items }), 1);
    await assert.rejects(fs.access(orphan), { code: 'ENOENT' });
    for (const file of protectedPaths) assert.equal(await fs.readFile(file, 'utf8'), 'keep media');
    assert.equal(await cleanupOrphanedTempFiles(root, { items }), 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('interrupted cleanup protects inputs and outputs belonging to any recovered job', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-cross-job-cleanup-'));
  try {
    const temp = path.join(root, partial);
    await fs.writeFile(temp, 'protected');
    for (const reference of [{ file: temp }, { output: temp }, { sidecars: [{ file: temp, suffix: '.srt' }] }]) {
      const interrupted = { file: path.join(root, 'original.mkv'), status: 'Converting', temporaryOutput: temp };
      // Check both item orders so cleanup cannot depend on which job came first.
      for (const items of [[interrupted, reference], [reference, interrupted]]) {
        assert.deepEqual(await cleanupInterrupted(items), []);
        assert.equal(await fs.readFile(temp, 'utf8'), 'protected');
      }
    }
    assert.deepEqual(await cleanupInterrupted([{ file: temp, status: 'Verifying', temporaryOutput: temp }]), []);
    assert.equal(await fs.readFile(temp, 'utf8'), 'protected');
    assert.deepEqual(await cleanupInterrupted([{ file: path.join(root, 'original.mkv'), status: 'Verifying', temporaryOutput: temp }]), []);
    await assert.rejects(fs.access(temp), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('offline outputs block cleanup only when their saved identity could match the temp', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-offline-cleanup-'));
  try {
    const temp = path.join(root, partial);
    const output = path.join(root, 'offline.mkv');
    await fs.writeFile(temp, 'media');
    for (const code of ['EACCES', 'EIO', 'ENODEV']) {
      const stat = await fs.lstat(temp);
      const snapshot = Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]));
      const io = { ...fs, lstat: async file => {
        if (file === output) throw Object.assign(new Error('offline'), { code });
        return fs.lstat(file);
      } };
      for (const outputSnapshot of [undefined, snapshot]) {
        assert.equal(await cleanupOrphanedTempFiles(root, { io, items: [{ output, outputSnapshot }] }), 0);
        assert.ok((await fs.stat(temp)).isFile());
      }
      for (const key of ['dev', 'ino']) {
        const current = await fs.lstat(temp);
        const outputSnapshot = { ...snapshot, dev: current.dev, ino: current.ino, [key]: current[key] + 1 };
        assert.equal(await cleanupOrphanedTempFiles(root, { io, items: [{ output, outputSnapshot }] }), 1);
        await fs.writeFile(temp, 'media');
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('startup sweep is shallow and handles nested destinations only when explicitly supplied', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-cleanup-'));
  try {
    const season = path.join(root, 'Season 01'); await fs.mkdir(season);
    const subtitle = '.subtitle-12345678-1234-1234-1234-123456789abc.tmp';
    const keep = ['movie.mkv', 'movie.partial.mkv', '.movie.invalid.partial.mkv', `${partial}.bak`, '.subtitle-invalid.tmp', 'other.tmp'];
    for (const name of [...keep, partial, subtitle]) await fs.writeFile(path.join(root, name), 'test');
    await fs.writeFile(path.join(season, partial), 'orphan');
    assert.equal(await cleanupOrphanedTempFiles(root), 2);
    assert.equal(await fs.readFile(path.join(season, partial), 'utf8'), 'orphan');
    assert.equal(await cleanupOrphanedTempFiles([root, season, root]), 1);
    for (const name of keep) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), 'test');
    assert.equal(await cleanupOrphanedTempFiles(root), 0);
    assert.equal(await cleanupOrphanedTempFiles(path.join(root, 'missing')), 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('startup cleanup ignores permissions and does not follow symlinks', async () => {
  let deletes = 0;
  const io = {
    lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    readdir: async () => [
      { name: partial, isSymbolicLink: () => true },
      { name: '.subtitle-12345678-1234-1234-1234-123456789abc.tmp', isSymbolicLink: () => true },
      { name: 'outside', isSymbolicLink: () => true }
    ],
    unlink: async () => { deletes++; }
  };
  assert.equal(await cleanupOrphanedTempFiles(os.tmpdir(), { io }), 0);
  assert.equal(deletes, 0);
  io.readdir = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.equal(await cleanupOrphanedTempFiles(os.tmpdir(), { io }), 0);
  io.readdir = async () => [{ name: partial, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }];
  io.lstat = async file => ({ isDirectory: () => file === os.tmpdir(), isSymbolicLink: () => false, isFile: () => file !== os.tmpdir() });
  io.unlink = async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); };
  assert.equal(await cleanupOrphanedTempFiles(os.tmpdir(), { io }), 0);
});