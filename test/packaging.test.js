const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { build, scripts } = require('../package.json');

test('installer targets use explicit agreements and bundle prepared tools', async () => {
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  await validateConfiguration(build, { add() {} });
  assert.deepEqual(build.mac.target, ['dmg', 'zip']);
  assert.deepEqual(build.publish, [{ provider: 'github', owner: 'RevanthKolla24', repo: 'Audiority' }]);
  assert.deepEqual(build.win.target, ['nsis']);
  assert.equal(build.nsis.perMachine, true);
  assert.equal(build.nsis.oneClick, false);
  assert.equal(build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(build.nsis.license, 'build/license.txt');
  assert.equal(build.dmg.license, build.nsis.license);
  assert.equal(build.icon, 'build/icon.png');
  assert.ok(fs.existsSync(path.join(root, build.icon)));
  assert.ok(fs.readFileSync(path.join(root, build.dmg.license), 'utf8').includes('MIT License'));
  assert.ok(build.mac.extraResources.some(r => r.from === 'legal-tools' && r.to === 'tools'));
  assert.ok(build.win.extraResources.some(r => r.from === 'legal-tools-win' && r.to === 'tools'));
  assert.ok(build.extraResources.some(r => r.from === build.dmg.license && r.to === 'license.txt'));
  assert.ok(scripts.pack.startsWith('npm run prepare:tools &&'));
  assert.ok(scripts['dist:mac'].startsWith('npm run prepare:tools -- mac &&'));
  assert.ok(scripts['dist:win'].startsWith('npm run prepare:tools -- win &&'));
});

test('release validation rejects missing notices and wrong-platform tools without staging files', () => {
  const os = require('node:os');
  const { validateTools } = require('../scripts/prepare-tools');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audiority-release-tools-'));
  try {
    assert.throws(() => validateTools('win', directory), /target-specific license/);
    fs.writeFileSync(path.join(directory, 'ffmpeg-license.txt'), 'Test license notice '.repeat(20));
    fs.writeFileSync(path.join(directory, 'ffmpeg.exe'), Buffer.alloc(64));
    assert.throws(() => validateTools('win', directory), /Windows PE x64/);
    fs.writeFileSync(path.join(directory, 'ffmpeg'), Buffer.alloc(64));
    assert.throws(() => validateTools('mac', directory), /Mach-O arm64/);
    assert.throws(() => validateTools('linux', directory), /Unsupported target/);
    assert.ok(!fs.existsSync(path.join(directory, 'tools')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});