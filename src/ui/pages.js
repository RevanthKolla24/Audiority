let currentPage = 'queue', preferencesData;
const preferenceBooleans = ['keepOriginal', 'normalizeVolume', 'clearCompletedOnRestart', 'rememberOutput', 'preserveFolders', 'preventSleep', 'compact', 'reducedMotion', 'statsEnabled', 'storeFilenames'];
function applyPreferences(value) {
  document.documentElement.classList.toggle('compact', value.compact);
  document.documentElement.classList.toggle('reduced-motion', value.reducedMotion);
}
function fillPreferences(data) {
  preferencesData = data;
  for (const key of preferenceBooleans) $(`pref-${key}`).checked = data.preferences[key];
  for (const key of ['threads', 'inspectionConcurrency', 'outputSuffix']) $(`pref-${key}`).value = data.preferences[key];
  $('settings-output').textContent = data.outputDirectory || 'No output folder selected';
  $('settings-result').textContent = data.warning || '';
  applyPreferences(data.preferences);
  output = data.outputDirectory || ''; syncOutputFolder();
  renderPresetThemes();
}
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
function showPage(page) {
  currentPage = page;
  $('settings-page').hidden = page !== 'settings'; $('statistics-page').hidden = page !== 'statistics';
  $('setup').hidden = page !== 'queue' || !!savedSettings;
  $('workspace').hidden = page !== 'queue' || !savedSettings;
  for (const name of ['queue', 'settings', 'statistics']) { if (page === name) $(`nav-${name}`).setAttribute('aria-current', 'page'); else $(`nav-${name}`).removeAttribute('aria-current'); }
  $('view-title').textContent = page === 'settings' ? 'Settings' : page === 'statistics' ? 'Statistics' : savedSettings ? 'Conversion queue' : 'Create a playback profile';
  if (page === 'queue') render();
}
for (const name of ['queue', 'settings', 'statistics']) $(`nav-${name}`).addEventListener('click', () => safe(async () => {
  if (name !== 'queue' && !$('setup').hidden && savedSettings) throw new Error('Save or cancel your profile edits first.');
  if (name === 'settings') fillPreferences(await api.getAppSettings());
  if (name === 'statistics') renderStatistics(await api.getStatistics());
  showPage(name);
}));
$('app-settings-form').addEventListener('submit', event => { event.preventDefault(); safe(async () => {
  const value = { ...preferencesData.preferences };
  for (const key of preferenceBooleans) value[key] = $(`pref-${key}`).checked;
  for (const key of ['threads', 'inspectionConcurrency']) value[key] = Number($(`pref-${key}`).value);
  value.outputSuffix = $('pref-outputSuffix').value;
  $('settings-save').disabled = true;
  try { fillPreferences(await api.saveAppSettings(value)); $('settings-result').textContent = 'Settings saved.'; }
  finally { $('settings-save').disabled = false; }
}); });
$('settings-pick-output').addEventListener('click', () => safe(chooseOutputFolder));
$('settings-edit-profile').addEventListener('click', () => safe(async () => { if (!savedSettings) throw new Error('Create a playback profile first.'); showPage('queue'); openSetup(); }));
$('settings-diagnostics').addEventListener('click', () => safe(() => api.exportDiagnostics()));
const gb = bytes => `${(bytes / 1e9).toFixed(2)} GB`;
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