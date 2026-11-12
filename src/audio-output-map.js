// Shared command/verification contract. Output ordinals are audio-relative;
// source indices remain absolute after language filtering removes other streams.
function compatibilityTitle(track) {
  return `${track.title ? `${track.title} · ` : ''}Compatibility (${track.codec === 'dca' ? 'DTS' : track.codec.toUpperCase()})`;
}

function audioOutputMap(item) {
  const tracks = item.plan.tracks;
  const sources = tracks.map(track => item.probe.streams.find(stream => stream.index === track.index));
  if (sources.some(source => !source)) throw new Error('Invalid audio plan: source stream is missing.');
  const duplicated = tracks.map((track, i) => track.keepOriginal && track.action !== 'copy' ? i : -1).filter(i => i >= 0);
  const sourceDefault = sources.findIndex(source => source.disposition?.default);
  const defaultSource = sourceDefault >= 0 ? sourceDefault : (duplicated[0] ?? tracks.findIndex(track => track.action !== 'copy'));
  const defaultOutput = duplicated.includes(defaultSource) ? tracks.length + duplicated.indexOf(defaultSource) : defaultSource;
  const rewrite = duplicated.length > 0 || (sourceDefault < 0 && defaultSource >= 0);
  return [...tracks.map((track, i) => ({ track, source: sources[i], compatibility: false })),
    ...duplicated.map(i => ({ track: tracks[i], source: sources[i], compatibility: true }))]
    .map((entry, ordinal) => ({ ...entry, ordinal,
      default: rewrite ? Number(ordinal === defaultOutput) : Number(!!entry.source.disposition?.default),
      title: entry.compatibility ? compatibilityTitle(entry.track) : entry.source.tags?.title || '',
      language: entry.source.tags?.language || 'und' }));
}

// Serializable preview derived from the same contract as commands/verification.
// Retained originals use source properties, not the compatibility target layout.
function audioOutputPreview(item) {
  if (item.plan.blocked) return { blocked: true, outputs: [] };
  return { blocked: false, outputs: audioOutputMap(item).map(entry => {
    const original = entry.track.action === 'copy' || (entry.track.keepOriginal && !entry.compatibility);
    return { ordinal: entry.ordinal, sourceIndex: entry.source.index,
      role: original ? (entry.track.action === 'copy' ? 'Original (copied)' : 'Retained original') : entry.compatibility ? 'Compatibility track' : 'Converted track',
      codec: original ? entry.source.codec_name || 'unknown' : entry.track.codec,
      layout: original ? entry.source.channel_layout || 'unknown layout' : entry.track.layout || 'unknown layout',
      channels: original ? entry.source.channels ?? null : entry.track.channels ?? null,
      language: entry.language, title: entry.title, default: entry.default };
  }) };
}

module.exports = { audioOutputMap, compatibilityTitle, audioOutputPreview };