/*
 * Watch-folder stability tracking, used by the main process's polling timer.
 * Two matching observations reduce incomplete imports; a stalled copy can
 * still look stable. This helper never modifies or converts media itself.
 */
const fs = require('node:fs/promises');
const { discoverMedia } = require('./imports');
const fileKey = file => process.platform === 'win32' ? file.toLowerCase() : file;
class WatchFolder {
  constructor() { this.reset(); }
  // Changing the watched path clears observations and session deduplication.
  reset() { this.previous = new Map(); this.processedWatchFiles = new Set(); }
  async scan(folder, options = {}) {
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Watch folder must be a real directory.');
    const current = new Map(), ready = [];
    for await (const candidate of discoverMedia([folder], options)) {
      if (!/\.mkv$/i.test(candidate.file)) continue;
      const info = await fs.stat(candidate.file);
      const key = fileKey(candidate.file);
      const stamp = `${info.size}:${info.mtimeMs}`;
      current.set(key, stamp);
      if (info.size > 0 && this.previous.get(key) === stamp && !this.processedWatchFiles.has(key)) ready.push(candidate.file);
    }
    this.previous = current;
    // Forget removed files after a successful scan; a failed scan keeps history.
    for (const key of this.processedWatchFiles) {
      if (!this.previous.has(key)) this.processedWatchFiles.delete(key);
    }
    return ready;
  }
  // Mark only files that actually reached the queue, not failed inspections.
  mark(files) { for (const file of files) this.processedWatchFiles.add(fileKey(file)); }
}
module.exports = { WatchFolder };