/*
 * ui/renderer.js
 * Renderer-side queue workspace with no Node.js access. Uses window.audiority for privileged operations. Guide: DOM helpers; ETA; incremental cards; pagination/actions; backend updates.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const api = window.audiority;
const $ = id => document.getElementById(id);
const items = new Map();
// Map keeps jobs addressable by ID; the DOM is only a visible projection of this state.
const expandedTracks = new Set();
let running = false, importing = false, output = '', queuePage = 0, renderScheduled = false;
const queuePageSize = 50;
// Schedule render: receives no explicit arguments (uses current state). See the return statements below for the result; async results are Promises.
function scheduleRender() { if (renderScheduled) return; renderScheduled = true; requestAnimationFrame(() => { renderScheduled = false; render(); }); }
// Sync output folder: receives no explicit arguments (uses current state). See the return statements below for the result; async results are Promises.
function syncOutputFolder() {
  $('destination').textContent = output || 'No folder selected';
  $('folder').title = output || 'Choose output folder';
  $('settings-output').textContent = output || 'No output folder selected';
}
// Choose output folder: receives no explicit arguments (uses current state). See the return statements below for the result; async results are Promises.
async function chooseOutputFolder() {
  const selected = await api.pickOutput();
  if (selected) output = selected;
  syncOutputFolder(); render();
}
const label = codec => codec === 'dca' || codec === 'dts' ? 'DTS' : codec === 'ac3' ? 'Dolby Digital' : codec === 'eac3' ? 'Dolby Digital Plus' : codec.startsWith('pcm_') ? 'PCM' : codec.toUpperCase();
// Element: receives tag, className, text. See the return statements below for the result; async results are Promises.
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
// Progress value: receives item. Returns the calculated value for the caller.
function progressValue(item) { return Number.isFinite(item.progress) ? Math.min(1, Math.max(0, item.progress)) : 0; }
// Remaining text: receives seconds. Returns the calculated value for the caller.
function remainingText(seconds) {
  const rounded = Math.max(1, Math.ceil(seconds));
  return `${rounded}s`;
}
// Progress text: receives item. Returns the calculated value for the caller.
function progressText(item) {
  if (item.status === 'Complete') return 'Complete';
  if (item.status === 'Verifying') return 'Verifying output...';
  if (item.status !== 'Converting') return item.status;
  const value = progressValue(item);
  const elapsed = item.progressStart ? (Date.now() - item.progressStart) / 1000 : 0;
  const percent = `${Math.floor(value * 100)}%`;
  // The estimate is for writing/conversion only, not subsequent verification.
  if (elapsed < 3 || value <= 0 || value >= 1) return `${percent} · Estimating…`;
  const remaining = elapsed / value - elapsed;
  return Number.isFinite(remaining) ? `${percent} · ~${remainingText(remaining)} remaining` : `${percent} · Estimating…`;
}
// Update progress node: receives wrap, item. Updates state or visible controls; callers use the side effect.
function updateProgressNode(wrap, item) {
  wrap.querySelector('progress').value = item.status === 'Complete' ? 1 : progressValue(item);
  wrap.querySelector('.progress-text').textContent = progressText(item);
}
// Create progress: receives item. See the return statements below for the result; async results are Promises.
function createProgress(item) {
  if (item.status === 'Converting' && !item.progressStart && progressValue(item) > 0) item.progressStart = Date.now();
  const wrap = element('div', 'progress-wrap');
  const progress = element('progress'); progress.max = 1;
  progress.setAttribute('aria-label', `${item.name} progress`);
  wrap.append(progress, element('span', 'progress-text'));
  updateProgressNode(wrap, item);
  return wrap;
}
// Patch progress: receives update. See the return statements below for the result; async results are Promises.
function patchProgress(update) {
  const item = items.get(update.id);
  if (!item) return;
  // Track even off-screen jobs so navigation does not restart the ETA clock.
  if (update.status === 'Converting' && update.progress === 0) delete item.progressStart;
  if (update.status === 'Converting' && !item.progressStart && progressValue(item) > 0) item.progressStart = Date.now();
  if (typeof currentPage !== 'undefined' && currentPage !== 'queue') return;
  const card = [...$('queue').children].find(node => node.dataset.id === update.id);
  if (!card) return;
  const status = card.querySelector('.status'); status.textContent = update.status; status.className = `status ${update.status.toLowerCase()}`;
  let wrap = card.querySelector('.progress-wrap');
  if (!wrap) { wrap = createProgress(item); card.append(wrap); }
  updateProgressNode(wrap, item);
}
const cardSnapshots = new WeakMap();
// Create item card: receives item. See the return statements below for the result; async results are Promises.
function createItemCard(item) {
    const card = element('article', 'item');
    card.dataset.id = item.id;
    patchCardState(card, item);
    return card;
}
// Accepts existing card/job; updates changed regions while retaining the card and expanded details.
function patchCardState(card, item) {
  const previous = cardSnapshots.get(card) || {};
  const content = JSON.stringify([item.name, item.size, item.duration, item.relativeDirectory, item.subtitleInfo, item.sidecarCount, item.tracks]);
  if (content !== previous.content) {
    // Rebuild only the changed plan region, retaining the card and runtime nodes.
    let body = card.querySelector('.item-content');
    if (!body) { body = element('div', 'item-content'); card.prepend(body); }
    body.replaceChildren();
    const head = element('div', 'item-head');
    const info = element('div'); info.append(element('div', 'name', item.name));
    if (item.size) info.append(element('div', 'meta', `${(item.size / 1024 ** 3).toFixed(2)} GB · ${Math.round(item.duration)} seconds · ${item.tracks?.length || 0} audio track(s)`));
    head.append(info, element('span', 'status')); body.append(head);
    if (item.relativeDirectory) body.append(element('p', 'meta', `Output: ${item.relativeDirectory}`));
    if (item.subtitleInfo?.ass) body.append(element('p', 'warning-text', `${item.subtitleInfo.ass} ASS/SSA track(s) · ${item.subtitleInfo.fonts} embedded font(s). Subtitle content and attachments are preserved and verified; player rendering is not confirmed.`));
    if (item.sidecarCount) body.append(element('p', 'meta', `${item.sidecarCount} external subtitle(s) will be copied alongside converted output.`));
    const details = element('details'); details.open = expandedTracks.has(item.id);
    details.append(element('summary', '', `${item.tracks?.length || 0} audio tracks · View conversion plan`));
    details.addEventListener('toggle', () => { if (!details.isConnected) return; if (details.open) expandedTracks.add(item.id); else expandedTracks.delete(item.id); });
    for (const [index, track] of (item.tracks || []).entries()) {
      const row = element('div', `track${track.warning ? ' warning' : ''}`);
      row.append(element('span', '', `${index + 1}. ${label(track.sourceCodec)} · ${track.sourceLayout || track.layout || `${track.channels || '?'} channels`} · ${track.language}`), element('span', '', `${track.action === 'copy' ? 'Keep original' : `${track.keepOriginal ? 'Keep original + compatibility track ' : ''}→ ${label(track.codec)}${track.sourceLayout ? ` · ${track.layout}` : ''}`} — ${track.reason}`));
      details.append(row);
    }
    if (item.tracks?.length) body.append(details);
  }
  const status = card.querySelector('.status');
  if (status.textContent !== item.status) status.textContent = item.status;
  const statusClass = `status ${item.status.toLowerCase().replaceAll(' ', '-')}`;
  if (status.className !== statusClass) status.className = statusClass;
  let prioritize = card.querySelector('.prioritize-item');
  if (item.status === 'Ready' && !item.output) {
    if (!prioritize) {
      prioritize = element('button', 'quiet prioritize-item', '↑ Move to Top');
      prioritize.setAttribute('aria-label', `Move ${item.name} to top of queue`);
      prioritize.addEventListener('click', () => safe(async () => {
        prioritize.disabled = true;
        try { await api.prioritizeItem(item.id); queuePage = 0; render(); }
        finally { prioritize.disabled = false; }
      }));
    }
    if (prioritize.parentNode !== card.querySelector('.item-head')) card.querySelector('.item-head').append(prioritize);
  } else prioritize?.remove();
  let progress = card.querySelector('.progress-wrap');
  if (item.progress !== undefined || ['Converting', 'Verifying', 'Complete'].includes(item.status)) {
    if (!progress) { progress = createProgress(item); card.append(progress); }
    updateProgressNode(progress, item);
  } else if (progress) progress.remove();
  const messages = JSON.stringify([item.error, item.warnings, item.tracks?.some(t => t.compatibility === 'unresolved')]);
  if (messages !== previous.messages) {
    let region = card.querySelector('.item-messages');
    if (!region) { region = element('div', 'item-messages'); card.append(region); }
    region.replaceChildren();
    if (item.error) region.append(element('p', 'error', item.error));
    for (const warning of item.warnings || []) region.append(element('p', 'warning-text', warning));
    if (item.tracks?.some(t => t.compatibility === 'unresolved')) region.append(element('p', 'warning-text', 'Some tracks remain incompatible or unconfirmed. Converting this file does not resolve those tracks.'));
  }
  let reveal = card.querySelector('.reveal-output');
  if (item.output && !reveal) {
    reveal = element('button', 'quiet reveal-output', 'Show converted file');
    reveal.addEventListener('click', () => safe(() => api.reveal(item.id))); card.append(reveal);
  } else if (!item.output && reveal) reveal.remove();
  cardSnapshots.set(card, { content, messages });
}
// Reads queue state; patches the visible priority-sorted page and controls without wiping all cards.
function render() {
  if (typeof currentPage !== 'undefined' && currentPage !== 'queue') return;
  const queue = $('queue');
  const all = [...items.values()].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  queuePage = Math.max(0, Math.min(queuePage, Math.ceil(all.length / queuePageSize) - 1));
  const pageItems = all.slice(queuePage * queuePageSize, (queuePage + 1) * queuePageSize);
  const existing = new Map([...queue.children].filter(node => node.dataset.id).map(node => [node.dataset.id, node]));
  const expected = pageItems.map(item => {
    const card = existing.get(item.id);
    if (!card) return createItemCard(item);
    existing.delete(item.id); patchCardState(card, item); return card;
  });
  for (const orphan of existing.values()) orphan.remove();
  const empty = queue.querySelector('.queue-empty') || queue.querySelector('#empty');
  if (all.length) empty?.remove();
  else if (!empty) queue.append(element('p', 'queue-empty', 'Import a file to see exactly what will change.'));
  for (let i = 0; i < expected.length; i++) if (queue.children[i] !== expected[i]) queue.insertBefore(expected[i], queue.children[i] || null);
  let nav = queue.querySelector('.queue-pagination');
  if (all.length > queuePageSize) {
    if (!nav) {
    nav = element('div', 'queue-pagination');
    const previous = element('button', 'quiet', '← Previous'); previous.disabled = queuePage === 0;
    previous.addEventListener('click', () => { queuePage--; render(); });
    const next = element('button', 'quiet', 'Next →'); next.disabled = (queuePage + 1) * queuePageSize >= all.length;
    next.addEventListener('click', () => { queuePage++; render(); });
    nav.append(previous, element('span', 'meta', `Page ${queuePage + 1} of ${Math.ceil(all.length / queuePageSize)}`), next); queue.append(nav);
    }
    nav.firstElementChild.disabled = queuePage === 0;
    nav.lastElementChild.disabled = (queuePage + 1) * queuePageSize >= all.length;
    const text = `Page ${queuePage + 1} of ${Math.ceil(all.length / queuePageSize)}`;
    if (nav.querySelector('.meta').textContent !== text) nav.querySelector('.meta').textContent = text;
    if (queue.lastElementChild !== nav) queue.append(nav);
  } else nav?.remove();
  $('count').textContent = items.size;
  const profileOperationPending = typeof managingProfiles !== 'undefined' && managingProfiles;
  $('start').disabled = running || importing || profileOperationPending || !output || ![...items.values()].some(i => ['Ready', 'Error', 'Cancelled'].includes(i.status) && i.tracks?.some(t => t.action !== 'copy'));
  $('cancel').disabled = !running;
  $('clear').disabled = running || importing;
  $('folder').disabled = running || importing;
  $('settings-pick-output').disabled = running || importing;
  $('import-folder').disabled = running || importing || profileOperationPending;
  $('cancel-import').hidden = !importing;
  $('change-setup').disabled = running || importing || profileOperationPending;
  for (const id of ['rename-profile', 'duplicate-profile', 'delete-profile']) $(id).disabled = running || importing || profileOperationPending;
  if (typeof renderProfiles === 'function') renderProfiles();
  $('summary').textContent = running ? 'Converting locally. You can cancel safely.' : importing ? 'Inspecting audio tracks…' : `${[...items.values()].filter(i => i.status === 'Complete').length} completed · Originals untouched`;
}
// Safe: receives action. See the return statements below for the result; async results are Promises.
async function safe(action) { $('message').textContent = ''; try { await action(); } catch (error) { $('message').textContent = error.message; } }
// Import files: receives action. See the return statements below for the result; async results are Promises.
async function importFiles(action) { if (running || importing || $('workspace').hidden) return; importing = true; render(); await safe(action); importing = false; render(); }
$('drop').addEventListener('click', () => importFiles(() => api.pickFiles()));
$('import-folder').addEventListener('click', () => importFiles(() => api.pickImportFolder()));
$('cancel-import').addEventListener('click', () => safe(() => api.cancelImport()));
$('drop').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); importFiles(() => api.pickFiles()); } });
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());
$('drop').addEventListener('dragover', () => $('drop').classList.add('drag'));
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('drag'));
$('drop').addEventListener('drop', event => { $('drop').classList.remove('drag'); importFiles(() => api.addFiles(Array.from(event.dataTransfer.files))); });
$('folder').addEventListener('click', () => safe(chooseOutputFolder));
$('clear').addEventListener('click', () => safe(async () => { await api.clear(); items.clear(); render(); }));
$('start').addEventListener('click', () => safe(() => api.start()));
$('cancel').addEventListener('click', () => safe(() => api.cancel()));
api.onUpdate(update => {
  if (update.type === 'queue-warning') $('message').textContent = update.message;
  if (update.type === 'item') items.set(update.item.id, update.item);
  if (update.type === 'status' && items.has(update.id)) Object.assign(items.get(update.id), update);
  if (update.type === 'status' && ['Converting', 'Verifying'].includes(update.status)) {
    patchProgress(update);
    return;
  }
  if (update.type === 'running') running = update.value;
  if (update.type === 'importing') importing = update.value;
  if (update.type === 'import-progress') $('import-progress').textContent = `${update.found || 0} found · ${update.inspected || 0} inspected · ${update.skipped || 0} skipped`;
  if (update.type === 'import-result') {
    $('import-progress').textContent = '';
    $('import-report').hidden = false;
    $('import-result').textContent = `${update.cancelled ? 'Import cancelled. ' : ''}${update.inspected} inspected · ${update.duplicates} already queued · ${update.failures} failed · ${update.skipped} skipped.\n${update.warnings.join('\n')}`;
  }
  if (!['import-progress', 'statistics-changed'].includes(update.type)) scheduleRender();
});
render();