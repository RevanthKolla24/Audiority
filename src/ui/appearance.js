/*
 * ui/appearance.js
 * Renderer-side theme editor using the DOM and preload bridge, not direct filesystem access. Guide: palette application; preview/contrast; editor; asynchronous persistence; events.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
let appearanceData, themeEditingId = null, themePending = false;
let iconFrame = null, paintedIconColors = '';
// Canvas stays off-screen. Batch rapid color-picker previews into one paint per frame.
function scheduleThemeIcon(theme) {
  if (iconFrame !== null) cancelAnimationFrame(iconFrame);
  iconFrame = requestAnimationFrame(() => {
    iconFrame = null;
    const background = theme.colors.accent, foreground = theme.colors.accentText;
    const key = `${background}:${foreground}`;
    if (key === paintedIconColors) return;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = background;
    context.beginPath(); context.roundRect(8, 8, 240, 240, 56); context.fill();
    context.font = 'bold italic 190px Georgia, "Times New Roman", serif';
    context.fillStyle = foreground; context.textAlign = 'left'; context.textBaseline = 'alphabetic';
    const metrics = context.measureText('a');
    // Center the visible ink, rather than the font's invisible advance/baseline box.
    const x = 128 + (metrics.actualBoundingBoxLeft - metrics.actualBoundingBoxRight) / 2;
    const y = 128 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
    context.fillText('a', x, y);
    api.updateThemeIcon(canvas.toDataURL('image/png')).then(() => { paintedIconColors = key; }).catch(error => {
      $('theme-error').textContent = `Theme applied, but the app icon could not update: ${error.message}`;
    });
  });
}
const allThemes = () => [...appearanceData.builtins, ...appearanceData.state.custom];
const activeTheme = () => allThemes().find(t => t.id === appearanceData.state.activeId);
// Apply theme: receives theme. Updates state or visible controls; callers use the side effect.
function applyTheme(theme) {
  for (const [name, color] of Object.entries(theme.colors)) document.documentElement.style.setProperty(`--theme-${name}`, color);
  document.documentElement.style.colorScheme = theme.mode;
  document.documentElement.dataset.theme = theme.id || 'preview';
  scheduleThemeIcon(theme);
}
// Refresh themes: receives no explicit arguments (uses current state). Updates state or visible controls; callers use the side effect.
function refreshThemes() {
  $('theme-select').replaceChildren();
  for (const theme of allThemes()) { const option = element('option', '', theme.name); option.value = theme.id; $('theme-select').append(option); }
  $('theme-select').value = appearanceData.state.activeId;
  const custom = appearanceData.state.custom.some(t => t.id === appearanceData.state.activeId);
  $('theme-edit').disabled = !custom; $('theme-delete').disabled = !custom;
  applyTheme(activeTheme());
  if (typeof renderPresetThemes === 'function') renderPresetThemes();
}
// Theme draft: receives no explicit arguments (uses current state). Returns the calculated value for the caller.
function themeDraft() {
  return { version: 1, name: $('theme-name').value, mode: $('theme-mode').value, colors: Object.fromEntries([...$('theme-colors').querySelectorAll('input')].map(input => [input.dataset.token, input.value])) };
}
// Contrast ratio: receives a,b. Returns the calculated value for the caller.
function contrastRatio(a,b) {
  const lum = hex => {
    const rgb = hex.slice(1).match(/../g).map(v => parseInt(v,16)/255).map(v => v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4);
    return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
  };
  const x = lum(a), y = lum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);
}
// Preview theme: receives no explicit arguments (uses current state). See the return statements below for the result; async results are Promises.
function previewTheme() {
  const theme = themeDraft(); applyTheme(theme);
  const pairs = [['text','background'],['text','surface'],['text','sidebar'],['muted','background'],['muted','surface'],['accentText','accent'],['warning','warningBackground'],['danger','dangerBackground']];
  const low = pairs.filter(([a,b]) => contrastRatio(theme.colors[a],theme.colors[b]) < 4.5).map(([a,b]) => `${a} on ${b}`);
  $('theme-contrast').textContent = low.length ? `Low contrast: ${low.join(', ')}. Aim for at least 4.5:1 for readable text.` : 'Text contrast checks passed (4.5:1).';
}
// Edit theme: receives existing. See the return statements below for the result; async results are Promises.
function editTheme(existing) {
  themeEditingId = existing ? activeTheme().id : null;
  const theme = activeTheme();
  $('theme-form').hidden = false; $('theme-name').value = existing ? theme.name : `${theme.name.slice(0,70)} copy`;
  $('theme-mode').value = theme.mode; $('theme-colors').replaceChildren();
  for (const token of appearanceData.tokenNames) {
    const label = element('label', '', token.replace(/([A-Z])/g, ' $1'));
    const input = element('input'); input.type = 'color'; input.value = theme.colors[token]; input.dataset.token = token; label.append(input); $('theme-colors').append(label);
  }
  previewTheme();
}
// Discard theme: receives no explicit arguments (uses current state). See the return statements below for the result; async results are Promises.
function discardTheme() { $('theme-form').hidden = true; if (appearanceData) applyTheme(activeTheme()); }
// Change theme: receives action. See the return statements below for the result; async results are Promises.
async function changeTheme(action) {
  if (themePending) return;
  themePending = true; $('theme-error').textContent = '';
  const controls = [...$('appearance-panel').querySelectorAll('button,input,select')];
  controls.forEach(control => { control.disabled = true; });
  try { appearanceData = await api.themeOperation(action); discardTheme(); refreshThemes(); }
  catch (error) { $('theme-error').textContent = error.message; }
  finally { themePending = false; controls.forEach(control => { control.disabled = false; }); if (appearanceData) { const custom = appearanceData.state.custom.some(t => t.id === appearanceData.state.activeId); $('theme-edit').disabled = !custom; $('theme-delete').disabled = !custom; } }
}
$('theme-select').addEventListener('change', () => changeTheme({ type: 'select', id: $('theme-select').value }));
$('theme-create').addEventListener('click', () => editTheme(false));
$('theme-edit').addEventListener('click', () => editTheme(true));
$('theme-delete').addEventListener('click', () => { if (window.confirm(`Delete custom theme “${activeTheme().name}”?`)) changeTheme({ type: 'delete', id: activeTheme().id }); });
$('theme-import').addEventListener('click', () => changeTheme({ type: 'import' }));
$('theme-export').addEventListener('click', () => changeTheme({ type: 'export', id: activeTheme().id }));
$('theme-reset').addEventListener('click', () => changeTheme({ type: 'select', id: 'warm-light' }));
$('theme-discard').addEventListener('click', discardTheme);
$('theme-form').addEventListener('input', previewTheme);
$('theme-form').addEventListener('submit', event => { event.preventDefault(); changeTheme({ type: 'save', id: themeEditingId, theme: themeDraft() }); });
safe(async () => { appearanceData = await api.getAppearance(); refreshThemes(); if (appearanceData.warning) $('theme-error').textContent = appearanceData.warning; });