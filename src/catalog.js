/*
 * catalog.js
 * Offline receiver/device directory read by profile resolution and onboarding. Guide: format names; reviewed/user-reported presets; unverified directory models. Listing a model does not certify compatibility.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
// Offline directory. Only model-specific reviewed documentation enables presets.
// Directory-only entries require explicit user capabilities; never inherit by brand.
const modern = ['ac3', 'eac3', 'dts', 'dtshd', 'truehd', 'pcm'];
const receivers = [];
const directories = {
  Bose: ['Lifestyle 12', 'Lifestyle 18', 'Lifestyle 28', 'Lifestyle 30 Series II', 'Lifestyle 35', 'Lifestyle 38', 'Lifestyle 48', 'Lifestyle 50', 'Lifestyle 535', 'Lifestyle 600', 'Lifestyle 650', 'Lifestyle V10', 'Lifestyle V20', 'Lifestyle V30', 'Lifestyle V25', 'Lifestyle V35'],
  Denon: ['AVR-3801', 'AVR-A1H', 'AVR-A10H', 'AVR-S540BT', 'AVR-S570BT', 'AVR-S650H', 'AVR-S660H', 'AVR-S670H', 'AVR-S750H', 'AVR-S760H', 'AVR-S770H', 'AVR-S960H', 'AVR-S970H', 'AVR-X1600H', 'AVR-X1700H', 'AVR-X1800H', 'AVR-X2500H', 'AVR-X2600H', 'AVR-X2700H', 'AVR-X2800H', 'AVR-X3500H', 'AVR-X3600H', 'AVR-X3700H', 'AVR-X3800H', 'AVR-X4500H', 'AVR-X4700H', 'AVR-X4800H', 'AVR-X6500H', 'AVR-X6700H', 'AVR-X6800H', 'AVR-X8500H', 'AVR-X8500HA'],
  Marantz: ['CINEMA 30', 'CINEMA 40', 'CINEMA 50', 'CINEMA 60', 'CINEMA 70s', 'NR1509', 'NR1510', 'NR1609', 'NR1710', 'NR1711', 'SR5013', 'SR5014', 'SR5015', 'SR6013', 'SR6014', 'SR6015', 'SR7013', 'SR7015', 'SR8015'],
  Onkyo: ['TX-NR509', 'TX-NR6100', 'TX-NR616', 'TX-NR626', 'TX-NR636', 'TX-NR646', 'TX-NR656', 'TX-NR676', 'TX-NR686', 'TX-NR696', 'TX-NR7100', 'TX-RZ50', 'TX-RZ70', 'TX-SR308', 'TX-SR3100', 'TX-SR393', 'TX-SR494'],
  Pioneer: ['VSX-534', 'VSX-834', 'VSX-935', 'VSX-1021', 'VSX-1131', 'VSX-LX102', 'VSX-LX103', 'VSX-LX104', 'VSX-LX105', 'VSX-LX305', 'VSX-LX505'],
  Sony: ['STR-AN1000', 'STR-DH510', 'STR-DH520', 'STR-DH550', 'STR-DH590', 'STR-DH750', 'STR-DH770', 'STR-DH790', 'STR-DN1040', 'STR-DN1050', 'STR-DN1060', 'STR-DN1070', 'STR-DN1080'],
  Yamaha: ['RX-A2A', 'RX-A4A', 'RX-A6A', 'RX-A8A', 'RX-A680', 'RX-A780', 'RX-A880', 'RX-A1080', 'RX-A2080', 'RX-A3080', 'RX-V4A', 'RX-V6A', 'RX-V385', 'RX-V485', 'RX-V585', 'RX-V685', 'RX-V779', 'TSR-700']
};
const idFor = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
for (const [brand, models] of Object.entries(directories)) {
  for (const model of models) receivers.push({ id: idFor(`${brand} ${model}`), name: `${brand} ${model}`, aliases: [model], status: 'directory-only', codecs: [], pcmBits: 24, pcmRate: 48000, pcmChannels: 2, connections: [], sources: [], note: 'Model directory entry only. Input capabilities have not been reviewed. Enable Advanced and confirm supported formats before using this model.' });
}
// Reviewed: receives name, codecs, source, extra = {}. See the return statements below for the result; async results are Promises.
function reviewed(name, codecs, source, extra = {}) {
  Object.assign(receivers.find(r => r.name === name), { status: 'documented', codecs, pcmBits: 24, pcmRate: 192000, pcmChannels: 8, connections: ['hdmi', 'earc', 'arc', 'optical'], sources: [source], note: 'Documented digital input support; app, firmware, connection and TV passthrough still matter.', ...extra });
}
for (const model of ['AVR-X1800H', 'AVR-X2800H', 'AVR-X3800H', 'AVR-X4800H', 'AVR-A10H']) {
  reviewed(`Denon ${model}`, modern, `https://manuals.denon.com/${model.replace(/-/g, '')}/NA/EN/GFNFSYdtphpnek.php`);
}
for (const model of ['CINEMA 50', 'CINEMA 60', 'CINEMA 70s']) {
  reviewed(`Marantz ${model}`, modern, `https://manuals.marantz.com/${model.replace(/ /g, '')}/NA/EN/GFNFSYdtphpnek.php`);
}
// The reviewed Sony page is troubleshooting guidance, not a complete input
// format table. Keep this entry unverified until that table has been reviewed.
Object.assign(receivers.find(r => r.name === 'Sony STR-DH790'), { sources: ['https://helpguide.sony.net/ha/strdh79/v1/en/contents/TP0001553110.html'] });
reviewed('Bose Lifestyle 50', ['ac3', 'pcm'], 'https://products.bose.com/pdf/customer_service/owners/og_ls50.pdf', { pcmChannels: 2, pcmBits: 16, pcmRate: 48000, connections: ['coaxial'], note: 'Manual explicitly excludes DTS and describes coaxial digital input. PCM limits are conservative defaults, not a verified maximum.' });
Object.assign(receivers.find(r => r.name === 'Bose Lifestyle V20'), { status: 'user-reported', codecs: ['dts', 'ac3', 'pcm'], pcmBits: 16, pcmRate: 48000, pcmChannels: 2, connections: ['hdmi', 'optical'], sources: ['https://assets.bose.com/content/dam/Bose_DAM/Web/consumer_electronics/global/products/speakers/ls_v10_system/pdf/opg_en_v30_v20_v10.pdf'], note: 'DTS / AC-3 / PCM stereo reported by the project owner. Linked manual is a reference, not verification of all limits. Conservative PCM 16-bit/48 kHz; confirm on your system.' });
receivers.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

const devices = [
  { id: 'apple-tv-4k', name: 'Apple TV 4K', codecs: ['ac3', 'eac3', 'pcm'], status: 'documented-output', sources: ['https://support.apple.com/en-us/102218'], note: 'Select Dolby Digital 5.1 under Audio Format for older receivers. This profile avoids DTS bitstream assumptions; app file decoding varies.' },
  ...['Amazon Fire TV (specify model)', 'Chromecast / Google TV (specify model)', 'Google TV Streamer', 'LG webOS TV (specify model)', 'macOS computer', 'Roku (specify model)', 'Samsung Tizen TV (specify model)', 'Windows computer', 'Xbox (specify model)'].map(name => ({ id: idFor(name), name, codecs: null, status: 'unknown', sources: [], note: 'Model, OS, application and audio-output capabilities need confirmation. No surround support assumed.' })),
  { id: 'shield-tv', name: 'NVIDIA SHIELD TV', codecs: modern, status: 'documented-output', sources: ['https://www.nvidia.com/en-us/shield/shield-tv/', 'https://www.nvidia.com/en-eu/shield/support/shield-tv/'], note: 'HDMI bitstream output requires enabled passthrough in the device and player. App/container support is not guaranteed.' },
  { id: 'shield-tv-pro', name: 'NVIDIA SHIELD TV Pro', codecs: modern, status: 'documented-output', sources: ['https://www.nvidia.com/en-us/shield/shield-tv-pro/', 'https://www.nvidia.com/en-us/shield/support/shield-tv-pro/'], note: 'HDMI passthrough depends on player/settings. PCM file decoding and passthrough are different; verify client playback.' },
  { id: 'custom', name: 'Other / custom device', codecs: null, status: 'unknown', sources: [], note: 'Confirm your playback path below.' }
].sort((a, b) => a.name.localeCompare(b.name, 'en'));
module.exports = { receivers, devices };