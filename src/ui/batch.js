// Batch controls operate on queue membership only; they never delete media.
const selectedJobs = new Set();
let queueFilter = 'all', batchVersion = 0;
function matchesQueueFilter(item) {
  return queueFilter === 'all' || queueFilter === 'runnable' && isRunnable(item) ||
    queueFilter === 'complete' && item.status === 'Complete' ||
    queueFilter === 'failed' && item.status === 'Error' ||
    queueFilter === 'blocked' && !!item.outputPreview?.blocked;
}
function updateBatchControls() {
  const busy = running || importing || recoveryBusy || (typeof managingProfiles !== 'undefined' && managingProfiles);
  for (const id of selectedJobs) if (!items.has(id)) selectedJobs.delete(id);
  $('retry-failed').disabled = busy || ![...items.values()].some(item => item.status === 'Error' && isRunnable(item));
  $('clear-completed').disabled = busy || ![...items.values()].some(item => item.status === 'Complete');
  $('remove-selected').disabled = busy || !selectedJobs.size;
  const hiddenSelections = [...selectedJobs].filter(id => !matchesQueueFilter(items.get(id))).length;
  $('remove-selected').textContent = selectedJobs.size ? `Remove selected (${selectedJobs.size}${hiddenSelections ? `; ${hiddenSelections} hidden` : ''})` : 'Remove selected';
  $('refresh-preview').disabled = busy || !output;
  for (const input of document.querySelectorAll('.select-job input')) input.disabled = busy;
}
async function removeJobs(action) {
  const removed = await api.queueOperation(action);
  for (const id of removed) { items.delete(id); selectedJobs.delete(id); expandedTracks.delete(id); }
  invalidateBatchPreview(); render();
}
function invalidateBatchPreview() {
  batchVersion++;
  $('batch-space').textContent = 'Preview needs refreshing after queue or destination changes.';
  $('batch-paths').replaceChildren();
}
$('queue-filter').addEventListener('change', () => { queueFilter = $('queue-filter').value; queuePage = 0; render(); });
$('retry-failed').addEventListener('click', () => safe(() => api.retryFailed()));
$('clear-completed').addEventListener('click', () => safe(() => removeJobs({ type: 'completed' })));
$('remove-selected').addEventListener('click', () => safe(() => removeJobs({ type: 'selected', ids: [...selectedJobs] })));
$('refresh-preview').addEventListener('click', () => safe(async () => {
  const version = ++batchVersion;
  $('batch-space').textContent = 'Checking destinations and free space…';
  try {
    const result = await api.previewBatch();
    if (version !== batchVersion) return;
    const gb = value => `${(value / 1e9).toFixed(2)} GB`;
    $('batch-space').textContent = `${gb(result.freeBytes)} free · ${gb(result.outputBytes)} output budget · ${gb(result.requiredBytes)} peak space budget · ${result.sufficient ? 'Budget fits' : 'Not enough space for the batch budget; reduce the queue or change destination'}.`;
    $('batch-paths').replaceChildren();
    for (const row of result.rows) {
      const p = element('p', 'meta', `${row.name} → ${row.destination}${row.conflicts ? ` · ${row.conflicts} name conflict(s); numbered alternative` : ''}`);
      $('batch-paths').append(p);
    }
    if (!result.rows.length) $('batch-paths').append(element('p', 'meta', 'No runnable jobs to preview.'));
  } catch (error) {
    if (version === batchVersion) $('batch-space').textContent = `Preview unavailable: ${error.message}`;
  }
}));
api.onUpdate(update => {
  if (['item', 'status', 'running', 'importing'].includes(update.type)) {
    if (update.type !== 'status' || !['Converting', 'Verifying', 'Publishing'].includes(update.status)) invalidateBatchPreview();
  }
});
updateBatchControls();
render();