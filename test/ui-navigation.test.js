const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Queue navigation preserves existing profile drafts and blocks leaving until save/cancel', () => {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: '', setAttribute() {}, removeAttribute() {} }); return nodes.get(id); };
  $('workspace').hidden = true;
  $('view-title').textContent = 'Edit playback profile';
  const context = vm.createContext({ $, profileEditing: true, currentPage: 'queue', savedSettings: {}, render() {} });
  const source = read('src/ui/pages.js');
  vm.runInContext(source.slice(source.indexOf('function showPage('), source.indexOf("\nfor (const name of ['queue'")), context);
  vm.runInContext("showPage('queue')", context);
  assert.equal($('setup').hidden, false);
  assert.equal($('workspace').hidden, true);
  assert.equal($('view-title').textContent, 'Edit playback profile');
  assert.throws(() => vm.runInContext("showPage('settings')", context), /Save or cancel/);
  context.profileEditing = false;
  vm.runInContext("showPage('settings')", context);
  assert.equal(context.currentPage, 'settings');
});

test('latest navigation wins over delayed page responses and stale errors', async () => {
  const requests = [], shown = [], filled = [];
  const context = vm.createContext({ profileEditing: false,
    api: { getAppSettings: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
      getStatistics: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) },
    fillPreferences: data => filled.push(data), renderStatistics: data => filled.push(data),
    showPage: page => shown.push(page) });
  const source = read('src/ui/pages.js');
  vm.runInContext(source.slice(source.indexOf('let navigationVersion'), source.indexOf("\nfor (const name of ['queue'")), context);
  const settings = vm.runInContext("navigatePage('settings')", context);
  await vm.runInContext("navigatePage('queue')", context);
  requests.shift().resolve('stale settings'); await settings;
  assert.deepEqual(shown, ['queue']); assert.deepEqual(filled, []);
  const stale = vm.runInContext("navigatePage('settings')", context);
  const latest = vm.runInContext("navigatePage('statistics')", context);
  requests.shift().reject(new Error('outdated failure')); await stale;
  requests.shift().resolve('current statistics'); await latest;
  assert.deepEqual(shown, ['queue', 'statistics']);
  assert.deepEqual(filled, ['current statistics']);
  const failed = vm.runInContext("navigatePage('settings')", context);
  requests.shift().reject(new Error('current failure'));
  await assert.rejects(failed, /current failure/);
});

test('pending navigation never replaces a profile draft or clears it with a Queue click', async () => {
  let resolve, calls = 0;
  const context = vm.createContext({ profileEditing: false,
    api: { getAppSettings: () => { calls++; return new Promise(done => { resolve = done; }); } },
    fillPreferences() { throw new Error('Must not overwrite preferences'); },
    showPage() { throw new Error('Must not replace profile editor'); } });
  const source = read('src/ui/pages.js');
  vm.runInContext(source.slice(source.indexOf('let navigationVersion'), source.indexOf("\nfor (const name of ['queue'")), context);
  const pending = vm.runInContext("navigatePage('settings')", context);
  context.profileEditing = true;
  resolve({}); await pending;
  await vm.runInContext("navigatePage('queue')", context);
  await assert.rejects(vm.runInContext("navigatePage('settings')", context), /Save or cancel/);
  assert.equal(calls, 1);
});

for (const target of ['settings', 'statistics']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`direct Queue transitions invalidate pending ${target} ${outcome} responses`, async () => {
      const requests = [], filled = [];
      const nodes = new Map();
      const $ = id => {
        if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: '', setAttribute() {}, removeAttribute() {} });
        return nodes.get(id);
      };
      const request = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
      const context = vm.createContext({ $, profileEditing: false, currentPage: 'queue', savedSettings: {}, render() {},
        api: { getAppSettings: request, getStatistics: request },
        fillPreferences: data => filled.push(data), renderStatistics: data => filled.push(data) });
      const source = read('src/ui/pages.js');
      vm.runInContext(source.slice(source.indexOf('function showPage('), source.indexOf("\nfor (const name of ['queue'")), context);
      const pending = vm.runInContext(`navigatePage('${target}')`, context);
      // Windows import commands and profile entry/exit use direct showPage calls.
      vm.runInContext("showPage('queue')", context);
      context.profileEditing = true;
      context.profileEditing = false;
      requests[0][outcome](outcome === 'reject' ? new Error('obsolete request') : {});
      await pending;
      assert.equal(context.currentPage, 'queue');
      assert.deepEqual(filled, []);
    });
  }
}

for (const transition of ['none', 'edit', 'navigate', 'reload']) {
  test(`settings save responses respect newer state: ${transition}`, async () => {
    const nodes = new Map(), filled = [];
    const $ = id => {
      if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, disabled: false, textContent: '', handlers: {},
        addEventListener(event, handler) { this.handlers[event] = handler; } });
      return nodes.get(id);
    };
    let resolve, pending, calls = 0;
    const context = vm.createContext({ $, navigationVersion: 0, profileEditing: false,
      preferencesData: { preferences: {} }, preferenceBooleans: [],
      api: { saveAppSettings() { calls++; return new Promise(done => { resolve = done; }); } },
      safe: action => { pending = action(); return pending; }, fillPreferences: data => filled.push(data) });
    const source = read('src/ui/pages.js');
    vm.runInContext(source.slice(source.indexOf('let preferencesEditVersion'), source.indexOf("$('settings-pick-output')")), context);
    const submit = () => $('app-settings-form').handlers.submit({ preventDefault() {} });
    submit();
    const save = pending;
    submit(); // A keyboard submission must not start a second overlapping save.
    assert.equal(calls, 1);
    if (transition === 'edit') {
      $('pref-outputSuffix').value = '-new-draft';
      $('app-settings-form').handlers.input();
    }
    if (transition === 'navigate') context.navigationVersion++;
    if (transition === 'reload') context.preferencesData = { preferences: {} };
    resolve({ preferences: { outputSuffix: '-submitted' } });
    await save;
    assert.equal(filled.length, transition === 'none' ? 1 : 0);
    assert.equal($('settings-save').disabled, false);
    if (transition === 'edit') {
      assert.equal($('pref-outputSuffix').value, '-new-draft');
      assert.match($('settings-result').textContent, /newer edits are not saved/);
    }
    if (['navigate', 'reload'].includes(transition)) assert.equal($('settings-result').textContent, '');
  });
}

test('offscreen queue renders refresh busy controls without touching queue cards', () => {
  const nodes = new Map();
  const $ = id => { assert.notEqual(id, 'queue'); if (!nodes.has(id)) nodes.set(id, { setAttribute() {} }); return nodes.get(id); };
  const context = vm.createContext({ $, currentPage: 'settings', items: new Map(), running: true, importing: false,
    recoveryBusy: false, queuePaused: false, pauseRequestPending: false, output: '/out', runnableCount: 0, firstRunnableId: '' });
  const source = read('src/ui/renderer.js');
  vm.runInContext(source.slice(source.indexOf('function render()'), source.indexOf('// Safe:')), context);
  vm.runInContext('render()', context);
  for (const id of ['import-folder', 'clear', 'folder', 'settings-pick-output', 'change-setup']) assert.equal($(id).disabled, true);
  context.running = false;
  vm.runInContext('render()', context);
  for (const id of ['import-folder', 'clear', 'folder', 'settings-pick-output', 'change-setup']) assert.equal($(id).disabled, false);
  context.recoveryBusy = true;
  vm.runInContext('render()', context);
  assert.equal($('import-folder').disabled, true);
});

test('Windows desktop commands respect open modals, profile drafts and refreshed busy controls', () => {
  let handler, modal = true, clicks = 0, navigation = 0;
  const button = { disabled: false, click() { clicks++; } };
  const context = vm.createContext({ api: { onUpdate(fn) { handler = fn; } },
    document: { querySelector: () => modal ? {} : null }, $: () => button,
    profileEditing: false, showPage() { navigation++; } });
  const source = read('src/ui/windows-desktop.js');
  vm.runInContext(source.slice(source.indexOf('api.onUpdate('), source.lastIndexOf('\n}')), context);
  handler({ type: 'desktop-command', command: 'add-files' });
  assert.equal(clicks, 0);
  modal = false; context.profileEditing = true;
  handler({ type: 'desktop-command', command: 'add-files' });
  assert.equal(navigation, 0);
  context.profileEditing = false;
  handler({ type: 'desktop-command', command: 'add-files' });
  assert.equal(clicks, 1);
  context.showPage = () => { button.disabled = true; };
  handler({ type: 'desktop-command', command: 'add-files' });
  assert.equal(clicks, 1);
});

test('release publication is gated on both platforms and staged as a draft before publication', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.equal((workflow.match(/softprops\/action-gh-release/g) || []).length, 1);
  assert.match(workflow, /needs: \[mac, windows\]/);
  assert.match(workflow, /draft: true/);
  assert.match(workflow, /--draft=false/);
  assert.match(workflow, /validate-packaged-app.js mac/);
  assert.match(workflow, /validate-packaged-app.js win/);
});