// Conservative additional audio allocation; copied input bytes are budgeted separately.
function estimatedAudioBytes(item) {
  const duration = Number(item.duration);
  if (!(duration > 0) || !Number.isFinite(duration)) return Math.max(0, item.size || 0);
  return Math.ceil(item.plan.tracks.reduce((sum, track) => {
    if (track.action !== 'encode') return sum;
    if (track.codec.startsWith('pcm_')) {
      const source = item.probe.streams.find(stream => stream.index === track.index);
      const rate = Number(track.sampleRate || source?.sample_rate) || 48000;
      const bits = Number(track.codec.match(/^pcm_[suf](\d+)/)?.[1]) || 32;
      return sum + duration * rate * (track.channels || 2) * Math.ceil(bits / 8);
    }
    const match = String(track.bitrate || '').match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
    const bitrate = match ? Number(match[1]) * ({ k: 1000, m: 1000000 }[match[2].toLowerCase()] || 1) : track.codec === 'dca' ? 1536000 : 640000;
    return sum + duration * bitrate / 8;
  }, 0));
}

module.exports = { estimatedAudioBytes };