const os = require('node:os');
// Conservative experimental defaults: leave room for interactive work and avoid
// rapid oscillation. These are scheduling thresholds, not CPU usage guarantees.
const SAMPLE_MS = 1000, QUIET_MS = 5000, GROW_BELOW = 0.45, SHRINK_ABOVE = 0.7;
const MIN_FREE_BYTES = 512 * 1024 ** 2, MIN_FREE_FRACTION = 0.08;

// Aggregate CPU headroom, not user-idle detection. Never changes process priority.
function systemSample() {
  const cpus = os.cpus();
  const times = cpus.reduce((sum, cpu) => {
    sum.idle += cpu.times.idle;
    sum.total += Object.values(cpu.times).reduce((total, value) => total + value, 0);
    return sum;
  }, { idle: 0, total: 0 });
  return { ...times, cores: cpus.length, free: os.freemem(), memory: os.totalmem() };
}

function createResourceBudget(mode = 'balanced', { sample = systemSample, now = Date.now } = {}) {
  let previous, previousAt, quiet = 0, limit = mode === 'adaptive' ? 1 : 2;
  const update = () => {
    if (mode !== 'adaptive') return limit;
    try {
      const at = now();
      if (previousAt !== undefined && at - previousAt < SAMPLE_MS) return limit;
      const current = sample();
      if (!current.cores || !Number.isFinite(current.total) || !Number.isFinite(current.idle) ||
          !(current.memory > 0) || !Number.isFinite(current.free)) throw new Error('Unavailable telemetry');
      const elapsed = previousAt === undefined ? 0 : at - previousAt;
      const total = previous ? current.total - previous.total : 0;
      const idle = previous ? current.idle - previous.idle : 0;
      const usage = total > 0 && idle >= 0 && idle <= total ? 1 - idle / total : null;
      const memoryOK = current.free >= Math.max(MIN_FREE_BYTES, current.memory * MIN_FREE_FRACTION);
      if (!memoryOK || current.cores < 2 || usage === null || usage >= SHRINK_ABOVE) { limit = 1; quiet = 0; }
      else if (usage < GROW_BELOW) {
        quiet += Math.min(elapsed, 2000);
        if (quiet >= QUIET_MS) limit = 2;
      } else quiet = 0;
      previous = current; previousAt = at;
    } catch { limit = 1; quiet = 0; previous = undefined; previousAt = undefined; }
    return limit;
  };
  update();
  const timer = mode === 'adaptive' ? setInterval(update, SAMPLE_MS) : null;
  timer?.unref();
  return { limit: update, close() { if (timer) clearInterval(timer); } };
}

module.exports = { createResourceBudget, systemSample };