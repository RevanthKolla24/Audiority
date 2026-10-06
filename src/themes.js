/*
 * themes.js
 * Background palettes and safe custom-theme validation used by main.js. Guide: tokens/presets; validation; mutations; persistence; readability contrast. Imports are colors, not executable CSS.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const tokenNames = ['background', 'surface', 'sidebar', 'text', 'muted', 'accent', 'accentText', 'border', 'hover', 'warning', 'warningBackground', 'danger', 'dangerBackground'];
const palette = values => Object.fromEntries(tokenNames.map((name, i) => [name, values[i]]));
const builtins = [
  { id: 'warm-light', name: 'Warm Light', mode: 'light', colors: palette(['#f6f6f4','#ffffff','#edede8','#24272b','#727671','#365f52','#ffffff','#deded8','#edf0e9','#916630','#faf5e9','#a44537','#faeae4']) },
  { id: 'graphite', name: 'Graphite Dark', mode: 'dark', colors: palette(['#191c1e','#232729','#151819','#ecefeb','#a6afa7','#99c6b2','#152b20','#424947','#303a35','#e8bf7e','#392e20','#ffb1a5','#402722']) },
  { id: 'midnight', name: 'Midnight', mode: 'dark', colors: palette(['#151c2b','#202b3e','#101724','#e9eef8','#a4b5cf','#9dbcf0','#152039','#3d4f6b','#2c3c56','#edc389','#3d3123','#ffb3b3','#412b35']) },
  { id: 'high-contrast', name: 'High Contrast', mode: 'dark', colors: palette(['#000000','#101010','#000000','#ffffff','#dddddd','#ffff66','#000000','#999999','#303030','#ffdd88','#221800','#ffbbaa','#221000']) }
];
const extras = [
  ['paper', 'Paper', 'light', '#f4f6f8', '#ffffff', '#e8edf1', '#24313a', '#53616c', '#31546b'],
  ['sandstone', 'Sandstone', 'light', '#f8f3eb', '#fffaf4', '#eee5d8', '#352d25', '#685a4d', '#765238'],
  ['ocean-light', 'Ocean Light', 'light', '#edf5fa', '#ffffff', '#deedf5', '#183344', '#486475', '#205a78'],
  ['rose-light', 'Rose Light', 'light', '#faf2f4', '#ffffff', '#f0e3e7', '#3b2830', '#725761', '#82445a'],
  ['oled-black', 'OLED Black', 'dark', '#000000', '#101010', '#060606', '#f1f1f1', '#b0b0b0', '#b6c9df'],
  ['forest-dark', 'Forest Dark', 'dark', '#121e19', '#1c2c23', '#101b15', '#e5f0e8', '#acbfb0', '#a1d4af'],
  ['slate', 'Slate', 'dark', '#20252c', '#2a323c', '#191e25', '#edf1f7', '#b2bfce', '#aac9ed'],
  ['plum-dark', 'Plum Dark', 'dark', '#251d2b', '#32273a', '#1d1723', '#f3eafa', '#c1adc9', '#dbb2ed']
];
builtins[0].colors.muted = '#62665f';
for (const [id, name, mode, background, surface, sidebar, text, muted, accent] of extras) {
  const base = builtins.find(t => t.id === (mode === 'light' ? 'warm-light' : 'graphite'));
  builtins.push({ id, name, mode, colors: { ...base.colors, background, surface, sidebar, text, muted, accent, accentText: mode === 'light' ? '#ffffff' : '#182019', border: mode === 'light' ? '#c4c7ca' : '#52605d', hover: sidebar } });
}
// Validate theme: receives value. Returns checked data or throws; do not trust saved/input JSON blindly.
function validateTheme(value) {
  if (!value || value.version !== 1 || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80 || !['light','dark'].includes(value.mode)) throw new Error('Invalid theme: use version 1, a name (1–80 characters), and light/dark mode.');
  const colors = {};
  for (const key of tokenNames) {
    if (typeof value.colors?.[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.colors[key])) throw new Error(`Invalid theme color: ${key}. Use #RRGGBB colors only.`);
    colors[key] = value.colors[key].toLowerCase();
  }
  return { version: 1, name: value.name.trim(), mode: value.mode, colors };
}
const defaults = () => ({ version: 1, activeId: 'warm-light', custom: [] });
// Validate state: receives value. Returns checked data or throws; do not trust saved/input JSON blindly.
function validateState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.custom)) throw new Error('Invalid appearance settings.');
  const ids = new Set(builtins.map(t => t.id));
  const custom = value.custom.map(t => {
    if (typeof t.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(t.id) || ids.has(t.id)) throw new Error('Invalid theme ID.');
    ids.add(t.id); return { ...validateTheme(t), id: t.id };
  });
  if (!ids.has(value.activeId)) throw new Error('Active theme not found.');
  return { version: 1, activeId: value.activeId, custom };
}
// Mutate themes: receives state, action. See the return statements below for the result; async results are Promises.
function mutateThemes(state, action) {
  const next = structuredClone(validateState(state));
  if (action.type === 'select') next.activeId = action.id;
  else if (action.type === 'save') {
    const theme = { ...validateTheme(action.theme), id: action.id || crypto.randomUUID() };
    if (action.id) {
      const i = next.custom.findIndex(t => t.id === action.id);
      if (i < 0) throw new Error('Only custom themes can be edited.');
      next.custom[i] = theme;
    } else next.custom.push(theme);
    next.activeId = theme.id;
  } else if (action.type === 'delete') {
    if (!next.custom.some(t => t.id === action.id)) throw new Error('Only custom themes can be deleted.');
    next.custom = next.custom.filter(t => t.id !== action.id);
    if (next.activeId === action.id) next.activeId = 'warm-light';
  } else throw new Error('Unknown theme operation.');
  return validateState(next);
}
// Load themes: receives directory. Returns loaded state plus recovery/default information.
async function loadThemes(directory) {
  try { return { state: validateState(JSON.parse(await fs.readFile(path.join(directory, 'appearance.json'), 'utf8'))), warning: '' }; }
  catch (error) { return { state: defaults(), warning: error.code === 'ENOENT' ? '' : 'Appearance settings could not be read. Using Warm Light; the damaged file will not be overwritten.' }; }
}
// Save themes: receives directory, state. Completes after validated data has been written; failures reject the Promise.
async function saveThemes(directory, state) {
  const next = validateState(state);
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, 'appearance.json');
  try { validateState(JSON.parse(await fs.readFile(target, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Appearance settings are unreadable. Move appearance.json aside before saving.'); }
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); await fs.rename(temp, target); }
  finally { await fs.unlink(temp).catch(() => {}); }
  return next;
}
// Contrast: receives a, b. Returns the calculated value for the caller.
function contrast(a, b) {
  const luminance = hex => {
    const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const x = luminance(a), y = luminance(b); return (Math.max(x,y) + 0.05) / (Math.min(x,y) + 0.05);
}
module.exports = { builtins, tokenNames, defaults, validateTheme, validateState, mutateThemes, loadThemes, saveThemes, contrast };