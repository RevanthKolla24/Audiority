const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { constants } = require('node:fs');
const { publishOutput } = require('../src/engine');
const failure = code => Object.assign(new Error(code), { code });

test('publication preserves collisions on hard-link and unsupported-link copy paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-publish-'));
  try {
    const temp = path.join(directory, '.partial.mkv');
    await fs.writeFile(temp, 'verified media');
    await fs.writeFile(path.join(directory, 'episode.mkv'), 'existing media');
    const linked = await publishOutput(temp, directory, 'episode');
    assert.equal(linked.copied, false);
    assert.equal(path.basename(linked.destination), 'episode (1).mkv');
    for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS']) {
      const result = await publishOutput(temp, directory, 'episode', { io: { ...fs, link: async () => { throw failure(code); } } });
      assert.equal(result.copied, true);
      assert.equal(await fs.readFile(result.destination, 'utf8'), 'verified media');
    }
    assert.equal(await fs.readFile(path.join(directory, 'episode.mkv'), 'utf8'), 'existing media');
    assert.equal(await fs.readFile(temp, 'utf8'), 'verified media');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('exclusive copy retries a concurrent collision without unlinking another file', async () => {
  let calls = 0;
  const io = {
    link: async () => { throw failure('ENOTSUP'); },
    stat: async () => ({ size: 100 }), statfs: async () => ({ bavail: 1e9, bsize: 1 }),
    copyFile: async (_temp, destination, flags) => {
      assert.equal(flags, constants.COPYFILE_EXCL);
      if (++calls === 1) throw failure('EEXIST');
      assert.ok(destination.endsWith('episode (1).mkv'));
    },
    unlink: async () => assert.fail('Must not unlink a competing destination')
  };
  assert.equal((await publishOutput('/temp', '/output', 'episode', { io })).copied, true);
});

test('publication surfaces copy errors, rejects low space, respects cancellation and does not mask unrelated link errors', async () => {
  const io = {
    link: async () => { throw failure('ENOTSUP'); },
    stat: async () => ({ size: 100 }), statfs: async () => ({ bavail: 1e9, bsize: 1 }),
    copyFile: async () => { throw failure('EFBIG'); },
    unlink: async () => assert.fail('No blind cleanup of final path')
  };
  await assert.rejects(publishOutput('/temp', '/output', 'episode', { io }), /EFBIG/);
  await assert.rejects(publishOutput('/temp', '/output', 'episode', { io: { ...io, statfs: async () => ({ bavail: 0, bsize: 1 }) } }), /Insufficient free space/);
  await assert.rejects(publishOutput('/temp', '/output', 'episode', { io: { ...io, link: async () => { throw failure('EIO'); } } }), /Cannot publish output: EIO/);
  await assert.rejects(publishOutput('/temp', '/output', 'episode', { io, signal: { aborted: true } }), /Cancelled/);
});