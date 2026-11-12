const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cleanupOrphanedTempFiles, cleanupInterrupted } = require('../src/app-state');
const { sourceIdentity } = require('../src/source-safety');
const partial = '.Episode.audiority.12345678-1234-1234-1234-123456789abc.partial.mkv';

test('temporary identity survives queue storage and malformed identities are rejected', async () => {
  const { saveQueue, loadQueue, validateQueue } = require('../src/app-state');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-temp-snapshot-'));
  try {
    const temp = path.join(root, partial);
    await fs.writeFile(temp, 'partial');
    const snapshot = await sourceIdentity(temp);
    const item = { id: 'job', file: path.join(root, 'source.mkv'), status: 'Verifying', temporaryOutput: temp, temporaryOutputSnapshot: snapshot };
    await saveQueue(root, new Map([[item.id, item]]));
    const restored = (await loadQueue(root)).state.items;
    assert.deepEqual(restored[0].temporaryOutputSnapshot, snapshot);
    assert.throws(() => validateQueue({ version: 1, items: [{ ...item, temporaryOutputSnapshot: { ino: 1 } }] }), /identity/);
    assert.equal(await cleanupOrphanedTempFiles(root, { items: restored }), 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('recovery retains a replacement at a recorded temporary path and legacy paths without identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-replaced-temp-'));
  try {
    const temp = path.join(root, partial);
    await fs.writeFile(temp, 'original partial');
    const snapshot = await require('../src/source-safety').sourceIdentity(temp);
    await fs.rename(temp, path.join(root, 'old-partial'));
    await fs.writeFile(temp, 'unrelated replacement');
    const item = { file: path.join(root, 'source.mkv'), status: 'Verifying', temporaryOutput: temp, temporaryOutputSnapshot: snapshot };
    assert.equal(await cleanupOrphanedTempFiles(root, { items: [item] }), 0);
    await cleanupInterrupted([item]);
    assert.equal(await fs.readFile(temp, 'utf8'), 'unrelated replacement');
    delete item.temporaryOutputSnapshot;
    await cleanupInterrupted([item]);
    assert.equal(await cleanupOrphanedTempFiles(root, { items: [item] }), 0);
    assert.equal(await fs.readFile(temp, 'utf8'), 'unrelated replacement');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('matching names alone never authorize cleanup in shared output folders', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-unowned-cleanup-'));
  try {
    const files = [path.join(root, partial), path.join(root, '.subtitle-12345678-1234-1234-1234-123456789abc.tmp')];
    for (const file of files) await fs.writeFile(file, 'unrelated data');
    assert.equal(await cleanupOrphanedTempFiles(root), 0);
    for (const file of files) assert.equal(await fs.readFile(file, 'utf8'), 'unrelated data');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('one profile cannot sweep another profile’s recorded temporary files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-profile-cleanup-'));
  try {
    const own = path.join(root, partial), other = path.join(root, partial.replace('Episode', 'Other'));
    for (const file of [own, other]) await fs.writeFile(file, 'partial media');
    const ownItem = { temporaryOutput: own, temporaryOutputSnapshot: await sourceIdentity(own) };
    assert.equal(await cleanupOrphanedTempFiles(root, { items: [ownItem] }), 1);
    assert.equal(await fs.readFile(other, 'utf8'), 'partial media');
    assert.equal(await cleanupOrphanedTempFiles(root, { items: [ownItem] }), 0);
    assert.equal(await cleanupOrphanedTempFiles(root, { items: [{ temporaryOutput: other, temporaryOutputSnapshot: await sourceIdentity(other) }] }), 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

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
    const items = [{ file: normalizedSource, output: protectedPaths[1], temporaryOutput: orphan, temporaryOutputSnapshot: await sourceIdentity(orphan), sidecars: [{ file: protectedPaths[2], suffix: '.srt' }] }];
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
      const interrupted = { file: path.join(root, 'original.mkv'), status: 'Converting', temporaryOutput: temp, temporaryOutputSnapshot: await sourceIdentity(temp) };
      // Check both item orders so cleanup cannot depend on which job came first.
      for (const items of [[interrupted, reference], [reference, interrupted]]) {
        assert.deepEqual(await cleanupInterrupted(items), []);
        assert.equal(await fs.readFile(temp, 'utf8'), 'protected');
      }
    }
    assert.deepEqual(await cleanupInterrupted([{ file: temp, status: 'Verifying', temporaryOutput: temp }]), []);
    assert.equal(await fs.readFile(temp, 'utf8'), 'protected');
    assert.deepEqual(await cleanupInterrupted([{ file: path.join(root, 'original.mkv'), status: 'Verifying', temporaryOutput: temp, temporaryOutputSnapshot: await sourceIdentity(temp) }]), []);
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
        assert.equal(await cleanupOrphanedTempFiles(root, { io, items: [{ output, outputSnapshot, temporaryOutput: temp, temporaryOutputSnapshot: await sourceIdentity(temp) }] }), 0);
        assert.ok((await fs.stat(temp)).isFile());
      }
      for (const key of ['dev', 'ino']) {
        const current = await fs.lstat(temp);
        const outputSnapshot = { ...snapshot, dev: current.dev, ino: current.ino, [key]: current[key] + 1 };
        assert.equal(await cleanupOrphanedTempFiles(root, { io, items: [{ output, outputSnapshot, temporaryOutput: temp, temporaryOutputSnapshot: await sourceIdentity(temp) }] }), 1);
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
    const items = [{ temporaryOutput: path.join(root, partial), temporaryOutputSnapshot: await sourceIdentity(path.join(root, partial)) }, { temporaryOutput: path.join(season, partial), temporaryOutputSnapshot: await sourceIdentity(path.join(season, partial)) }];
    assert.equal(await cleanupOrphanedTempFiles(root, { items }), 1);
    assert.equal(await fs.readFile(path.join(root, subtitle), 'utf8'), 'test');
    assert.equal(await fs.readFile(path.join(season, partial), 'utf8'), 'orphan');
    assert.equal(await cleanupOrphanedTempFiles([root, season, root], { items }), 1);
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