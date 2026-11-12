/*
 * trash-original.js
 * Main-process safety checks before moving a verified job's source to the OS Trash.
 * The caller supplies Electron's trashItem; tests supply a harmless mock instead.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { sourceIdentity, sameSource, validOutput } = require('./source-safety');
const { hashFile } = require('./engine');

// Called only after engine.convert succeeds. Returns warnings, never deletes permanently.
async function trashOriginal(item, result, { enabled, signal, trashItem }) {
  if (!enabled) return [];
  if (signal?.aborted) return ['Original retained: queue was canceled before moving it to Trash.'];
  if (item.plan?.blocked || item.plan?.unresolved || item.plan?.tracks?.some(track => track.blocked || ['unresolved', 'playback-unconfirmed'].includes(track.compatibility))) return ['Original retained: playback compatibility is blocked, unresolved or unconfirmed.'];
  if (item.plan?.droppedStreams?.length) return ['Original retained: language filtering removed source streams. Review the output before removing the source yourself.'];
  if (item.persistencePending || item.publicationPending || item.outputUnavailable) return ['Original retained: output publication or recovery persistence is incomplete.'];
  if ((result.sidecars || []).length < (item.sidecars || []).length) return ['Original retained: not all external subtitles were copied successfully.'];
  try {
    const source = await fs.lstat(item.file);
    const output = await fs.lstat(result.output);
    if (!source.isFile() || source.isSymbolicLink() || !output.isFile() || output.isSymbolicLink() || output.size === 0) throw new Error('Source/output is not a safe regular file.');
    if (await fs.realpath(item.file) === await fs.realpath(result.output) || (source.dev === output.dev && source.ino === output.ino)) throw new Error('Source and output refer to the same file.');
    if (!sameSource(result.sourceSnapshot, await sourceIdentity(item.file))) throw new Error('Source changed since conversion or its identity was not recorded.');
    if (!result.outputSnapshot || !await validOutput(result.output, result.outputSnapshot)) throw new Error('Verified media output changed or its identity was not recorded.');
    // Validate all subtitle copies before removing the media source. Do not trust counts alone.
    const verified = new Map((result.verifiedSidecars || []).map(record => [record.file, record]));
    const checkSubtitle = async sidecar => {
      const record = verified.get(sidecar.file);
      if (!record || !(result.sidecars || []).includes(record.output)) throw new Error('Verified subtitle identity is missing.');
      const before = await sourceIdentity(sidecar.file);
      await sourceIdentity(record.output);
      if (!sameSource(record.identity, before) || await hashFile(sidecar.file, signal) !== record.hash || await hashFile(record.output, signal) !== record.hash || !sameSource(before, await sourceIdentity(sidecar.file))) throw new Error('Subtitle source or verified copy changed.');
    };
    for (const sidecar of item.sidecars || []) await checkSubtitle(sidecar);
    if (!sameSource(result.sourceSnapshot, await sourceIdentity(item.file))) throw new Error('Source changed before Trash cleanup.');
    if (!await validOutput(result.output, result.outputSnapshot)) throw new Error('Verified media output changed before Trash cleanup.');
    if (signal?.aborted) return ['Original retained: queue was canceled before moving it to Trash.'];
    await trashItem(path.resolve(item.file));
    // External subtitle sources may be shared with other media. Never trash them.
    return [];
  } catch (error) {
    return [`Could not move original to Trash: ${error.message}`];
  }
}
module.exports = { trashOriginal };