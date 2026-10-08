/*
 * profile-library.js
 * Manages named profiles for main.js. Guide: name/ID validation; edit/switch/delete actions; atomic saving; backup recovery and legacy migration.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const fs = require('node:fs/promises');
// Write a complete temporary JSON file before renaming it, so interrupted writes do not truncate live settings.
const path = require('node:path');
const crypto = require('node:crypto');
const { validateSettings } = require('./profiles');
const { loadSettings } = require('./settings');
const emptyLibrary = () => ({ version: 2, activeId: null, profiles: [] });
// Validate name: receives name. Returns checked data or throws; do not trust saved/input JSON blindly.
function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Use a profile name of 1–100 characters.');
  return name.trim();
}
// Validate library: receives value. Returns checked data or throws; do not trust saved/input JSON blindly.
function validateLibrary(value) {
  if (!value || value.version !== 2 || !Array.isArray(value.profiles)) throw new Error('Invalid profile library.');
  const ids = new Set();
  const profiles = value.profiles.map(p => {
    if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(p.id) || ids.has(p.id)) throw new Error('Invalid profile ID.');
    ids.add(p.id);
    return { id: p.id, name: validateName(p.name), settings: validateSettings(p.settings) };
  });
  if ((value.activeId !== null && !ids.has(value.activeId)) || (profiles.length && value.activeId === null)) throw new Error('Invalid active profile.');
  return { version: 2, activeId: value.activeId, profiles };
}
// Mutate library: receives library, action. See the return statements below for the result; async results are Promises.
function mutateLibrary(library, action) {
  const next = structuredClone(validateLibrary(library));
  const find = id => { const p = next.profiles.find(p => p.id === id); if (!p) throw new Error('Profile not found.'); return p; };
  if (action.type === 'save') {
    const p = { id: action.id || crypto.randomUUID(), name: validateName(action.name), settings: validateSettings(action.settings) };
    if (action.id) Object.assign(find(action.id), p); else next.profiles.push(p);
    next.activeId = p.id;
  } else if (action.type === 'switch') { find(action.id); next.activeId = action.id; }
  else if (action.type === 'rename') find(action.id).name = validateName(action.name);
  else if (action.type === 'duplicate') {
    const p = { ...structuredClone(find(action.id)), id: crypto.randomUUID() };
    p.name = validateName(action.name || `${p.name.slice(0, 90)} copy`);
    next.profiles.push(p); next.activeId = p.id;
  } else if (action.type === 'delete') {
    find(action.id); next.profiles = next.profiles.filter(p => p.id !== action.id);
    if (next.activeId === action.id) next.activeId = next.profiles[0]?.id || null;
  } else throw new Error('Unknown profile operation.');
  return validateLibrary(next);
}
// Save library: receives directory, library. Completes after validated data has been written; failures reject the Promise.
async function saveLibrary(directory, library) {
  const validated = validateLibrary(library);
  await fs.mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.library-${crypto.randomUUID()}.tmp`);
  try {
    // Preserve the last valid library as a recovery file before replacement.
    const target = path.join(directory, 'playback-profiles.json');
    let previous;
    try { previous = await fs.readFile(target, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Existing profile library is unreadable.', { cause: error });
    }
    if (previous !== undefined) {
      let validPrevious = false;
      try { validateLibrary(JSON.parse(previous)); validPrevious = true; }
      catch { /* Corrupt data must not block saving or replace a good backup. */ }
      if (validPrevious) {
        try { await fs.writeFile(`${target}.backup`, previous, { mode: 0o600 }); }
        catch (error) { throw new Error('Profile library backup failed with OS error.', { cause: error }); }
      }
    }
    await fs.writeFile(temp, JSON.stringify(validated, null, 2), { mode: 0o600 });
    await fs.rename(temp, target);
  } finally { await fs.unlink(temp).catch(() => {}); }
  return validated;
}
// Load library: receives directory. Returns loaded state plus recovery/default information.
async function loadLibrary(directory) {
  try { return { library: validateLibrary(JSON.parse(await fs.readFile(path.join(directory, 'playback-profiles.json'), 'utf8'))), warning: '' }; }
  catch (error) {
    if (error.code !== 'ENOENT') return { library: emptyLibrary(), warning: 'Profile library could not be read. It has not been overwritten; restore the .backup file to recover profiles. Saving a new valid library can replace damaged data.' };
  }
  const legacy = await loadSettings(directory);
  if (!legacy.settings) return { library: emptyLibrary(), warning: legacy.warning };
  const library = mutateLibrary(emptyLibrary(), { type: 'save', name: 'My playback setup', settings: legacy.settings });
  try {
    await saveLibrary(directory, library);
    return { library, warning: '' };
  } catch (error) {
    return { library, warning: `Legacy settings migrated, but could not be saved to disk: ${error.message}` };
  }
}
module.exports = { emptyLibrary, validateLibrary, validateName, mutateLibrary, loadLibrary, saveLibrary };