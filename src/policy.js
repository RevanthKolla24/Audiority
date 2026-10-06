/*
 * policy.js
 * Chooses copy, core extraction or encoding without writing media. Engine.js supplies probe/capability data; profiles.js supplies playback constraints. Guide: classification; defaults; profile rules; whole-file plans.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const LOSSLESS = new Set(['flac', 'alac', 'truehd', 'mlp', 'wavpack', 'ape', 'tta', 'als', 'shorten']);
const LOSSY = new Set(['aac', 'mp3', 'mp2', 'mp1', 'opus', 'vorbis', 'wmav1', 'wmav2', 'wmapro', 'amr_nb', 'amr_wb', 'ac4', 'atrac3', 'atrac3p', 'ac3', 'eac3']);
const { sourceFormat } = require('./profiles');

// Classify: receives stream. Returns the calculated value for the caller.
function classify(stream) {
  const codec = stream.codec_name || '';
  // WavPack can be hybrid; absent a reliable lossless flag, retain it.
  if (codec === 'wavpack') return 'unknown';
  if (codec === 'dts') return /Master|MA\b/i.test(stream.profile || '') ? 'lossless' : 'lossy';
  if (codec.startsWith('pcm_') || LOSSLESS.has(codec)) return 'lossless';
  return LOSSY.has(codec) ? 'lossy' : 'unknown';
}

// Plan track: receives stream, capabilities, profile. See the return statements below for the result; async results are Promises.
function planTrack(stream, capabilities, profile) {
  const track = planTrackAction(stream, capabilities, profile);
  if (track.action !== 'copy') track.keepOriginal = !!profile?.keepOriginal;
  return track;
}

// Plan track action: receives stream, capabilities, profile. See the return statements below for the result; async results are Promises.
function planTrackAction(stream, capabilities, profile) {
  if (profile) return planProfileTrack(stream, capabilities, profile);
  const codec = stream.codec_name || 'unknown';
  const channels = Number(stream.channels);
  const layout = stream.channel_layout;
  const base = { index: stream.index, sourceCodec: codec, channels, layout, language: stream.tags?.language || 'und', title: stream.tags?.title || '', action: 'copy', codec, reason: '' };
  if (['dts', 'ac3', 'eac3'].includes(codec)) return { ...base, reason: 'Already compatible; copied without re-encoding.' };
  if (codec.startsWith('pcm_') && channels === 2) return { ...base, reason: 'Already PCM stereo; copied unchanged.' };
  if (!Number.isInteger(channels) || channels < 1 || !layout) return { ...base, warning: true, reason: 'Unknown channel layout; retained to prevent channel loss.' };
  const type = classify(stream);
  if (type === 'unknown') return { ...base, warning: true, reason: 'Unknown or ambiguous compression type; retained rather than guessed.' };
  if (channels === 2 && layout === 'stereo') {
    const bits = Number(stream.bits_per_raw_sample || stream.bits_per_sample) || (stream.sample_fmt?.includes('64') ? 64 : 32);
    const floating = stream.sample_fmt?.startsWith('flt') || stream.sample_fmt?.startsWith('dbl');
    const target = floating && type === 'lossless' ? (bits > 32 ? 'pcm_f64le' : 'pcm_f32le') : bits <= 16 ? 'pcm_s16le' : bits <= 24 ? 'pcm_s24le' : 'pcm_s32le';
    return { ...base, action: 'encode', codec: target, reason: 'PCM stereo avoids an additional lossy encode. Decoding cannot restore prior losses.' };
  }
  const encoder = type === 'lossless' ? 'dca' : 'ac3';
  const cap = capabilities[encoder];
  // AC-3 signals side-surround for these modes even when its encoder accepts
  // back-surround input. Preserve the original rather than relabel speakers.
  if (encoder === 'ac3' && ['quad', '5.0', '5.1'].includes(layout)) return { ...base, warning: true, reason: 'Dolby Digital would signal side-surround instead of this back-surround layout; original retained.' };
  if (!cap || !cap.layouts.includes(layout)) return { ...base, warning: true, reason: `${encoder === 'dca' ? 'DTS' : 'Dolby Digital'} cannot encode this exact layout in this build; original retained.` };
  const sourceRate = Number(stream.sample_rate);
  const rate = cap.rates.includes(sourceRate) ? sourceRate : cap.rates.includes(48000) ? 48000 : cap.rates[0];
  if (!rate) return { ...base, warning: true, reason: 'Encoder sample-rate support is unknown; original retained.' };
  return { ...base, action: 'encode', codec: encoder, sampleRate: rate, bitrate: encoder === 'dca' ? '1411200' : channels === 1 ? '192k' : channels <= 2 ? '384k' : '640k', reason: `${type === 'lossless' ? 'Lossless source → high-bitrate DTS (lossy)' : 'Lossy source → Dolby Digital'}; same channel layout.${rate !== sourceRate ? ` Resampled to ${rate} Hz.` : ''}` };
}

// Accepts source/capabilities/profile; applies exclusions, explicit rules, core preference and approved downmixing to return an action.
function planProfileTrack(stream, capabilities, profile) {
  const codec = stream.codec_name || 'unknown';
  const format = sourceFormat(stream);
  let channels = Number(stream.channels);
  let layout = stream.channel_layout || (codec.startsWith('pcm_') && channels === 2 ? 'stereo' : undefined);
  const base = { index: stream.index, sourceCodec: codec, channels, layout, language: stream.tags?.language || 'und', title: stream.tags?.title || '', action: 'copy', codec, reason: '', compatibility: 'unresolved' };
  const unresolved = reason => ({ ...base, warning: true, reason: `Unresolved compatibility: ${reason} Original retained; playback is not guaranteed.` });
  let isStereo = channels === 2 && layout === 'stereo';
  const bits = Number(stream.bits_per_raw_sample || stream.bits_per_sample) || (stream.sample_fmt?.includes('64') ? 64 : 32);
  const floating = /pcm_f|pcm_alaw|pcm_mulaw/.test(codec);
  const withinPcm = isStereo && !floating && bits <= profile.pcmBits && Number(stream.sample_rate) <= profile.pcmRate;
  const maxChannels = { dts: 6, ac3: 6, eac3: 8, dtshd: 8, truehd: 8, pcm: 2 };
  const sourceRate = Number(stream.sample_rate);
  const rateCeilings = { dts: 48000, ac3: 48000, eac3: 48000, dtshd: 192000, truehd: 192000 };
  const supported = profile.supported.includes(format) && channels > 0 && channels <= (maxChannels[format] || 8) && (format !== 'pcm' || withinPcm) && sourceRate > 0 && sourceRate <= (rateCeilings[format] || profile.pcmRate);
  const scope = isStereo ? 'stereo' : 'surround';
  const matches = profile.rules.filter(r => r.source === format && (r.scope === scope || r.scope === 'any'));
  const rule = matches.find(r => r.scope === scope) || matches[0];
  if (profile.excludedFormats?.includes(format)) return { ...base, compatibility: supported ? 'supported' : 'unresolved', warning: !supported, reason: 'Excluded from conversion by this profile; copied unchanged.' + (!supported ? ' Playback compatibility is not confirmed.' : '') };
  if (rule?.target === 'copy') return supported ? { ...base, compatibility: 'supported', reason: 'Custom keep-original rule; supported by configured playback profile.' } : unresolved('custom keep-original rule conflicts with configured capabilities.');
  const forced = rule && rule.target !== 'auto' ? rule.target : null;
  const downmix = profile.allowDownmix && profile.downmixRules?.find(r => r.source === layout);
  if (!forced && !downmix && profile.preserve && supported) return { ...base, compatibility: 'supported', reason: 'Supported by configured receiver/playback path; copied unchanged.' };
  if (!Number.isInteger(channels) || channels < 1 || !layout) return unresolved('unknown channel layout; no downmix or layout guessing allowed.');
  const core = stream.audiorityCore;
  if (format === 'dtshd' && profile.extractDtsCore && profile.allowed.includes('dts') && (!forced || forced === 'dts') && core && core.channels > 0 && core.channels <= 6 && core.sampleRate > 0 && core.sampleRate <= 48000 && core.layout && (!downmix || downmix.target === core.layout)) {
    return { ...base, action: 'extract', codec: 'dts', channels: core.channels, layout: core.layout, sourceChannels: channels, sourceLayout: layout, sampleRate: core.sampleRate, compatibility: 'target-supported', reason: `Extract existing DTS core (${core.layout}); no additional lossy encoding. HD/immersive extensions are removed.` };
  }
  if (downmix) {
    layout = downmix.target; channels = { '5.1(side)': 6, '3.1': 4, stereo: 2 }[layout]; isStereo = layout === 'stereo';
  }
  const outputBase = downmix ? { ...base, sourceChannels: base.channels, sourceLayout: base.layout, channels, layout, downmix: true } : base;
  const mixReason = downmix ? `Approved downmix ${base.layout} → ${layout}; channels combined, discrete positions reduced. ` : '';
  const type = classify(stream);
  if (type === 'unknown' && !forced) return unresolved('unknown or ambiguous compression type; add an explicit custom rule if you know this source.');
  const preference = forced || (isStereo ? profile.stereo : type === 'lossless' ? profile.lossless : profile.lossy);
  // Explicit rules never silently fall back to a different target.
  const candidates = forced ? [forced] : [...new Set([preference, ...(isStereo ? ['pcm', 'ac3', 'dts'] : type === 'lossless' ? ['dts', 'ac3'] : ['ac3', 'dts'])])];
  for (const target of candidates) {
    if (!profile.allowed.includes(target)) continue;
    const fallback = target !== preference ? `Preferred ${preference.toUpperCase()} unavailable; using ${target.toUpperCase()}. ` : '';
    if (target === 'pcm') {
      if (!isStereo) continue;
      const precision = Math.min(bits, profile.pcmBits);
      const targetCodec = precision <= 16 ? 'pcm_s16le' : 'pcm_s24le';
      const sourceRate = Number(stream.sample_rate);
      const rate = sourceRate > 0 && sourceRate <= profile.pcmRate ? sourceRate : profile.pcmRate;
      return { ...outputBase, action: 'encode', codec: targetCodec, sampleRate: rate, compatibility: 'target-supported', warning: type === 'lossless' && (bits > precision || rate !== sourceRate), reason: `${mixReason}${fallback}PCM stereo within profile limits (${precision}-bit / ${rate} Hz).${bits > precision ? ' Precision reduced to receiver limit.' : ''}${rate !== sourceRate ? ' Sample rate changed to profile limit.' : ''} Prior compression losses cannot be restored.` };
    }
    const encoder = target === 'dts' ? 'dca' : 'ac3';
    const cap = capabilities[encoder];
    if (!cap?.layouts.includes(layout) || channels > 6 || (encoder === 'ac3' && ['quad', '5.0', '5.1'].includes(layout))) continue;
    const maxRate = 48000;
    const rates = cap.rates.filter(r => r <= maxRate);
    const sourceRate = Number(stream.sample_rate);
    const rate = rates.includes(sourceRate) ? sourceRate : rates.includes(48000) ? 48000 : rates[0];
    if (!rate) continue;
    const bitrate = encoder === 'dca' ? String(profile.dtsBitrate) : `${Math.min(profile.ac3Bitrate, channels === 1 ? 192 : channels <= 2 ? 384 : 640)}k`;
    const objectLoss = ['truehd', 'eac3'].includes(codec) ? ' Any object-based metadata will not be preserved.' : '';
    return { ...outputBase, action: 'encode', codec: encoder, sampleRate: rate, bitrate, compatibility: 'target-supported', reason: `${mixReason}${fallback}${forced ? 'Custom rule: ' : ''}${target === 'dts' ? 'DTS' : 'Dolby Digital'} selected for this playback profile; ${downmix ? 'approved output layout' : 'same channel layout'}, lossy re-encoding.${rate !== sourceRate ? ` Resampled to ${rate} Hz.` : ''}${objectLoss}` };
  }
  return unresolved(`no allowed encoder can ${downmix ? 'produce the requested' : 'retain the'} ${layout} layout${forced ? ` in requested ${forced.toUpperCase()}` : ''}.`);
}

// Plan file: receives probe, capabilities, profile. See the return statements below for the result; async results are Promises.
function planFile(probe, capabilities, profile) {
  const tracks = (probe.streams || []).filter(s => s.codec_type === 'audio').map(s => planTrack(s, capabilities, profile));
  return { tracks, needsConversion: tracks.some(t => t.action !== 'copy'), warnings: [...(profile?.warnings || []), ...tracks.filter(t => t.warning).map(t => t.reason)], unresolved: tracks.some(t => t.compatibility === 'unresolved') };
}

module.exports = { classify, planTrack, planFile };