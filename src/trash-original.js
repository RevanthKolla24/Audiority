/*
 * trash-original.js
 * Main-process safety checks before moving a verified job's source to the OS Trash.
 * The caller supplies Electron's trashItem; tests supply a harmless mock instead.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

// Called only after engine.convert succeeds. Returns warnings, never deletes permanently.
async function trashOriginal(item, result, { enabled, signal, trashItem }) {
  if (!enabled) return [];
  if (signal?.aborted) return ['Original retained: queue was canceled before moving it to Trash.'];
  if ((result.sidecars || []).length < (item.sidecars || []).length) return ['Original retained: not all external subtitles were copied successfully.'];
  try {
    const source = await fs.lstat(item.file);
    const output = await fs.lstat(result.output);
    if (!source.isFile() || source.isSymbolicLink() || !output.isFile() || output.isSymbolicLink() || output.size === 0) throw new Error('Source/output is not a safe regular file.');
    if (await fs.realpath(item.file) === await fs.realpath(result.output) || (source.dev === output.dev && source.ino === output.ino)) throw new Error('Source and output refer to the same file.');
    if (signal?.aborted) return ['Original retained: queue was canceled before moving it to Trash.'];
    await trashItem(path.resolve(item.file));
    return [];
  } catch (error) {
    return [`Could not move original to Trash: ${error.message}`];
  }
}
module.exports = { trashOriginal };