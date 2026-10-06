/*
 * app-state.js
 * Stores validated preferences, local statistics and restartable queue records. Main.js calls these background helpers. Guide: defaults; validators; job counting; safe writes; ordered inspection; recovery.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const fs = require('node:fs/promises');
// JSON is data, not trusted instructions: validate loaded objects before using paths or counters.
// Promise-based filesystem calls allow the UI/process event loop to keep handling other work.
const path = require('node:path');
const crypto = require('node:crypto');

const preferencesDefaults = () => ({ version: 1, watchFolder: "", watchEnabled: false, trashOriginals: false, allowedLanguages: [], keepDefaultTrack: true, keepOriginal: false, normalizeVolume: false, clearCompletedOnRestart: false, rememberOutput: true, outputDirectory: '', preserveFolders: true, outputSuffix: '.audiority', threads: 0, inspectionConcurrency: 2, preventSleep: true, compact: false, reducedMotion: false, statsEnabled: true, storeFilenames: false });
// Validate preferences: receives value. Returns checked data or throws; do not trust saved/input JSON blindly.
function validatePreferences(value) {
  if (!value || value.version !== 1) throw new Error('Invalid application settings.');
  const result = { clearCompletedOnRestart: false, ...preferencesDefaults(), ...value };
  result.watchFolder = value.watchFolder ?? '';
  result.watchEnabled = value.watchEnabled ?? false;
  if (typeof result.watchEnabled !== 'boolean') throw new Error('Invalid watchEnabled.');
  if (typeof result.watchFolder !== 'string' || result.watchFolder.length > 4096 || (result.watchFolder && !path.isAbsolute(result.watchFolder))) throw new Error('Invalid watch folder.');
  if (result.watchEnabled && !result.watchFolder) throw new Error('Choose a watch folder before enabling automation.');
  result.allowedLanguages = require('./profiles').validateLanguages(value.allowedLanguages ?? []);
  result.keepDefaultTrack = value.keepDefaultTrack ?? true;
  if (typeof result.keepDefaultTrack !== 'boolean') throw new Error('Invalid keepDefaultTrack.');
  result.normalizeVolume = value.normalizeVolume ?? false;
  result.keepOriginal = value.keepOriginal ?? false;
  if (typeof result.keepOriginal !== 'boolean') throw new Error('Invalid keepOriginal.');
  if (typeof result.normalizeVolume !== 'boolean') throw new Error('Invalid normalizeVolume.');
  if (typeof result.clearCompletedOnRestart !== 'boolean') throw new Error('Invalid queue preference.');
  for (const key of ['trashOriginals', 'rememberOutput', 'preserveFolders', 'preventSleep', 'compact', 'reducedMotion', 'statsEnabled', 'storeFilenames']) if (typeof result[key] !== 'boolean') throw new Error(`Invalid ${key}.`);
  if (typeof result.outputDirectory !== 'string' || result.outputDirectory.length > 4096 || (result.outputDirectory && !path.isAbsolute(result.outputDirectory))) throw new Error('Invalid output folder.');
  if (typeof result.outputSuffix !== 'string' || !/^\.[a-zA-Z0-9_-]{1,32}$/.test(result.outputSuffix)) throw new Error('Output suffix must start with a dot and contain 1–32 letters, digits, hyphens or underscores.');
  if (!Number.isInteger(result.threads) || result.threads < 0 || result.threads > 16) throw new Error('Invalid encoder thread limit.');
  if (![1, 2, 3, 4].includes(result.inspectionConcurrency)) throw new Error('Invalid inspection concurrency.');
  if (!result.rememberOutput) result.outputDirectory = '';
  return Object.fromEntries([...Object.keys(preferencesDefaults()), 'clearCompletedOnRestart', 'normalizeVolume', 'keepOriginal', 'allowedLanguages', 'keepDefaultTrack'].map(key => [key, result[key]]));
}
const counters = () => ({ completed: 0, failed: 0, cancelled: 0, sourceBytes: 0, outputBytes: 0, processingSeconds: 0, mediaSeconds: 0, encoded: 0, extracted: 0, downmixed: 0, copied: 0 });
const statsDefaults = () => ({ version: 1, since: new Date().toISOString(), totals: counters(), codecs: {}, downmixes: {}, profiles: {}, days: {}, recent: [] });
// Validate stats: receives value. Returns checked data or throws; do not trust saved/input JSON blindly.
function validateStats(value) {
  if (!value || value.version !== 1 || !Number.isFinite(Date.parse(value.since)) || !Array.isArray(value.recent) || value.recent.length > 200) throw new Error('Invalid statistics.');
  const validCounters = record => record && Object.keys(counters()).every(k => Number.isFinite(record[k]) && record[k] >= 0);
  if (!validCounters(value.totals)) throw new Error('Invalid statistics totals.');
  for (const key of ['codecs', 'downmixes']) {
    if (!value[key] || Array.isArray(value[key]) || typeof value[key] !== 'object' || Object.values(value[key]).some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid statistics breakdown.');
  }
  for (const key of ['profiles', 'days']) {
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]) || Object.values(value[key]).some(n => !validCounters(n))) throw new Error('Invalid statistics breakdown.');
  }
  if (Object.keys(value.days).length > 366 || Object.keys(value.profiles).length > 1000) throw new Error('Statistics history exceeds its limit.');
  for (const job of value.recent) {
    if (!job || typeof job.id !== 'string' || !Number.isFinite(Date.parse(job.at)) || !['completed', 'failed', 'cancelled'].includes(job.status) || !validCounters(job.counts) || typeof job.profile !== 'string' || (job.filename !== undefined && typeof job.filename !== 'string')) throw new Error('Invalid recent job.');
  }
  return structuredClone(value);
}
// Record job: receives state, { status, item, outputBytes = 0, seconds = 0, profile = '', storeFilenames = false, at = new Date(. See the return statements below for the result; async results are Promises.
function recordJob(state, { status, item, outputBytes = 0, seconds = 0, profile = '', storeFilenames = false, at = new Date().toISOString(), id = crypto.randomUUID() }) {
  if (!['completed', 'failed', 'cancelled'].includes(status)) throw new Error('Invalid job status.');
  const next = validateStats(state);
  if (next.recent.some(job => job.id === id)) return next;
  const counts = counters(); counts[status] = 1; counts.processingSeconds = Math.max(0, seconds);
  if (status === 'completed') {
    counts.sourceBytes = item.size; counts.outputBytes = outputBytes; counts.mediaSeconds = item.duration;
    for (const track of item.plan.tracks) {
      counts[track.action === 'encode' ? 'encoded' : track.action === 'extract' ? 'extracted' : 'copied']++;
      if (track.downmix) counts.downmixed++;
      if (track.action !== 'copy') {
        const key = `${track.sourceCodec} → ${track.codec === 'dca' ? 'dts' : track.codec}`;
        next.codecs[key] = (next.codecs[key] || 0) + 1;
      }
      if (track.downmix) { const key = `${track.sourceLayout} → ${track.layout}`; next.downmixes[key] = (next.downmixes[key] || 0) + 1; }
    }
  }
  const day = at.slice(0, 10);
  // Profile names are intentionally retained; media paths never are.
  const profileKey = profile || 'Unnamed profile';
  if (!Object.hasOwn(next.profiles, profileKey) && Object.keys(next.profiles).length >= 999) profile = 'Other profiles';
  const key = profile || profileKey;
  if (!Object.hasOwn(next.days, day)) Object.defineProperty(next.days, day, { value: counters(), enumerable: true, writable: true, configurable: true });
  if (!Object.hasOwn(next.profiles, key)) Object.defineProperty(next.profiles, key, { value: counters(), enumerable: true, writable: true, configurable: true });
  for (const target of [next.totals, next.days[day], next.profiles[key]]) for (const field of Object.keys(counts)) target[field] += counts[field];
  for (const old of Object.keys(next.days).sort().slice(0, Math.max(0, Object.keys(next.days).length - 366))) delete next.days[old];
  next.recent.unshift({ id, at, status, profile: key, counts, ...(storeFilenames ? { filename: item.name } : {}) });
  next.recent = next.recent.slice(0, 200);
  return validateStats(next);
}
// Load state: receives directory, name, defaults, validate. Returns loaded state plus recovery/default information.
async function loadState(directory, name, defaults, validate) {
  try { return { state: validate(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))), warning: '' }; }
  catch (error) { return { state: defaults(), warning: error.code === 'ENOENT' ? '' : `${name} could not be read. Defaults are shown; the damaged file will not be overwritten.` }; }
}
// Save state: receives directory, name, state, validate, { reset = false } = {}. Completes after validated data has been written; failures reject the Promise.
async function saveState(directory, name, state, validate, { reset = false } = {}) {
  const next = validate(state); await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  try { const previous = await fs.readFile(target, 'utf8'); if (!reset) validate(JSON.parse(previous)); await fs.writeFile(`${target}.bak`, previous, { mode: 0o600 }); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot save ${name}: previous file unreadable or backup failed.`); }
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); await fs.rename(temp, target); }
  finally { await fs.unlink(temp).catch(() => {}); }
  return next;
}
// Bounded work, bounded ordering buffer. Discovery order survives concurrent probes.
// Accepts candidates and inspect/publish callbacks; limits parallel work while publishing in discovery order.
async function inspectInOrder(candidates, inspect, publish, concurrency = 2, signal) {
  const pending = [];
  const flush = async () => { const value = await pending.shift(); await publish(value); };
  try {
    for await (const candidate of candidates) {
      if (signal?.aborted) break;
      pending.push(Promise.resolve().then(() => inspect(candidate)).then(value => ({ candidate, value }), error => ({ candidate, error })));
      if (pending.length >= concurrency) await flush();
    }
  } finally { while (pending.length) await flush(); }
}
const queueDefaults = () => ({ version: 1, items: [] });
// Validate queue: receives value. Returns checked data or throws; do not trust saved/input JSON blindly.
function validateQueue(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.items)) throw new Error('Invalid saved queue.');
  const ids = new Set();
  const result = value.items.map(item => {
    if (!item || typeof item.id !== 'string' || ids.has(item.id) || !path.isAbsolute(item.file || '') ||
        !['Ready', 'Unchanged', 'Needs attention', 'Converting', 'Verifying', 'Complete', 'Error', 'Cancelled'].includes(item.status)) throw new Error('Invalid saved queue item.');
    ids.add(item.id);
    if (item.priority !== undefined && (!Number.isSafeInteger(item.priority) || item.priority < 0)) throw new Error('Invalid queue priority.');
    for (const key of ['output', 'temporaryOutput']) if (item[key] && !path.isAbsolute(item[key])) throw new Error('Invalid queue output path.');
    if (item.relativeDirectory && (path.isAbsolute(item.relativeDirectory) || item.relativeDirectory.split(/[\\/]/).includes('..'))) throw new Error('Invalid queue folder.');
    if (item.sidecars && (!Array.isArray(item.sidecars) || item.sidecars.some(s => !path.isAbsolute(s.file || '') || typeof s.suffix !== 'string' || /[\\/]/.test(s.suffix)))) throw new Error('Invalid queue subtitles.');
    return { id: item.id, file: item.file, status: item.status, ...(item.priority !== undefined ? { priority: item.priority } : {}), output: item.output || '', temporaryOutput: item.temporaryOutput || '', relativeDirectory: item.relativeDirectory || '', sidecars: item.sidecars || [], importWarnings: (item.importWarnings || []).filter(w => typeof w === 'string'), error: typeof item.error === 'string' ? item.error : '' };
  });
  return { version: 1, items: result };
}
// Load queue: receives directory, { clearCompletedOnRestart = false } = {}. Returns loaded state plus recovery/default information.
async function loadQueue(directory, { clearCompletedOnRestart = false } = {}) {
  const loaded = await loadState(directory, 'queue.json', queueDefaults, validateQueue);
  if (clearCompletedOnRestart) loaded.state.items = loaded.state.items.filter(item => item.status !== 'Complete');
  return loaded;
}
// Save queue: receives directory, itemsMap. Completes after validated data has been written; failures reject the Promise.
async function saveQueue(directory, itemsMap) {
  return saveState(directory, 'queue.json', { version: 1, items: [...itemsMap.values()] }, validateQueue);
}
// Accepts recovered jobs; removes only recorded validated partial files and returns cleanup warnings.
async function cleanupInterrupted(items) {
  const warnings = [];
  for (const item of items) {
    if (!['Converting', 'Verifying'].includes(item.status) || !item.temporaryOutput) continue;
    const temp = item.temporaryOutput;
    // Delete only the exact recorded application partial, never a directory or symlink.
    if (!/^\..+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial\.mkv$/i.test(path.basename(temp)) || temp === item.file || temp === item.output) continue;
    try { const stat = await fs.lstat(temp); if (stat.isFile() && !stat.isSymbolicLink()) await fs.unlink(temp); }
    catch (error) { if (error.code !== 'ENOENT') warnings.push(`Could not remove interrupted output: ${error.message}`); }
  }
  return warnings;
}
module.exports = { preferencesDefaults, validatePreferences, statsDefaults, validateStats, recordJob, loadState, saveState, inspectInOrder, loadQueue, saveQueue, validateQueue, cleanupInterrupted };