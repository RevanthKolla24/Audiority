const fs = require('node:fs/promises');
const path = require('node:path');
const { estimatedAudioBytes } = require('./conversion-estimates');
const reserveBytes = 64 * 1024 * 1024;

function storageBudget(item) {
  const outputBytes = Math.ceil(Math.max(0, item.size || 0) + estimatedAudioBytes(item));
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 0 || !Number.isSafeInteger(outputBytes * 2 + reserveBytes)) throw new Error('Cannot safely estimate storage for this job. Re-import the source.');
  // Keep the verified temporary file while an exclusive fallback copy is published.
  return { outputBytes, requiredBytes: outputBytes * 2 + reserveBytes };
}

async function checkSpace(directory, item, io = fs) {
  const stat = await io.statfs(directory);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes < 0) throw new Error('Could not determine destination free space.');
  const budget = storageBudget(item);
  if (freeBytes < budget.requiredBytes) {
    const error = new Error('Insufficient free space for safe conversion and possible publication copy. Choose another destination or free space.');
    error.code = 'ENOSPC';
    throw error;
  }
  return { freeBytes, ...budget };
}

async function previewBatch(items, base, preferences, io = fs) {
  if (!base) throw new Error('Choose an output folder first.');
  const root = await io.realpath(base);
  if (!(await io.stat(root)).isDirectory()) throw new Error('Output destination is not a folder.');
  const stat = await io.statfs(root);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes < 0) throw new Error('Could not determine destination free space.');
  const reserved = new Set(), rows = [];
  let retainedBytes = 0, peakBytes = 0;
  const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
  for (const item of items) {
    if (item.output || item.plan?.blocked || !item.plan?.needsConversion || !['Ready', 'Error', 'Cancelled'].includes(item.status)) continue;
    const relative = preferences.preserveFolders ? item.relativeDirectory || '' : '';
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..')) throw new Error('Unsafe output folder path.');
    let directory = root;
    // Inspect existing ancestors without creating directories or following symlinks.
    for (const part of relative.split(path.sep).filter(Boolean)) {
      directory = path.join(directory, part);
      try {
        const entry = await io.lstat(directory);
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Output subfolders must be real directories.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const basename = `${path.parse(item.name).name}${preferences.outputSuffix}`;
    let destination, conflicts = 0;
    for (let index = 0; index < 10000; index++) {
      const candidate = path.join(directory, `${basename}${index ? ` (${index})` : ''}.mkv`);
      let exists = reserved.has(key(candidate));
      if (!exists) {
        try { await io.lstat(candidate); exists = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!exists) { destination = candidate; break; }
      conflicts++;
    }
    if (!destination) throw new Error('Too many output filename conflicts.');
    reserved.add(key(destination));
    const budget = storageBudget(item);
    peakBytes = Math.max(peakBytes, retainedBytes + budget.requiredBytes);
    retainedBytes += budget.outputBytes;
    rows.push({ id: item.id, name: item.name, destination, conflicts, ...budget });
  }
  return { freeBytes, outputBytes: retainedBytes, requiredBytes: peakBytes, sufficient: freeBytes >= peakBytes, rows };
}

module.exports = { storageBudget, checkSpace, previewBatch };