const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('optional processing controls expose saved choices without changing processing defaults', () => {
  const html = read('src/ui/index.html'), onboarding = read('src/ui/onboarding.js');
  assert.match(html, /Optional audio processing — changes the sound/);
  assert.doesNotMatch(html, /Normalize Volume &amp; Boost Dialog/);
  assert.match(onboarding, /draft\.dialogueBoost = \$\('profile-dialogue-boost'\)\.checked/);
  assert.match(onboarding, /\$\('profile-dialogue-boost'\)\.checked = draft\.dialogueBoost \?\? false/);
  assert.equal(require('../src/profiles').defaultSettings().dialogueBoost, false);
  assert.equal(require('../src/app-state').preferencesDefaults().normalizeVolume, false);
});

test('inactive retention/layout controls preserve values and explain which policy owns them', () => {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: true, disabled: false, textContent: '', querySelectorAll: () => controls });
    return nodes.get(id);
  };
  const controls = [{ disabled: false }, { disabled: false }];
  const source = read('src/ui/onboarding.js');
  const context = vm.createContext({ $ });
  vm.runInContext(source.slice(source.indexOf('function updatePolicyControls('), source.indexOf("for (const id of ['retention-mode'")), context);
  $('retention-mode').value = 'replace'; $('conversion-mode').value = 'playback'; $('layout-policy').value = 'fixed';
  vm.runInContext('updatePolicyControls()', context);
  assert.equal($('profile-keep-original').disabled, true);
  assert.equal($('profile-keep-original').checked, true);
  assert.match($('retention-help').textContent, /does not delete/);
  assert.ok(controls.every(control => control.disabled));
  assert.match($('layout-rules-help').textContent, /stored but inactive/);
  $('retention-mode').value = 'inherit'; $('conversion-mode').value = 'manual';
  vm.runInContext('updatePolicyControls()', context);
  assert.equal($('profile-keep-original').disabled, false);
  assert.ok(controls.every(control => !control.disabled));
  $('conversion-mode').value = 'dts-core';
  vm.runInContext('updatePolicyControls()', context);
  assert.equal($('allow-downmix').disabled, true);
});

test('Auto-Trash enabling requires explicit confirmation before settings are saved', async () => {
  const source = read('src/main.js');
  const code = source.slice(source.indexOf("handle('save-app-settings',"), source.indexOf("  handle('get-statistics',"));
  // Stop at persistence: no filesystem or Electron process required.
  for (const response of [0, 1]) {
    let handler, prompted = false, saved = false;
    const context = vm.createContext({
      handle: (_name, fn) => { handler = fn; }, running: false, importing: false, profileBusy: false, appStateBusy: false,
      outputDirectory: '', preferences: { trashOriginals: false }, queueQuitPending: false, window: {},
      validatePreferences: value => value,
      dialog: { showMessageBox: async (_window, options) => {
        prompted = true; assert.equal(options.defaultId, 0); assert.match(options.message, /higher-quality audio/); return { response };
      } }, watcher: { reset() {} }, app: { getPath: () => '/unused' },
      saveState: async () => { saved = true; throw new Error('reached save'); }
    });
    vm.runInContext(code, context);
    await assert.rejects(handler({ trashOriginals: true }), response ? /reached save/ : /not enabled/);
    assert.equal(prompted, true); assert.equal(saved, response === 1);
    assert.equal(context.appStateBusy, false);
  }
});