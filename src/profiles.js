/*
 * profiles.js
 * Validates user settings and resolves the entire playback path for policy.js. Guide: defaults; rules; receiver/device/connection intersection; PCM limits; source codec families.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const { receivers, devices } = require('./catalog');
const FORMATS = ['dts', 'ac3', 'pcm'];
const INPUTS = ['ac3', 'eac3', 'dts', 'dtshd', 'truehd', 'pcm', 'flac', 'alac', 'aac', 'mp3', 'opus', 'vorbis'];
const defaultSettings = () => ({ version: 1, allowedLanguages: [], keepDefaultTrack: true, keepOriginal: false, normalizeVolume: false, dialogueBoost: false, receiverId: '', advanced: false, allowed: ['dts', 'ac3', 'pcm'], preserve: true, lossless: 'dts', lossy: 'ac3', stereo: 'pcm', ac3Bitrate: 640, dtsBitrate: 1411200, pcmBits: 24, pcmRate: 48000, rules: [], extractDtsCore: true, allowDownmix: false, downmixRules: [{ source: '7.1', target: '5.1(side)' }], excludedFormats: [], platform: 'local', deviceId: 'custom', player: '', connection: 'hdmi', tv: '', passthrough: 'unknown', pathConfirmed: false, pathCodecs: ['ac3', 'pcm'] });
// Validate settings: receives value. Returns checked data or throws; do not trust saved/input JSON blindly.
function validateLanguages(value) {
  if (!Array.isArray(value) || value.length > 200 || value.some(code => typeof code !== 'string' || !/^[a-z]{3}$/i.test(code))) throw new Error('Languages must be three-letter codes such as eng, jpn.');
  return [...new Set(value.map(code => code.toLowerCase()))];
}
function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid playback settings.');
  const v = { ...defaultSettings(), ...value };
  v.allowedLanguages = validateLanguages(value.allowedLanguages ?? []);
  v.keepDefaultTrack = value.keepDefaultTrack ?? true;
  if (typeof v.keepDefaultTrack !== 'boolean') throw new Error('Invalid keepDefaultTrack.');
  v.normalizeVolume = value.normalizeVolume ?? false;
  v.dialogueBoost = value.dialogueBoost ?? false;
  if (typeof v.dialogueBoost !== "boolean") throw new Error("Invalid dialogueBoost.");
  v.keepOriginal = value.keepOriginal ?? false;
  if (typeof v.keepOriginal !== 'boolean') throw new Error('Invalid keepOriginal.');
  if (typeof v.normalizeVolume !== 'boolean') throw new Error('Invalid normalizeVolume.');
  const oneOf = (key, choices) => { if (!choices.includes(v[key])) throw new Error(`Invalid ${key}.`); };
  if (v.version !== 1) throw new Error('Unsupported settings version.');
  if (v.receiverId && !receivers.some(r => r.id === v.receiverId)) throw new Error('Unknown receiver.');
  for (const key of ['advanced', 'preserve', 'pathConfirmed', 'extractDtsCore', 'allowDownmix']) if (typeof v[key] !== 'boolean') throw new Error(`Invalid ${key}.`);
  if (!Array.isArray(v.excludedFormats) || v.excludedFormats.some(f => !INPUTS.includes(f)) || new Set(v.excludedFormats).size !== v.excludedFormats.length) throw new Error('Invalid excluded formats.');
  const downmixSources = ['7.1', '7.1(wide)', '7.1(wide-side)', '6.1', '6.1(back)', '6.1(front)', '5.1', '5.1(side)'];
  if (!Array.isArray(v.downmixRules) || v.downmixRules.length > downmixSources.length) throw new Error('Invalid downmix rules.');
  const downmixSeen = new Set();
  v.downmixRules = v.downmixRules.map(rule => {
    if (!rule || !downmixSources.includes(rule.source) || !['5.1(side)', '3.1', 'stereo'].includes(rule.target) || downmixSeen.has(rule.source) || (rule.source.startsWith('5.1') && rule.target === '5.1(side)')) throw new Error('Invalid or duplicate downmix rule.');
    downmixSeen.add(rule.source);
    return { source: rule.source, target: rule.target };
  });
  if (!v.receiverId && !v.advanced) throw new Error('Select a receiver or enable custom setup.');
  for (const key of ['allowed', 'pathCodecs']) {
    const choices = key === 'allowed' ? FORMATS : ['ac3', 'eac3', 'dts', 'dtshd', 'truehd', 'pcm'];
    if (!Array.isArray(v[key]) || !v[key].length || v[key].some(c => !choices.includes(c)) || new Set(v[key]).size !== v[key].length) throw new Error(`Select valid ${key} formats.`);
  }
  for (const key of ['lossless', 'lossy', 'stereo']) oneOf(key, FORMATS);
  oneOf('ac3Bitrate', [192, 384, 448, 640]); oneOf('dtsBitrate', [768000, 1411200]);
  oneOf('pcmBits', [16, 24]); oneOf('pcmRate', [44100, 48000, 96000, 192000]);
  oneOf('platform', ['local', 'plex', 'jellyfin', 'other']); oneOf('connection', ['hdmi', 'arc', 'earc', 'optical', 'coaxial', 'unknown']);
  oneOf('passthrough', ['enabled', 'disabled', 'unknown']);
  if (!devices.some(d => d.id === v.deviceId)) throw new Error('Unknown playback device.');
  for (const key of ['player', 'tv']) if (typeof v[key] !== 'string' || v[key].length > 160) throw new Error(`Invalid ${key}.`);
  if (!Array.isArray(v.rules) || v.rules.length > 40) throw new Error('Too many custom rules.');
  const seen = new Set();
  v.rules = v.rules.map(rule => {
    if (!rule || !INPUTS.includes(rule.source) || !['any', 'stereo', 'surround'].includes(rule.scope) || !['auto', 'copy', ...FORMATS].includes(rule.target)) throw new Error('Invalid custom rule.');
    const key = `${rule.source}/${rule.scope}`;
    if (seen.has(key)) throw new Error('Duplicate custom rule.'); seen.add(key);
    return { source: rule.source, scope: rule.scope, target: rule.target };
  });
  if (v.receiverId && receivers.find(r => r.id === v.receiverId).status === 'directory-only' && !v.advanced) throw new Error('This receiver has no verified preset. Enable Advanced and confirm its formats.');
  // Whitelist stored properties: never trust renderer-supplied effective capabilities.
  return Object.fromEntries([...Object.keys(defaultSettings()), 'normalizeVolume', 'keepOriginal', 'allowedLanguages', 'keepDefaultTrack'].map(key => [key, v[key]]));
}
// Accepts profile settings; returns effective formats/limits and warnings for receiver, player and connection together.
function resolveProfile(settings) {
  const s = validateSettings(settings);
  const receiver = receivers.find(r => r.id === s.receiverId);
  const device = devices.find(d => d.id === s.deviceId);
  const warnings = [];
  const receiverCodecs = s.advanced ? s.allowed : receiver.codecs;
  let pathCodecs = s.pathConfirmed ? s.pathCodecs : device.codecs || ['pcm'];
  if (!s.pathConfirmed) warnings.push('Playback app/file support is not confirmed. Device specifications are only an output-format upper bound.');
  if (!s.pathConfirmed && !device.codecs) warnings.push('Unknown playback device: only stereo PCM is assumed; confirm formats to enable surround conversion.');
  if (!s.advanced && receiver?.status !== 'documented') warnings.push(receiver.note);
  if (s.advanced) warnings.push('Custom receiver capabilities are user-confirmed, not manufacturer-verified.');
  if (s.passthrough !== 'enabled') {
    pathCodecs = pathCodecs.filter(c => c === 'pcm');
    warnings.push('Passthrough is disabled or unknown: compressed surround output is not assumed. Enable passthrough or verify the player’s output mode.');
  }
  if (['arc', 'earc'].includes(s.connection)) {
    warnings.push('TV passthrough is not inferred from its name. Confirm supported formats for the complete TV path.');
    if (!s.pathConfirmed) pathCodecs = pathCodecs.filter(c => c === 'pcm');
  }
  if (s.connection === 'unknown') { pathCodecs = pathCodecs.filter(c => c === 'pcm'); warnings.push('Unknown connection: only stereo PCM assumed.'); }
  if (['arc', 'optical', 'coaxial'].includes(s.connection)) pathCodecs = pathCodecs.filter(c => ['ac3', 'dts', 'pcm'].includes(c));
  if (!s.advanced && receiver.connections.length && !receiver.connections.includes(s.connection)) {
    pathCodecs = []; warnings.push('Selected connection is not in this receiver preset. Confirm a custom setup before converting.');
  }
  const supported = receiverCodecs.filter(c => pathCodecs.includes(c));
  const allowed = FORMATS.filter(c => supported.includes(c) && (!s.advanced || s.allowed.includes(c)));
  if (!allowed.length) warnings.push('No safe output format is enabled for this playback path. Tracks will be flagged unresolved.');
  const pcmBits = Math.min(s.pcmBits, s.advanced ? s.pcmBits : receiver.pcmBits);
  const pcmRate = Math.min(s.pcmRate, s.advanced ? s.pcmRate : receiver.pcmRate, ['arc', 'optical', 'coaxial', 'unknown'].includes(s.connection) ? 48000 : 192000);
  return { settings: s, dialogueBoost: s.dialogueBoost, allowedLanguages: s.allowedLanguages, keepDefaultTrack: s.keepDefaultTrack, keepOriginal: s.keepOriginal, name: receiver?.name || 'Custom receiver', supported, allowed, preserve: s.preserve, extractDtsCore: s.extractDtsCore, allowDownmix: s.allowDownmix, downmixRules: s.downmixRules, excludedFormats: s.excludedFormats, lossless: s.lossless, lossy: s.lossy, stereo: s.stereo, rules: s.advanced ? s.rules : [], ac3Bitrate: s.ac3Bitrate, dtsBitrate: s.dtsBitrate, pcmBits, pcmRate, warnings };
}
// Source format: receives stream. Returns the calculated value for the caller.
function sourceFormat(stream) {
  if (stream.codec_name?.startsWith('pcm_')) return 'pcm';
  if (stream.codec_name === 'dts' && /HD|Master|HRA|Express|ES|96\/24/i.test(stream.profile || '')) return 'dtshd';
  return stream.codec_name;
}
module.exports = { defaultSettings, validateSettings, resolveProfile, sourceFormat, FORMATS, INPUTS };
module.exports.validateLanguages = validateLanguages;
