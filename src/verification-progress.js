// Byte positions describe scan work, not packet counts or media playback time.
// Estimates are deliberately ranges: sparse streams and disk caching vary widely.
function verificationProgress(total, now = Date.now) {
  const started = now(), tasks = new Map();
  return (key, activity) => {
    if (activity) tasks.set(key, Math.max(tasks.get(key) || 0, activity.done ? 1 : Math.min(0.99, Math.max(0, activity.fraction || 0))));
    const completed = [...tasks.values()].reduce((sum, fraction) => sum + fraction, 0);
    const fraction = total ? Math.min(1, completed / total) : 0;
    const elapsed = (now() - started) / 1000;
    const remaining = elapsed >= 5 && fraction >= 0.02 && fraction < 1 ? elapsed * (1 - fraction) / fraction : null;
    return { fraction, elapsed, completed: [...tasks.values()].filter(value => value === 1).length, total,
      remainingLow: remaining === null ? null : remaining * 0.5,
      remainingHigh: remaining === null ? null : remaining * 2 };
  };
}
module.exports = { verificationProgress };

// Keep expensive full-file scans separate from cheap attachment/header checks.
// These are phase estimates, never an extrapolated whole-job finish time.
function verificationPhases(counts, now = Date.now) {
  const trackers = new Map(), states = new Map();
  const names = { video: 'Video checks', audio: 'Copied audio checks', subtitle: 'Subtitle checks', attachment: 'Font / attachment checks' };
  return (key, activity) => {
    const phase = key.startsWith('Checking video') ? 'video' : key.startsWith('Checking copied audio') || key.startsWith('Checking retained audio') ? 'audio' : key.startsWith('Checking subtitle') ? 'subtitle' : key.startsWith('Checking attachment') ? 'attachment' : null;
    if (!phase) return undefined;
    if (!trackers.has(phase)) trackers.set(phase, verificationProgress(counts[phase] || 0, now));
    const state = trackers.get(phase)(key, activity);
    states.set(phase, state);
    const pending = Object.keys(names).filter(name => name !== phase && counts[name] > 0 && states.get(name)?.fraction !== 1).map(name => names[name]);
    return { ...state, phase: names[phase], pending };
  };
}
module.exports.verificationPhases = verificationPhases;