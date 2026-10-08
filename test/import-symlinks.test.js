const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { discoverMedia } = require('../src/imports');
const collect = async iterator => { const result = []; for await (const item of iterator) result.push(item); return result; };

test('imports follow media links, deduplicate targets, skip broken links and terminate cycles', { timeout: 10000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-links-')));
  try {
    const library = path.join(directory, 'Library'), outside = path.join(directory, 'External');
    await fs.mkdir(library); await fs.mkdir(outside);
    const movie = path.join(outside, 'episode.mkv');
    await fs.writeFile(movie, 'test');
    await fs.writeFile(path.join(outside, 'output.audiority.mkv'), 'output');
    try { await fs.symlink(outside, path.join(library, 'Season'), 'junction'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symlink creation requires OS permission'); return; } throw error; }
    await fs.symlink(library, path.join(outside, 'loop'), 'junction');
    try { await fs.symlink(movie, path.join(library, 'alias.mkv'), 'file'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlink creation requires OS permission'); return; } throw error; }
    await fs.symlink(path.join(outside, 'absent.mkv'), path.join(library, 'broken.mkv'), 'file');
    await fs.symlink(path.join(outside, 'output.audiority.mkv'), path.join(library, 'disguised.mkv'), 'file');
    const warnings = [];
    const found = await collect(discoverMedia([library, movie], { onWarning: w => warnings.push(w) }));
    assert.equal(found.length, 1); assert.equal(found[0].file, movie);
    assert.ok(!found[0].relativeDirectory.split(path.sep).includes('..'));
    assert.ok(warnings.some(w => w.includes('broken.mkv')));
    const explicit = await collect(discoverMedia([path.join(library, 'alias.mkv')]));
    assert.equal(explicit[0].file, movie);
    assert.equal(explicit[0].relativeDirectory, '');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});