const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const preferencesDefaults = () => ({ version: 1, rememberOutput: true, outputDirectory: '', preserveFolders: true, outputSuffix: '.audiority', threads: 0, inspectionConcurrency: 2, preventSleep: true, compact: false, reducedMotion: false, statsEnabled: true, storeFilenames: false });
function validatePreferences(value) {
  if (!value || value.version !== 1) throw new Error('Invalid application settings.');
  const result = { ...preferencesDefaults(), ...value };
  for (const key of ['rememberOutput', 'preserveFolders', 'preventSleep', 'compact', 'reducedMotion', 'statsEnabled', 'storeFilenames']) if (typeof result[key] !== 'boolean') throw new Error(`Invalid ${key}.`);
  if (typeof result.outputDirectory !== 'string' || result.outputDirectory.length > 4096 || (result.outputDirectory && !path.isAbsolute(result.outputDirectory))) throw new Error('Invalid output folder.');
  if (typeof result.outputSuffix !== 'string' || !/^\.[a-zA-Z0-9_-]{1,32}$/.test(result.outputSuffix)) throw new Error('Output suffix must start with a dot and contain 1–32 letters, digits, hyphens or underscores.');
  if (!Number.isInteger(result.threads) || result.threads < 0 || result.threads > 16) throw new Error('Invalid encoder thread limit.');
  if (![1, 2, 3, 4].includes(result.inspectionConcurrency)) throw new Error('Invalid inspection concurrency.');
  if (!result.rememberOutput) result.outputDirectory = '';
  return Object.fromEntries(Object.keys(preferencesDefaults()).map(key => [key, result[key]]));
}
const counters = () => ({ completed: 0, failed: 0, cancelled: 0, sourceBytes: 0, outputBytes: 0, processingSeconds: 0, mediaSeconds: 0, encoded: 0, extracted: 0, downmixed: 0, copied: 0 });
const statsDefaults = () => ({ version: 1, since: new Date().toISOString(), totals: counters(), codecs: {}, downmixes: {}, profiles: {}, days: {}, recent: [] });
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
async function loadState(directory, name, defaults, validate) {
  try { return { state: validate(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))), warning: '' }; }
  catch (error) { return { state: defaults(), warning: error.code === 'ENOENT' ? '' : `${name} could not be read. Defaults are shown; the damaged file will not be overwritten.` }; }
}
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
module.exports = { preferencesDefaults, validatePreferences, statsDefaults, validateStats, recordJob, loadState, saveState, inspectInOrder };