const { audioOutputMap } = require('./audio-output-map');

// A file-level report, not a claim about player selection or receiver passthrough.
function conversionReport(item, output, preferences = {}, profile) {
  const audio = output.streams.filter(stream => stream.codec_type === 'audio');
  const describe = stream => JSON.stringify({
    index: stream.index, codec: stream.codec_name || 'unknown', channels: stream.channels ?? null,
    layout: stream.channel_layout || 'unknown', language: stream.tags?.language || 'und',
    title: stream.tags?.title || '', default: Number(!!stream.disposition?.default)
  });
  const lines = audioOutputMap(item).map(entry => {
    const actual = audio[entry.ordinal];
    if (!actual) throw new Error('Cannot report missing output audio stream.');
    const retained = entry.track.keepOriginal && entry.track.action !== 'copy' && !entry.compatibility;
    const filters = retained ? [] : require('./audio-processing').audioFilters(entry.track, preferences, profile);
    const processing = filters.length ? filters.join(',') : 'none (no audio filters)';
    const policy = entry.track.downmix && !retained ? '\n  Mix policy: FFmpeg speaker-aware matrix; global coefficient headroom normalization; dedicated LFE omitted only when output has no LFE. Center gain is not speech isolation. No post-codec peak guarantee.' : '';
    return `Source ${describe(entry.source)}\n  → Output audio ordinal ${entry.ordinal} (${retained ? 'retained original' : entry.track.action}${entry.compatibility ? ', compatibility' : ''}) ${describe(actual)}\n  Filters: ${processing}${policy}`;
  });
  return ['Verified file audio mapping (indices and ordinals are zero-based).',
    ...(profile?.systemExplanation ? [`System policy: ${profile.systemExplanation}`] : []),
    'Player-selected track, server transcoding and receiver passthrough are not measured.', ...lines].join('\n');
}

module.exports = { conversionReport };