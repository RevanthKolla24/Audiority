// Shares the narrow bridge and UI helpers from renderer.js; no Node access.
let setupData, savedSettings, draft, selectedReceiver = '', previewVersion = 0, activeOption = -1, editingId = null, managingProfiles = false, dialogAction = null;
const formatNames = { dts: 'DTS', ac3: 'Dolby Digital (AC-3)', pcm: 'PCM stereo', eac3: 'Dolby Digital Plus', dtshd: 'DTS-HD', truehd: 'Dolby TrueHD' };
const sourceNames = ['ac3', 'eac3', 'dts', 'dtshd', 'truehd', 'pcm', 'flac', 'alac', 'aac', 'mp3', 'opus', 'vorbis'];
const matrixRows = [
  { id: 'dtshd', sources: ['dtshd'], scope: 'any', actions: ['copy', 'core', 'ac3', 'dts', 'pcm'] },
  { id: 'truehd', sources: ['truehd'], scope: 'any', actions: ['copy', 'ac3', 'dts', 'pcm'] },
  { id: 'eac3', sources: ['eac3'], scope: 'any', actions: ['copy', 'ac3', 'pcm'] },
  { id: 'lossless', sources: ['flac', 'alac'], scope: 'surround', actions: ['ac3', 'dts', 'pcm'] },
  { id: 'other', sources: ['aac', 'mp3', 'opus', 'vorbis'], scope: 'any', actions: ['copy', 'ac3', 'dts', 'pcm'] }
];
function matrixState(value, row) {
  const rules = value.rules.filter(rule => row.sources.includes(rule.source));
  const excluded = row.sources.filter(source => value.excludedFormats.includes(source));
  if (excluded.length === row.sources.length && !rules.length && row.actions.includes('copy')) return 'copy';
  if (excluded.length) return 'auto';
  if (!rules.length) return row.id === 'dtshd' && value.extractDtsCore ? 'core' : 'auto';
  const target = rules[0].target;
  if (!row.actions.includes(target) || target === 'copy' || rules.length !== row.sources.length ||
      !row.sources.every(source => rules.some(rule => rule.source === source && rule.scope === row.scope && rule.target === target)) ||
      row.id === 'dtshd' && value.extractDtsCore) return 'auto';
  return target;
}
function refreshMatrix(value) {
  for (const row of matrixRows) $('matrix-' + row.id).value = matrixState(value, row);
}
function applyMatrix(row, action) {
  // Automatic deliberately leaves the explicit editors unchanged. They are
  // the schema-backed source of truth, so repeated previews never add rules.
  if (action === 'auto') return;
  for (const input of $('excluded-formats').querySelectorAll('input')) {
    if (row.sources.includes(input.value)) input.checked = action === 'copy';
  }
  if (row.id === 'dtshd') $('extract-dts-core').checked = action === 'core';
  // Only replace this row's scope. Preserve more specific legacy overrides.
  for (const node of [...$('rule-list').children]) {
    if (row.sources.includes(node.querySelector('[data-field="source"]').value) &&
        node.querySelector('[data-field="scope"]').value === row.scope) node.remove();
  }
  if (['ac3', 'dts', 'pcm'].includes(action)) {
    for (const source of row.sources) ruleRow({ source, scope: row.scope, target: action });
    $('allowed-formats').querySelector(`input[value="${action}"]`).checked = true;
    if (row.id === 'lossless') $('lossless-target').value = action;
    if (row.id === 'other') { $('lossy-target').value = action; $('stereo-target').value = action; }
  }
  refreshMatrix(readDraft());
}
for (const row of matrixRows) {
  const names = { auto: 'Automatic / existing overrides', copy: 'Keep original', core: 'Extract compatible DTS core', ac3: 'Convert to AC-3', dts: 'Convert to DTS', pcm: 'Convert to PCM stereo' };
  selectOptions($('matrix-' + row.id), ['auto', ...row.actions].map(action => [action, names[action]]), 'auto');
  $('matrix-' + row.id).addEventListener('change', event => applyMatrix(row, event.target.value));
}
function selectOptions(node, options, value) {
  node.replaceChildren();
  for (const [id, text] of options) { const option = element('option', '', text); option.value = id; node.append(option); }
  node.value = value;
}
function checkboxes(id, formats, selected) {
  const parent = $(id); parent.replaceChildren();
  for (const format of formats) {
    const label = element('label', 'check'); const input = element('input'); input.type = 'checkbox'; input.value = format; input.checked = selected.includes(format);
    label.append(input, document.createTextNode(formatNames[format] || format.toUpperCase())); parent.append(label);
  }
}
function checked(id) { return [...$(id).querySelectorAll('input:checked')].map(input => input.value); }
function showSources(parent, sources) {
  for (const source of sources || []) parent.append(element('div', 'meta', `Reference: ${source}`));
}
function receiverDetail() {
  const receiver = setupData.receivers.find(r => r.id === selectedReceiver);
  const detail = $('avr-detail'); detail.replaceChildren();
  if (receiver) {
    detail.append(element('strong', '', receiver.name), element('p', '', `${receiver.status === 'documented' ? 'Documented preset' : receiver.status === 'user-reported' ? 'User-reported preset' : 'Directory only · custom confirmation required'}${receiver.codecs.length ? ` · ${receiver.codecs.map(c => formatNames[c] || c).join(', ')}` : ''}`), element('p', '', receiver.note));
    showSources(detail, receiver.sources);
  } else detail.textContent = 'Custom receiver: enable Advanced and confirm your receiver’s supported formats.';
  $('receiver-next').disabled = !selectedReceiver && !$('advanced-enabled').checked || receiver?.status === 'directory-only' && !$('advanced-enabled').checked;
  $('receiver-help').textContent = receiver?.status === 'directory-only' ? 'This model requires Advanced capability confirmation.' : 'Settings stay on this computer.';
}
function searchReceivers() {
  const tokens = $('avr-search').value.toLowerCase().split(/\s+/).map(token => token.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  const matches = setupData.receivers.filter(r => {
    const haystack = [r.name, ...r.aliases].join(' ').toLowerCase().replace(/[^a-z0-9]/g, '');
    return tokens.every(token => haystack.includes(token));
  });
  const results = $('avr-results'); results.replaceChildren(); activeOption = -1;
  for (const receiver of matches) {
    const button = element('button', 'avr-option', `${receiver.name} · ${receiver.status === 'directory-only' ? 'custom confirmation' : receiver.status}`);
    button.type = 'button'; button.id = `option-${receiver.id}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', 'false');
    button.addEventListener('click', () => chooseReceiver(receiver)); results.append(button);
  }
  if (!matches.length) results.append(element('p', 'meta', 'No matching model. Use Custom setup below.'));
  results.hidden = false; $('avr-search').setAttribute('aria-expanded', 'true'); $('avr-search').removeAttribute('aria-activedescendant');
}
function chooseReceiver(receiver) {
  selectedReceiver = receiver.id; $('avr-search').value = receiver.name;
  $('avr-results').hidden = true; $('avr-search').setAttribute('aria-expanded', 'false'); $('avr-search').removeAttribute('aria-activedescendant'); receiverDetail();
}
function ruleRow(rule = { source: 'flac', scope: 'surround', target: 'dts' }) {
  const row = element('div', 'rule-row');
  for (const [key, options] of [['source', sourceNames.map(s => [s, formatNames[s] || s.toUpperCase()])], ['scope', [['any', 'All channels'], ['stereo', 'Stereo'], ['surround', 'Mono / surround']]], ['target', [['auto', 'Automatic'], ['copy', 'Keep original'], ...['dts', 'ac3', 'pcm'].map(f => [f, formatNames[f]])]]]) {
    const select = element('select'); select.dataset.field = key; select.setAttribute('aria-label', `Rule ${key}`); selectOptions(select, options, rule[key]); row.append(select);
  }
  const remove = element('button', 'quiet', 'Remove'); remove.addEventListener('click', () => { row.remove(); refreshMatrix(readDraft()); }); row.append(remove); $('rule-list').append(row);
}
function downmixRow(rule = { source: '7.1', target: '5.1(side)' }) {
  const row = element('div', 'rule-row');
  for (const [key, values] of [['source', ['7.1', '7.1(wide)', '7.1(wide-side)', '6.1', '6.1(back)', '6.1(front)', '5.1', '5.1(side)']], ['target', ['5.1(side)', '3.1', 'stereo']]]) {
    const select = element('select'); select.dataset.field = key; select.setAttribute('aria-label', `Downmix ${key}`);
    selectOptions(select, values.map(v => [v, v]), rule[key]); row.append(select);
  }
  const remove = element('button', 'quiet', 'Remove'); remove.addEventListener('click', () => row.remove()); row.append(remove); $('downmix-list').append(row);
}
$('add-downmix').addEventListener('click', () => downmixRow());
$('matrix-panel').addEventListener('change', event => {
  if (!event.target.id.startsWith('matrix-')) refreshMatrix(readDraft());
});
function fillDraft(value) {
  draft = structuredClone(value); selectedReceiver = draft.receiverId;
  $('avr-search').value = setupData.receivers.find(r => r.id === selectedReceiver)?.name || '';
  $('advanced-enabled').checked = draft.advanced; $('matrix-panel').open = true;
  checkboxes('allowed-formats', ['dts', 'ac3', 'pcm'], draft.allowed);
  $('preserve-supported').checked = draft.preserve;
  $('extract-dts-core').checked = draft.extractDtsCore ?? true;
  $('allow-downmix').checked = draft.allowDownmix ?? false;
  checkboxes('excluded-formats', sourceNames, draft.excludedFormats || []);
  $('downmix-list').replaceChildren(); (draft.downmixRules || [{ source: '7.1', target: '5.1(side)' }]).forEach(downmixRow);
  for (const key of ['lossless', 'lossy', 'stereo']) selectOptions($(`${key}-target`), ['dts', 'ac3', 'pcm'].map(f => [f, formatNames[f]]), draft[key]);
  for (const [id, key] of [['ac3-bitrate', 'ac3Bitrate'], ['dts-bitrate', 'dtsBitrate'], ['pcm-bits', 'pcmBits'], ['pcm-rate', 'pcmRate'], ['media-platform', 'platform'], ['audio-connection', 'connection'], ['passthrough', 'passthrough']]) $(id).value = draft[key];
  $('rule-list').replaceChildren(); draft.rules.forEach(ruleRow);
  refreshMatrix(draft);
  selectOptions($('playback-device'), setupData.devices.map(d => [d.id, d.name]), draft.deviceId);
  $('player-app').value = draft.player; $('tv-model').value = draft.tv; $('path-confirmed').checked = draft.pathConfirmed;
  checkboxes('path-formats', ['ac3', 'dts', 'pcm', 'eac3', 'dtshd', 'truehd'], draft.pathCodecs);
  receiverDetail(); deviceDetail();
}
function readDraft() {
  draft.extractDtsCore = $('extract-dts-core').checked;
  draft.allowDownmix = $('allow-downmix').checked;
  draft.excludedFormats = checked('excluded-formats');
  draft.downmixRules = [...$('downmix-list').children].map(row => Object.fromEntries([...row.querySelectorAll('select')].map(select => [select.dataset.field, select.value])));
  return { ...draft, receiverId: selectedReceiver, advanced: $('advanced-enabled').checked, allowed: checked('allowed-formats'), preserve: $('preserve-supported').checked, lossless: $('lossless-target').value, lossy: $('lossy-target').value, stereo: $('stereo-target').value, ac3Bitrate: Number($('ac3-bitrate').value), dtsBitrate: Number($('dts-bitrate').value), pcmBits: Number($('pcm-bits').value), pcmRate: Number($('pcm-rate').value), rules: [...$('rule-list').children].map(row => Object.fromEntries([...row.querySelectorAll('select')].map(select => [select.dataset.field, select.value]))), platform: $('media-platform').value, deviceId: $('playback-device').value, player: $('player-app').value, connection: $('audio-connection').value, tv: $('tv-model').value, passthrough: $('passthrough').value, pathConfirmed: $('path-confirmed').checked, pathCodecs: checked('path-formats') };
}
function deviceDetail() {
  const device = setupData.devices.find(d => d.id === $('playback-device').value);
  $('device-detail').replaceChildren(element('strong', '', device.name), element('p', '', device.note)); showSources($('device-detail'), device.sources);
  for (const input of $('path-formats').querySelectorAll('input')) input.disabled = !$('path-confirmed').checked;
}
function profileText(profile) {
  return `${profile.name} · ${profile.allowed.map(c => formatNames[c]).join(' / ') || 'No safe target enabled'} · PCM ≤ ${profile.pcmBits}-bit / ${profile.pcmRate / 1000} kHz`;
}
async function previewProfile() {
  const version = ++previewVersion;
  try {
    const profile = await api.previewProfile(readDraft()); if (version !== previewVersion) return;
    $('profile-preview').replaceChildren(element('strong', '', profileText(profile)), ...profile.warnings.map(w => element('p', 'warning-text', w)));
    $('setup-save').disabled = false;
  } catch (error) { if (version === previewVersion) { $('profile-preview').textContent = error.message; $('setup-save').disabled = true; } }
}
function showStep(step) {
  $('receiver-page').hidden = step !== 1; $('playback-page').hidden = step !== 2;
  $('step-one').classList.toggle('active', step === 1); $('step-two').classList.toggle('active', step === 2);
  if (step === 2) { deviceDetail(); previewProfile(); $('media-platform').focus(); } else $('avr-search').focus();
}
function enterWorkspace(profile) {
  if ($('advanced-rules-dialog').open) $('advanced-rules-dialog').close();
  if (typeof showPage === 'function') showPage('queue');
  $('setup').hidden = true; $('workspace').hidden = false;
  $('view-title').textContent = 'Conversion queue';
  $('active-profile').textContent = profileText(profile);
  $('active-warnings').replaceChildren(...profile.warnings.map(w => element('p', 'warning-text', w)));
  $('active-warnings').hidden = !profile.warnings.length;
  $('warning-panel').hidden = !profile.warnings.length;
  renderProfiles();
  for (const key of ['lossless', 'lossy', 'stereo']) $(`${key}-summary`).textContent = `${key === 'stereo' ? 'Stereo' : `${key === 'lossless' ? 'Lossless' : 'Lossy'} surround`} → ${formatNames[profile[key]]}`;
  $('change-setup').disabled = running || importing || managingProfiles;
  render();
}
function openSetup(newProfile = false) {
  if ($('advanced-rules-dialog').open) $('advanced-rules-dialog').close();
  if (running || importing || managingProfiles || !setupData) return;
  if (typeof showPage === 'function') showPage('queue');
  editingId = newProfile ? null : setupData.library.activeId;
  const record = setupData.library.profiles.find(p => p.id === editingId);
  $('profile-name').value = record?.name || '';
  $('view-title').textContent = record ? 'Edit playback profile' : 'Create a playback profile';
  fillDraft(record?.settings || setupData.defaults); $('workspace').hidden = true; $('setup').hidden = false;
  $('setup-cancel').hidden = !savedSettings; showStep(1); renderProfiles();
}
$('avr-search').addEventListener('input', () => { selectedReceiver = ''; receiverDetail(); searchReceivers(); });
$('avr-search').addEventListener('focus', () => { if (setupData) searchReceivers(); });
$('avr-search').addEventListener('keydown', event => {
  const options = [...$('avr-results').querySelectorAll('button')];
  if (event.key === 'Escape') { $('avr-results').hidden = true; $('avr-search').setAttribute('aria-expanded', 'false'); }
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && options.length) {
    event.preventDefault(); activeOption = (activeOption + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options.forEach((option, i) => option.setAttribute('aria-selected', String(i === activeOption)));
    $('avr-search').setAttribute('aria-activedescendant', options[activeOption].id); options[activeOption].scrollIntoView({ block: 'nearest' });
  }
  if (event.key === 'Enter' && activeOption >= 0 && !$('avr-results').hidden) { event.preventDefault(); options[activeOption].click(); }
});
document.addEventListener('click', event => { if (!event.target.closest('.combobox')) { $('avr-results').hidden = true; $('avr-search').setAttribute('aria-expanded', 'false'); } });
$('advanced-rules-open').addEventListener('click', () => $('advanced-rules-dialog').showModal());
$('advanced-rules-done').addEventListener('click', () => $('advanced-rules-dialog').close());
$('advanced-rules-dialog').addEventListener('close', () => {
  receiverDetail();
  if (!$('setup').hidden) $('advanced-rules-open').focus();
});
$('custom-receiver').addEventListener('click', () => { selectedReceiver = ''; $('avr-search').value = ''; $('advanced-enabled').checked = true; $('matrix-panel').open = true; receiverDetail(); $('advanced-rules-dialog').showModal(); });
$('advanced-enabled').addEventListener('change', receiverDetail);
$('add-rule').addEventListener('click', () => { if ($('rule-list').children.length < 40) ruleRow(); });
$('reset-advanced').addEventListener('click', () => { const current = readDraft(); fillDraft({ ...setupData.defaults, receiverId: current.receiverId, advanced: current.advanced, platform: current.platform, deviceId: current.deviceId, player: current.player, connection: current.connection, tv: current.tv, passthrough: current.passthrough, pathConfirmed: current.pathConfirmed, pathCodecs: current.pathCodecs }); });
$('receiver-next').addEventListener('click', () => showStep(2));
$('playback-back').addEventListener('click', () => showStep(1));
$('playback-page').addEventListener('change', () => { deviceDetail(); previewProfile(); });
$('playback-page').addEventListener('input', () => previewProfile());
$('setup-save').addEventListener('click', () => safe(async () => {
  $('setup-save').disabled = true;
  try { await performProfile({ type: 'save', id: editingId, name: $('profile-name').value, settings: readDraft() }); }
  finally { $('setup-save').disabled = false; }
}));
$('change-setup').addEventListener('click', () => openSetup());
$('setup-cancel').addEventListener('click', () => enterWorkspace(setupData.profile));
safe(async () => {
  setupData = await api.getSetup(); savedSettings = setupData.settings;
  renderProfiles();
  $('profile-name').value = '';
  $('catalog-count').textContent = `${setupData.receivers.length} models · alphabetical directory · documented and unverified entries clearly labeled`;
  fillDraft(savedSettings || setupData.defaults);
  if (setupData.warning) $('message').textContent = setupData.warning;
  if (savedSettings) enterWorkspace(setupData.profile); else showStep(1);
});
let profileRenderSignature = '';
function renderProfiles() {
  if (!setupData) return;
  const signature = JSON.stringify([setupData.library, $('profile-search').value, running, importing, managingProfiles, $('setup').hidden]);
  if (signature === profileRenderSignature) return;
  profileRenderSignature = signature;
  const list = $('profile-list'); list.replaceChildren();
  const query = $('profile-search').value.toLowerCase();
  for (const record of setupData.library.profiles.filter(p => p.name.toLowerCase().includes(query))) {
    const button = element('button', `profile-entry${record.id === setupData.library.activeId ? ' active' : ''}`);
    button.setAttribute('aria-pressed', String(record.id === setupData.library.activeId));
    button.dataset.id = record.id;
    button.append(element('strong', '', record.name), element('small', '', `${record.settings.platform === 'local' ? 'Local playback' : record.settings.platform} · ${record.settings.connection.toUpperCase()}`));
    button.disabled = running || importing || managingProfiles || !$('setup').hidden;
    button.addEventListener('click', () => safe(() => performProfile({ type: 'switch', id: record.id })));
    list.append(button);
  }
  $('profile-count').textContent = setupData.library.profiles.length;
  $('new-profile').disabled = running || importing || managingProfiles || !$('setup').hidden;
}
async function performProfile(action) {
  if (running || importing || managingProfiles) throw new Error('Wait until the current operation finishes.');
  managingProfiles = true; render(); renderProfiles();
  try {
    setupData = await api.profileOperation(action); savedSettings = setupData.settings;
    if (savedSettings) enterWorkspace(setupData.profile);
    else {
      editingId = null; $('profile-name').value = '';
      fillDraft(setupData.defaults); $('workspace').hidden = true; $('setup').hidden = false;
      $('setup-cancel').hidden = true; $('view-title').textContent = 'Create a playback profile'; showStep(1);
    }
  } finally { managingProfiles = false; render(); renderProfiles(); }
}
function openProfileDialog(type) {
  if (running || importing || managingProfiles) return;
  const record = setupData.library.profiles.find(p => p.id === setupData.library.activeId);
  if (!record) return;
  dialogAction = { type, id: record.id };
  $('dialog-title').textContent = type === 'delete' ? 'Delete this profile?' : type === 'duplicate' ? 'Duplicate profile' : 'Rename profile';
  $('dialog-description').textContent = type === 'delete' ? `Remove “${record.name}”? Generated media files will not be deleted.` : 'Use a name that identifies the room or playback setup.';
  $('dialog-name').value = type === 'duplicate' ? `${record.name.slice(0, 90)} copy` : record.name;
  $('dialog-name').hidden = type === 'delete'; $('dialog-name-label').hidden = type === 'delete';
  $('dialog-name').required = type !== 'delete';
  $('dialog-error').textContent = ''; $('dialog-confirm').textContent = type === 'delete' ? 'Delete profile' : 'Save';
  $('profile-dialog').showModal();
}
$('new-profile').addEventListener('click', () => { openSetup(true); renderProfiles(); });
$('profile-search').addEventListener('input', renderProfiles);
for (const type of ['rename', 'duplicate', 'delete']) $(`${type}-profile`).addEventListener('click', () => openProfileDialog(type));
$('dialog-cancel').addEventListener('click', () => $('profile-dialog').close());
$('profile-dialog-form').addEventListener('submit', async event => {
  event.preventDefault(); $('dialog-confirm').disabled = true;
  try { await performProfile({ ...dialogAction, name: $('dialog-name').value }); $('profile-dialog').close(); }
  catch (error) { $('dialog-error').textContent = error.message; }
  finally { $('dialog-confirm').disabled = false; }
});