const fs = require('node:fs/promises');

// A conservative change detector, not a content hash. Never follow a replaced symlink.
async function sourceIdentity(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Source is no longer a regular file.');
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]));
}

function sameSource(before, after) {
  return !!before && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]);
}

async function outputState(file, snapshot, io = fs) {
  if (!file) return 'invalid';
  try {
    const stat = await io.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return 'invalid';
    return !snapshot || sameSource(snapshot, stat) ? 'valid' : 'invalid';
  } catch (error) {
    if (error.code === 'ENOENT') {
      // A disconnected mount can look like a missing file. Only conclude that
      // the file is missing when its containing directory is accessible.
      try { await io.access(require('node:path').dirname(file)); return 'invalid'; }
      catch { return 'unavailable'; }
    }
    return 'unavailable';
  }
}

async function validOutput(file, snapshot) {
  return await outputState(file, snapshot) === 'valid';
}

function validateIdentity(value) {
  if (!value || !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => Number.isFinite(value[key])) || value.size <= 0) throw new Error('Invalid output identity.');
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, value[key]]));
}

module.exports = { sourceIdentity, sameSource, validOutput, outputState, validateIdentity };