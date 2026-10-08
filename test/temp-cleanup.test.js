const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cleanupOrphanedTempFiles } = require('../src/app-state');
const partial = '.Episode.audiority.12345678-1234-1234-1234-123456789abc.partial.mkv';

test('startup sweep is shallow and handles nested destinations only when explicitly supplied', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-cleanup-'));
  try {
    const season = path.join(root, 'Season 01'); await fs.mkdir(season);
    const keep = ['movie.mkv', 'movie.partial.mkv', '.movie.invalid.partial.mkv', `${partial}.bak`];
    for (const name of [...keep, partial]) await fs.writeFile(path.join(root, name), 'test');
    await fs.writeFile(path.join(season, partial), 'orphan');
    assert.equal(await cleanupOrphanedTempFiles(root), 1);
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