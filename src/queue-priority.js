/*
 * queue-priority.js
 * Orders jobs without interrupting the current conversion. Main.js selects the next eligible job. Guide: newest-priority comparison; attempted-job filtering.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
// Compare priority: receives a, b. Returns the calculated value for the caller.
function comparePriority(a, b) {
  return (b.priority || 0) - (a.priority || 0);
}
// Next queue item: receives items, attempted. Returns the calculated value for the caller.
function nextQueueItem(items, attempted) {
  let next;
  for (const item of items.values()) {
    if (attempted.has(item.id) || item.output || !item.plan?.needsConversion || !['Ready', 'Error', 'Cancelled'].includes(item.status)) continue;
    if (!next || comparePriority(item, next) < 0) next = item;
  }
  return next;
}
module.exports = { comparePriority, nextQueueItem };