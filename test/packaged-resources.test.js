const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const asar = require('@electron/asar');
const vm = require('node:vm');
const { validatePackagedApp } = require('../scripts/validate-packaged-app');

test('packaged resource lookups use host-native paths including nested UI and assets on Windows', async () => {
  const source = await fs.readFile(path.join(__dirname, '../scripts/validate-packaged-app.js'), 'utf8');
  for (const hostPath of [path.posix, path.win32]) {
    const lookups = [], tools = [], archive = hostPath.join('dist', 'win-unpacked', 'resources', 'app.asar');
    const context = vm.createContext({ module: { exports: {} }, __dirname,
      require: name => {
        if (name === 'node:path') return hostPath;
        if (name === 'node:fs') return { readFileSync: () => 'Application license' };
        if (name === '../package.json') return { version: '1.5.0' };
        if (name === './prepare-tools') return { validateTools: (...args) => tools.push(args) };
        if (name === '@electron/asar') return { extractFile: (actualArchive, file) => {
          assert.equal(actualArchive, archive);
          // Model the installed ASAR reader's native-separator traversal.
          assert.equal(file, hostPath.normalize(file), `Non-native archive path: ${file}`);
          lookups.push(file);
          return Buffer.from(file === 'package.json' ? '{"version":"1.5.0"}' : 'resource');
        } };
        throw new Error(`Unexpected dependency: ${name}`);
      }
    });
    vm.runInContext(source, context);
    assert.equal(context.module.exports.validatePackagedApp('win', 'dist'), hostPath.join('dist', 'win-unpacked', 'resources'));
    assert.ok(lookups.includes(hostPath.join('src', 'ui', 'index.html')));
    assert.ok(lookups.includes(hostPath.join('src', 'assets', 'logo.png')));
    assert.equal(tools.length, 1);
  }
});

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
    await fs.writeFile(path.join(source, 'src/ui/index.html'), '');
    await asar.createPackage(source, path.join(resources, 'app.asar'));
    asar.uncacheAll();
    assert.throws(() => validatePackagedApp('win', dir), /Empty packaged resource: src\/ui\/index.html/);
    await fs.unlink(path.join(source, 'src/ui/index.html'));
    await asar.createPackage(source, path.join(resources, 'app.asar'));
    asar.uncacheAll();
    assert.throws(() => validatePackagedApp('win', dir), /not found in this archive/);
  } finally { asar.uncacheAll(); await fs.rm(dir, { recursive: true, force: true }); }
});