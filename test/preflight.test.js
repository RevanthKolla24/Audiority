const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('partial conversions require acknowledgment and revalidate plans after the dialog', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  for (const choice of ['review', 'proceed', 'changed']) {
    let handler, prompts = 0, started = false;
    const item = { id: 'job', name: 'Movie', status: 'Ready', plan: { needsConversion: true, unresolved: true, tracks: [{ index: 0, compatibility: 'unresolved', reason: 'No surround path confirmed' }] } };
    const context = vm.createContext({
      handle: (_channel, fn) => { handler = fn; }, running: false, importing: false, profileBusy: false, appStateBusy: false, queueQuitPending: false,
      settings: {}, preferences: {}, outputDirectory: '/output', items: new Map([['job', item]]), window: {},
      dialog: { showMessageBox: async (_window, options) => {
        prompts++; assert.equal(options.defaultId, 0);
        assert.match(options.detail, /No surround path confirmed/);
        if (choice === 'changed') item.plan = { ...item.plan, tracks: [] };
        return { response: choice === 'review' ? 0 : 1 };
      } },
      resumeQueue() { started = true; throw new Error('reached execution'); }
    });
    vm.runInContext(source.slice(source.indexOf("handle('start',"), source.indexOf('  window.loadFile(page)')), context);
    if (choice === 'review') await handler();
    else await assert.rejects(handler(), choice === 'proceed' ? /reached execution/ : /changed while reviewing/);
    assert.equal(prompts, 1);
    assert.equal(started, choice === 'proceed');
  }
});

test('blocked explicit plans do not start or display a partial-conversion override', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  let handler;
  const context = vm.createContext({
    handle: (_channel, fn) => { handler = fn; }, running: false, importing: false, profileBusy: false, appStateBusy: false,
    settings: {}, outputDirectory: '/output', items: new Map([['job', { status: 'Ready', plan: { needsConversion: true, blocked: true } }]])
  });
  vm.runInContext(source.slice(source.indexOf("handle('start',"), source.indexOf('  window.loadFile(page)')), context);
  await assert.rejects(handler(), /No runnable jobs/);
  assert.equal(context.running, false);
});