// Queue membership only: never touches media files. Restore exact order on save failure.
async function removeQueueItems(items, action, persist) {
  if (!action || !['completed', 'selected'].includes(action.type)) throw new Error('Invalid queue action.');
  if (action.type === 'selected' && (!Array.isArray(action.ids) || action.ids.some(id => typeof id !== 'string' || !items.has(id)))) throw new Error('Unknown queue selection.');
  const selected = new Set(action.ids || []);
  const removed = [...items.values()].filter(item => action.type === 'completed' ? item.status === 'Complete' : selected.has(item.id));
  if (removed.some(item => item.persistencePending || item.publicationPending || item.outputUnavailable)) throw new Error('Resolve output recovery and pending saves before removing these jobs.');
  const previous = new Map(items);
  try {
    for (const item of removed) items.delete(item.id);
    await persist();
  } catch (error) {
    items.clear(); for (const [id, item] of previous) items.set(id, item);
    throw error;
  }
  return removed.map(item => item.id);
}
module.exports = { removeQueueItems };