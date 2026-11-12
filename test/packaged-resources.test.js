const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const asar = require('@electron/asar');
const { validatePackagedApp } = require('../scripts/validate-packaged-app');

test('packaged resource gate rejects unsupported targets, missing assets and stale versions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-packaged-'));
  try {
    assert.throws(() => validatePackagedApp('linux', dir), /Expected mac or win/);
    assert.throws(() => validatePackagedApp('mac', dir), /found 0/);
    const source = path.join(dir, 'source'), resources = path.join(dir, 'win-unpacked', 'resources');
    await fs.mkdir(source); await fs.mkdir(resources, { recursive: true });
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    await asar.createPackage(source, path.join(resources, 'app.asar'));
    assert.throws(() => validatePackagedApp('win', dir));
    for (const file of ['src/main.js', 'src/preload.js', 'src/windows-menu.js', 'src/ui/index.html', 'src/ui/platform.js', 'src/ui/windows-desktop.js', 'src/ui/windows-desktop.css', 'src/assets/logo.png']) {
      await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
      await fs.writeFile(path.join(source, file), 'fixture');
    }
    await asar.createPackage(source, path.join(resources, 'app.asar'));
    asar.uncacheAll();
    assert.throws(() => validatePackagedApp('win', dir), /version does not match/);
  } finally { asar.uncacheAll(); await fs.rm(dir, { recursive: true, force: true }); }
});