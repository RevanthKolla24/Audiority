const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateUpdateAssets } = require('../scripts/validate-update-assets');

test('release gate rejects missing or renamed installers and invalid checksums', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiority-feed-'));
  try {
    const name = 'Audiority-Setup-2.0.0.exe', bytes = Buffer.from('installer');
    const digest = crypto.createHash('sha512').update(bytes).digest('base64');
    const feed = `version: 2.0.0\nfiles:\n  - url: ${name}\n    sha512: ${digest}\n    size: ${bytes.length}\npath: ${name}\nsha512: ${digest}\n`;
    fs.writeFileSync(path.join(dir, 'latest.yml'), feed);
    assert.throws(() => validateUpdateAssets(dir, '2.0.0'), /ENOENT/);
    fs.writeFileSync(path.join(dir, name), bytes);
    fs.writeFileSync(path.join(dir, name + '.blockmap'), 'map');
    assert.equal(validateUpdateAssets(dir, '2.0.0'), name);
    fs.writeFileSync(path.join(dir, name), 'modified');
    assert.throws(() => validateUpdateAssets(dir, '2.0.0'), /checksum/);
    assert.equal(require('../package.json').build.nsis.artifactName, 'Audiority-Setup-${version}.${ext}');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});