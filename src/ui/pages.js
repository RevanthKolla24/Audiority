/*
 * ui/pages.js
 * Renderer-side Settings and Statistics pages. Shares renderer helpers and asks the backend to save validated data. Guide: preferences; palette previews; page navigation; statistics; events.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
let currentPage = 'queue', preferencesData;
function renderUpdateState(state) {
  const labels = { disabled: 'Automatic updates are available in installed Windows/macOS builds, not development runs.', idle: 'Ready to check.', checking: 'Checking for updates…', current: 'You are up to date.', downloading: `Downloading ${state.version || 'update'} · ${Math.floor(state.percent || 0)}%`, ready: `Version ${state.version} is ready. Installation waits until work is idle.`, available: `Version ${state.version} is available for manual download on macOS.`, installing: 'Saving queue and starting installer…', error: `Update failed: ${state.error}. You can retry below.` };
  $('update-status').textContent = labels[state.status] || 'Update status unavailable.';
  $('update-check').disabled = ['disabled', 'checking', 'downloading', 'installing'].includes(state.status);
  $('update-check').textContent = state.status === 'error' ? 'Retry update check' : 'Check for updates';
  $('update-install').hidden = !['ready', 'available'].includes(state.status) && !state.canInstall;
  $('update-install').textContent = state.status === 'available' ? 'Open release page' : 'Install and restart';
}
$('update-check').addEventListener('click', () => safe(async () => renderUpdateState(await api.checkUpdates())));
$('update-install').addEventListener('click', () => safe(async () => renderUpdateState(await api.installUpdate())));
api.onUpdate(update => { if (update.type === 'app-update') renderUpdateState(update.state); });
safe(async () => renderUpdateState(await api.getUpdateState()));
const preferenceBooleans = ['trashOriginals', 'keepDefaultTrack', 'keepOriginal', 'normalizeVolume', 'dialogueBoost', 'clearCompletedOnRestart', 'rememberOutput', 'preserveFolders', 'preventSleep', 'compact', 'reducedMotion', 'statsEnabled', 'storeFilenames'];
// Apply preferences: receives value. Updates state or visible controls; callers use the side effect.
function applyPreferences(value) {
  document.documentElement.classList.toggle('compact', value.compact);
  document.documentElement.classList.toggle('reduced-motion', value.reducedMotion);
}
// Fill preferences: receives data. See the return statements below for the result; async results are Promises.
function fillPreferences(data) {
  preferencesData = data;
  $('pref-watchEnabled').checked = data.preferences.watchEnabled;
  $('settings-watch-folder').textContent = data.preferences.watchFolder || 'No watch folder selected';
  $('pref-allowedLanguages').value = (data.preferences.allowedLanguages || []).join(', ');
  for (const key of preferenceBooleans) $(`pref-${key}`).checked = data.preferences[key];
  for (const key of ['threads', 'inspectionConcurrency', 'outputSuffix']) $(`pref-${key}`).value = data.preferences[key];
  $('pref-performanceMode').value = data.preferences.performanceMode || 'balanced';
  $('settings-output').textContent = data.outputDirectory || 'No output folder selected';
  $('settings-result').textContent = data.warning || '';
  applyPreferences(data.preferences);
  $('trash-warning').hidden = !data.preferences.trashOriginals;
  output = data.outputDirectory || ''; syncOutputFolder();
  if (typeof setupData !== 'undefined' && setupData?.profile && typeof effectivePolicyText === 'function') {
    $('active-profile').textContent = api.platform === 'win32' ? profileText(setupData.profile) : `${profileText(setupData.profile)} · ${effectivePolicyText(setupData.profile)}`;
    $('profile-policy-detail').textContent = effectivePolicyText(setupData.profile);
  }
  renderPresetThemes();
}
// Render preset themes: receives no explicit arguments (uses current state). Updates state or visible controls; callers use the side effect.
function renderPresetThemes() {
  if (!appearanceData) return;
  const parent = $('theme-presets'); parent.replaceChildren();
  for (const mode of ['light', 'dark']) {
    parent.append(element('h3', '', mode === 'light' ? 'Light' : 'Dark & high contrast'));
    for (const theme of appearanceData.builtins.filter(t => t.mode === mode)) {
      const button = element('button', 'theme-preset'); button.type = 'button';
      button.setAttribute('aria-pressed', String(theme.id === appearanceData.state.activeId));
      const palette = element('span', 'palette');
      for (const token of ['background', 'surface', 'accent', 'text']) { const swatch = element('i'); swatch.style.backgroundColor = theme.colors[token]; palette.append(swatch); }
      button.append(palette, document.createTextNode(theme.name));
      button.addEventListener('click', () => safe(async () => { await changeTheme({ type: 'select', id: theme.id }); renderPresetThemes(); })); parent.append(button);
    }
  }
}
// Show page: receives page. Updates state or visible controls; callers use the side effect.
function showPage(page) {
  // Direct transitions (native menu commands and profile entry/exit) also
  // supersede pending requests, even if a profile draft subsequently closes.
  navigationVersion++;
  if (typeof profileEditing !== 'undefined' && profileEditing) {
    if (page === 'queue') return;
    throw new Error('Save or cancel your profile edits first.');
  }
  currentPage = page;
  $('settings-page').hidden = page !== 'settings'; $('statistics-page').hidden = page !== 'statistics';
  $('setup').hidden = page !== 'queue' || !!savedSettings;
  $('workspace').hidden = page !== 'queue' || !savedSettings;
  for (const name of ['queue', 'settings', 'statistics']) { if (page === name) $(`nav-${name}`).setAttribute('aria-current', 'page'); else $(`nav-${name}`).removeAttribute('aria-current'); }
  $('view-title').textContent = page === 'settings' ? 'Settings' : page === 'statistics' ? 'Statistics' : savedSettings ? 'Conversion queue' : 'Create a playback profile';
  if (page === 'queue') render();
}
// A slow page request must never override a newer navigation choice or profile draft.
let navigationVersion = 0;
async function navigatePage(name) {
  const version = ++navigationVersion;
  if (profileEditing) {
    if (name === 'queue') return;
    throw new Error('Save or cancel your profile edits first.');
  }
  let data;
  try {
    if (name === 'settings') data = await api.getAppSettings();
    if (name === 'statistics') data = await api.getStatistics();
  } catch (error) {
    if (version !== navigationVersion || profileEditing) return;
    throw error;
  }
  if (version !== navigationVersion || profileEditing) return;
  if (name === 'settings') fillPreferences(data);
  if (name === 'statistics') renderStatistics(data);
  showPage(name);
}
for (const name of ['queue', 'settings', 'statistics']) $(`nav-${name}`).addEventListener('click', () => safe(() => navigatePage(name)));
let preferencesEditVersion = 0;
for (const event of ['input', 'change']) $('app-settings-form').addEventListener(event, () => { preferencesEditVersion++; });
$('app-settings-form').addEventListener('submit', event => { event.preventDefault(); safe(async () => {
  if ($('settings-save').disabled) return;
  const pageVersion = navigationVersion, editVersion = preferencesEditVersion, originalData = preferencesData;
  const value = { ...preferencesData.preferences };
  value.watchEnabled = $('pref-watchEnabled').checked;
  for (const key of preferenceBooleans) value[key] = $(`pref-${key}`).checked;
  for (const key of ['threads', 'inspectionConcurrency']) value[key] = Number($(`pref-${key}`).value);
  value.allowedLanguages = $('pref-allowedLanguages').value.split(',').map(s => s.trim()).filter(Boolean);
  value.outputSuffix = $('pref-outputSuffix').value;
  value.performanceMode = $('pref-performanceMode').value;
  $('settings-save').disabled = true;
  try {
    const data = await api.saveAppSettings(value);
    if (pageVersion !== navigationVersion || profileEditing || preferencesData !== originalData) return;
    if (editVersion === preferencesEditVersion) {
      fillPreferences(data);
      $('settings-result').textContent = 'Settings saved.';
    } else {
      $('settings-result').textContent = 'Submitted settings saved. Your newer edits are not saved yet.';
    }
  }
  finally { $('settings-save').disabled = false; }
}); });
$('settings-pick-output').addEventListener('click', () => safe(chooseOutputFolder));
$('settings-pick-watch').addEventListener('click', () => safe(async () => {
  const folder = await api.pickWatchFolder();
  if (folder) { preferencesEditVersion++; preferencesData.preferences.watchFolder = folder; $('settings-watch-folder').textContent = folder; }
}));
$('settings-edit-profile').addEventListener('click', () => safe(async () => { if (!savedSettings) throw new Error('Create a playback profile first.'); showPage('queue'); openSetup(); }));
$('settings-diagnostics').addEventListener('click', () => safe(() => api.exportDiagnostics()));
const gb = bytes => `${(bytes / 1e9).toFixed(2)} GB`;
// Render statistics: receives { stats, warning, enabled }. Updates state or visible controls; callers use the side effect.
function renderStatistics({ stats, warning, enabled }) {
  $('stats-note').textContent = `${enabled ? 'Local recording enabled' : 'Recording paused'} · Since ${new Date(stats.since).toLocaleDateString()}. Source GB means full source files producing verified outputs, not audio bytes encoded. GB is decimal. History starts with this feature; repeat exports count as separate jobs. ${warning || ''}`;
  const t = stats.totals; const cards = $('stats-cards'); cards.replaceChildren();
  for (const [label, value] of [['Files converted', t.completed], ['Source data processed', gb(t.sourceBytes)], ['Output written', gb(t.outputBytes)], ['Tracks re-encoded', t.encoded], ['DTS cores extracted', t.extracted], ['Tracks downmixed', t.downmixed], ['Tracks copied in outputs', t.copied], ['Processing time', `${(t.processingSeconds / 3600).toFixed(2)} h`], ['Media duration', `${(t.mediaSeconds / 3600).toFixed(2)} h`], ['Failed attempts', t.failed], ['Cancelled attempts', t.cancelled]]) {
    const card = element('div', 'stat-card'); card.append(element('span', 'meta', label), element('strong', '', String(value))); cards.append(card);
  }
  const breakdown = (id, entries) => { const parent = $(id); parent.replaceChildren(); if (!entries.length) parent.append(element('p', 'meta', 'No activity yet.')); for (const [label, value] of entries) { const row = element('div', 'stats-row'); row.append(element('span', '', label), element('span', '', String(value))); parent.append(row); } };
  breakdown('stats-codecs', [...Object.entries(stats.codecs), ...Object.entries(stats.downmixes)]);
  breakdown('stats-profiles', Object.entries(stats.profiles).map(([name, n]) => [name, `${n.completed} completed · ${gb(n.sourceBytes)} · ${n.failed} failed`]));
  breakdown('stats-days', Object.entries(stats.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 30).map(([day, n]) => [day, `${n.completed} completed · ${gb(n.sourceBytes)} · ${n.failed} failed · ${n.cancelled} cancelled`]));
  breakdown('stats-recent', stats.recent.map(job => [`${new Date(job.at).toLocaleString()} · ${job.profile}${job.filename ? ` · ${job.filename}` : ''}`, `${job.status} · ${job.counts.processingSeconds.toFixed(1)} s · ${gb(job.counts.sourceBytes)}`]));
}
$('stats-refresh').addEventListener('click', () => safe(async () => renderStatistics(await api.getStatistics())));
for (const action of ['export', 'reset']) $(`stats-${action}`).addEventListener('click', () => safe(async () => renderStatistics(await api.statisticsOperation(action))));
api.onUpdate(update => { if (update.type === 'statistics-changed' && currentPage === 'statistics') safe(async () => renderStatistics(await api.getStatistics())); });
safe(async () => { const data = await api.getAppSettings(); fillPreferences(data); $('app-version').textContent = `Audiority ${data.version}`; render(); });