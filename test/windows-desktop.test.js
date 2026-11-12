const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { windowsMenu } = require('../src/windows-menu');
const root = path.join(__dirname, '..');

test('Windows native menus route actions without reload/devtools or bypassing conversion guards', () => {
  const calls = [], menu = windowsMenu(value => calls.push(value));
  const entries = menu.flatMap(item => item.submenu);
  for (const entry of entries) entry.click?.();
  assert.deepEqual(calls, ['add-files', 'add-folder', 'new-profile', 'settings', 'queue', 'statistics']);
  assert.equal(new Set(entries.filter(item => item.accelerator).map(item => item.accelerator)).size, 6);
  assert.ok(!entries.some(item => ['reload', 'forceReload', 'toggleDevTools'].includes(item.role)));
  assert.ok(entries.some(item => item.role === 'quit'));
});

test('Windows packaging preserves updater configuration and includes explicit installer DPI settings', () => {
  const config = require('../package.json');
  const include = fs.readFileSync(path.join(root, config.build.nsis.include), 'utf8');
  assert.match(include, /^ManifestDPIAware true$/m);
  assert.match(include, /SetFont "Segoe UI" 10/);
  assert.equal(config.build.nsis.artifactName, 'Audiority-Setup-${version}.${ext}');
  assert.match(config.scripts['dist:win'], /prepare:icons/);
});

test('Windows icon contains small, scaled and high-resolution PNG representations', () => {
  const bytes = fs.readFileSync(path.join(root, 'build/icon.ico'));
  assert.equal(bytes.readUInt16LE(2), 1);
  const sizes = [];
  for (let i = 0; i < bytes.readUInt16LE(4); i++) {
    const entry = 6 + i * 16, size = bytes[entry] || 256;
    assert.equal(bytes[entry + 1] || 256, size);
    const length = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12);
    assert.ok(offset + length <= bytes.length);
    assert.equal(bytes.subarray(offset + 1, offset + 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(offset + 16), size);
    assert.equal(bytes.readUInt32BE(offset + 20), size);
    sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 128, 256]);
});