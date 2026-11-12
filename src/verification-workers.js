// Refill capacity as each task finishes, rather than waiting for a whole batch.
// Callers own cancellation and must drain any children belonging to a failed task.
async function verificationWorkers(targets, verify, { limit = () => 2, signal } = {}) {
  let next = 0, failure;
  const active = new Set();
  while ((next < targets.length || active.size) && !failure) {
    while (!signal?.aborted && next < targets.length && active.size < Math.max(1, Math.min(2, limit()))) {
      const target = targets[next++];
      const task = Promise.resolve().then(() => verify(target)).catch(error => { failure ||= error; })
        .finally(() => active.delete(task));
      active.add(task);
    }
    if (!active.size) break;
    await Promise.race(active);
  }
  await Promise.allSettled(active);
  if (failure) throw failure;
  if (signal?.aborted) throw new Error('Cancelled');
}

module.exports = { verificationWorkers };