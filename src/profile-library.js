const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateSettings } = require('./profiles');
const { loadSettings } = require('./settings');
const emptyLibrary = () => ({ version: 2, activeId: null, profiles: [] });
function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Use a profile name of 1–100 characters.');
  return name.trim();
}
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
async function saveLibrary(directory, library) {
  const validated = validateLibrary(library);
  await fs.mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.library-${crypto.randomUUID()}.tmp`);
  try {
    // Preserve the last valid library as a recovery file before replacement.
    const target = path.join(directory, 'playback-profiles.json');
    try { validateLibrary(JSON.parse(await fs.readFile(target, 'utf8'))); await fs.copyFile(target, `${target}.backup`); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Existing profile library is unreadable. Back it up and move it aside before saving.'); }
    await fs.writeFile(temp, JSON.stringify(validated, null, 2), { mode: 0o600 });
    await fs.rename(temp, target);
  } finally { await fs.unlink(temp).catch(() => {}); }
  return validated;
}
async function loadLibrary(directory) {
  try { return { library: validateLibrary(JSON.parse(await fs.readFile(path.join(directory, 'playback-profiles.json'), 'utf8'))), warning: '' }; }
  catch (error) {
    if (error.code !== 'ENOENT') return { library: emptyLibrary(), warning: 'Profile library could not be read. It has not been overwritten; restore the .backup file or move the damaged file aside before saving.' };
  }
  const legacy = await loadSettings(directory);
  if (!legacy.settings) return { library: emptyLibrary(), warning: legacy.warning };
  const library = mutateLibrary(emptyLibrary(), { type: 'save', name: 'My playback setup', settings: legacy.settings });
  await saveLibrary(directory, library);
  return { library, warning: '' };
}
module.exports = { emptyLibrary, validateLibrary, validateName, mutateLibrary, loadLibrary, saveLibrary };