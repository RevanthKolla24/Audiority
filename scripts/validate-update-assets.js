const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Validate builder's Windows feed before uploading anything to a release.
function validateUpdateAssets(directory, version) {
  const name = `Audiority-Setup-${version}.exe`;
  const metadata = fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8');
  const required = [`version: ${version}`, `path: ${name}`, `  - url: ${name}`];
  for (const line of required) if (!metadata.split(/\r?\n/).includes(line)) throw new Error(`Windows update metadata missing ${line}`);
  const file = fs.readFileSync(path.join(directory, name));
  const digest = crypto.createHash('sha512').update(file).digest('base64');
  const hashes = [...metadata.matchAll(/^\s*sha512:\s*(\S+)\s*$/gm)].map(match => match[1]);
  if (hashes.length !== 2 || hashes.some(hash => hash !== digest)) throw new Error('Windows update checksum differs from installer.');
  if (!metadata.includes(`    size: ${file.length}`)) throw new Error('Windows update installer size differs.');
  if (!fs.statSync(path.join(directory, `${name}.blockmap`)).size) throw new Error('Windows update blockmap is empty.');
  return name;
}
if (require.main === module) console.log(`Validated Windows update: ${validateUpdateAssets(path.resolve(process.argv[2] || path.join(__dirname, '../dist')), require('../package.json').version)}`);
module.exports = { validateUpdateAssets };