/*
 * settings.js
 * Legacy single-profile storage used during migration. Guide: validated loading with warnings; temporary-file save and replacement.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
// randomUUID supplies unique temporary filenames, avoiding clashes between saves.
const { validateSettings } = require('./profiles');
// Load settings: receives directory. Returns loaded state plus recovery/default information.
async function loadSettings(directory) {
  try { return { settings: validateSettings(JSON.parse(await fs.readFile(path.join(directory, 'playback-profile.json'), 'utf8'))), warning: '' }; }
  catch (error) { return { settings: null, warning: error.code === 'ENOENT' ? '' : 'Saved playback settings could not be read; please complete setup again.' }; }
}
// Save settings: receives directory, value. Completes after validated data has been written; failures reject the Promise.
async function saveSettings(directory, value) {
  const settings = validateSettings(value);
  await fs.mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.profile-${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temp, JSON.stringify(settings, null, 2), { mode: 0o600 }); await fs.rename(temp, path.join(directory, 'playback-profile.json')); }
  finally { await fs.unlink(temp).catch(() => {}); }
  return settings;
}
module.exports = { loadSettings, saveSettings };