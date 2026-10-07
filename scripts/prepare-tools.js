const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// Validate in place; builder selects each target's resources without host staging.
function validateTools(target, directory = path.join(__dirname, '..', target === 'mac' ? 'legal-tools' : 'legal-tools-win')) {
  if (!['mac', 'win'].includes(target)) throw new Error(`Unsupported target: ${target}`);
  const license = path.join(directory, 'ffmpeg-license.txt');
  if (!fs.existsSync(license) || fs.readFileSync(license, 'utf8').trim().length < 100) throw new Error(`Missing or empty target-specific license: ${license}. Supply notices from this distribution; the other platform's license is not assumed to apply.`);
  for (const name of ['ffmpeg', 'ffprobe']) {
    const binary = path.join(directory, name + (target === 'win' ? '.exe' : ''));
    const data = fs.readFileSync(binary);
    if (target === 'mac') {
      if (data.length < 8 || data.readUInt32LE(0) !== 0xfeedfacf || data.readUInt32LE(4) !== 0x0100000c) throw new Error(`${binary} must be Mach-O arm64.`);
    } else {
      const offset = data.length >= 64 ? data.readUInt32LE(0x3c) : -1;
      if (data.toString('ascii', 0, 2) !== 'MZ' || offset < 0 || offset + 6 > data.length || data.toString('ascii', offset, offset + 4) !== 'PE\0\0' || data.readUInt16LE(offset + 4) !== 0x8664) throw new Error(`${binary} must be Windows PE x64.`);
    }
    const native = (target === 'mac' && process.platform === 'darwin' && process.arch === 'arm64') || (target === 'win' && process.platform === 'win32' && process.arch === 'x64');
    // Inspect foreign binaries without executing them; native runtime testing remains required.
    const configuration = native ? execFileSync(binary, ['-version'], { encoding: 'utf8', timeout: 30000 }) : data.toString('latin1');
    if (!configuration.includes('--enable-')) throw new Error(`Missing build configuration: ${binary}`);
    if (configuration.includes('--enable-nonfree')) throw new Error(`Nonredistributable --enable-nonfree build: ${binary}`);
    console.log(`Validated ${target}/${name}: ${native ? 'native execution' : 'header and embedded configuration only'}`);
  }
  console.warn(`${target}: license presence is not legal certification. Review matching source and third-party notices before distribution.`);
}
if (require.main === module) {
  try { for (const target of process.argv[2] ? [process.argv[2]] : ['mac', 'win']) validateTools(target); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validateTools };