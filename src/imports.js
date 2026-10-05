const fs = require('node:fs/promises');
const path = require('node:path');

const mediaExtensions = new Set('.mkv .mp4 .m4v .mov .avi .webm .ts .mts .m2ts .mpg .mpeg .vob .ogv .wmv .flv .mxf .flac .wav .wave .mp3 .aac .m4a .ogg .opus .aiff .aif .ac3 .eac3 .dts .mka .wma .ape .alac'.split(' '));
const subtitleExtensions = new Set(['.ass', '.ssa', '.srt']);
const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
function isInside(parent, file) {
  const relative = path.relative(parent, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
function outputRelativeDirectory(root, directory) {
  const result = path.join(path.basename(root), path.relative(root, directory));
  if (path.isAbsolute(result) || result.split(path.sep).some(p => p === '..')) throw new Error('Unsafe relative folder.');
  return result;
}
function matchSidecars(file, entries, index = null) {
  const stem = path.parse(file).name;
  if (index) return index.get(stem) || { sidecars: [], warnings: [] };
  const mediaStems = entries.filter(e => e.isFile() && mediaExtensions.has(path.extname(e.name).toLowerCase())).map(e => path.parse(e.name).name);
  const sidecars = [], warnings = [];
  for (const entry of entries) {
    if (!entry.isFile() || !subtitleExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const base = path.parse(entry.name).name;
    const candidates = mediaStems.filter(s => base === s || base.startsWith(`${s}.`));
    if (!candidates.includes(stem)) continue;
    if (candidates.length !== 1 || mediaStems.filter(s => s === stem).length !== 1) { warnings.push(`Ambiguous subtitle not copied: ${entry.name}`); continue; }
    sidecars.push({ file: path.join(path.dirname(file), entry.name), suffix: entry.name.slice(stem.length) });
  }
  if (entries.some(e => (e.isDirectory() && /^(fonts?|attachments)$/i.test(e.name)) || (e.isFile() && /\.(ttf|otf|ttc)$/i.test(e.name)))) warnings.push('External fonts found. They are not auto-attached or copied; ASS playback may need those fonts installed.');
  return { sidecars, warnings };
}
function indexSidecars(directory, entries) {
  const stems = new Map();
  const fonts = entries.some(e => (e.isDirectory() && /^(fonts?|attachments)$/i.test(e.name)) || (e.isFile() && /\.(ttf|otf|ttc)$/i.test(e.name)));
  for (const entry of entries) if (entry.isFile() && mediaExtensions.has(path.extname(entry.name).toLowerCase())) {
    const stem = path.parse(entry.name).name;
    const existing = stems.get(stem);
    if (existing) existing.count++;
    else stems.set(stem, { count: 1, sidecars: [], warnings: fonts ? ['External fonts found. They are not auto-attached or copied; ASS playback may need those fonts installed.'] : [] });
  }
  for (const entry of entries) {
    if (!entry.isFile() || !subtitleExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const base = path.parse(entry.name).name; const candidates = [];
    if (stems.has(base)) candidates.push(base);
    for (let i = base.indexOf('.'); i !== -1; i = base.indexOf('.', i + 1)) if (stems.has(base.slice(0, i))) candidates.push(base.slice(0, i));
    for (const stem of candidates) {
      const record = stems.get(stem);
      if (candidates.length !== 1 || record.count !== 1) record.warnings.push(`Ambiguous subtitle not copied: ${entry.name}`);
      else record.sidecars.push({ file: path.join(directory, entry.name), suffix: entry.name.slice(stem.length) });
    }
  }
  return stems;
}
async function* discoverMedia(paths, { outputDirectory = '', outputSuffix = '.audiority', signal, onProgress = () => {}, onWarning = () => {} } = {}) {
  const seen = new Set();
  let visited = 0, found = 0, skipped = 0;
  const progress = () => onProgress({ visited, found, skipped });
  const cancelled = () => { if (signal?.aborted) throw new Error('Cancelled'); };
  const escapedSuffix = outputSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const outputPattern = new RegExp(`${escapedSuffix}(?: \\(\\d+\\))?\\.mkv$`, 'i');
  const generated = file => outputPattern.test(file) || /\.audiority(?: \(\d+\))?\.mkv$/i.test(file) || /\.partial\.mkv$/i.test(file);
  async function* visit(file, root, explicit = false, siblings = null, sidecarIndex = null) {
    cancelled(); visited++; progress();
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) { skipped++; onWarning(`Cannot read ${file}: ${error.message}`); return; }
    if (stat.isSymbolicLink()) { skipped++; onWarning(`Skipped symbolic link: ${file}`); return; }
    const real = await fs.realpath(file).catch(() => file);
    if (seen.has(key(real))) { skipped++; return; }
    seen.add(key(real));
    if (generated(file)) { skipped++; return; }
    if (stat.isDirectory()) {
      let entries;
      try { entries = await fs.readdir(file, { withFileTypes: true }); }
      catch (error) { skipped++; onWarning(`Cannot scan ${file}: ${error.message}`); return; }
      entries.sort((a,b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const importRoot = root || file;
      const companions = indexSidecars(file, entries);
      for (const entry of entries) {
        cancelled();
        if (entry.name.startsWith('.')) { skipped++; continue; }
        const child = path.join(file, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink()) yield* visit(child, importRoot);
        else if (entry.isFile() && mediaExtensions.has(path.extname(entry.name).toLowerCase())) {
          yield* visit(child, importRoot, false, entries, companions);
        } else skipped++;
      }
      progress();
    } else if (stat.isFile() && (explicit || mediaExtensions.has(path.extname(file).toLowerCase()))) {
      let companions = { sidecars: [], warnings: [] };
      try { companions = matchSidecars(file, siblings || await fs.readdir(path.dirname(file), { withFileTypes: true }), sidecarIndex); }
      catch (error) { companions.warnings.push(`Cannot inspect sidecar subtitles: ${error.message}`); }
      found++; progress();
      yield { file: real, relativeDirectory: root ? outputRelativeDirectory(root, path.dirname(file)) : '', ...companions };
    } else skipped++;
  }
  for (const file of paths) yield* visit(path.resolve(file), '', true);
  progress();
}
async function resolveOutputDirectory(base, relative = '') {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..')) throw new Error('Unsafe output folder path.');
  const root = await fs.realpath(base);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Output subfolders must be real directories, not symbolic links.');
    if (!isInside(root, await fs.realpath(current))) throw new Error('Output folder escapes destination.');
  }
  return current;
}
module.exports = { discoverMedia, matchSidecars, indexSidecars, resolveOutputDirectory, isInside, mediaExtensions };