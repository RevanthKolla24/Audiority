const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2], phase = process.argv[3];
if (!root || !['save', 'convert', 'verify'].includes(phase)) throw new Error('Run via restart-acceptance.js');
const data = path.join(root, 'profile');
app.setPath('userData', data);
let operation = 'startup';
const timer = setTimeout(() => { console.error(`${phase} stalled: ${operation}`); app.exit(1); }, 40000);
// Restore is accepted only inside this isolated acceptance process.
dialog.showMessageBoxSync = options => {
  assert.match(options.message, /unfinished queue/);
  return 0;
};
dialog.showOpenDialog = async (_window, options) => ({ canceled: false,
  filePaths: [options.properties.includes('openDirectory') ? path.join(root, 'output') : path.join(root, 'source.mkv')] });
app.on('browser-window-created', (_event, window) => {
  // Leave production background throttling untouched.
  window.webContents.once('did-finish-load', async () => {
    const execute = async code => { operation = code; return window.webContents.executeJavaScript(code); };
    const wait = async (label, check) => {
      operation = label;
      for (let i = 0; i < 300; i++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out: ${label}`);
    };
    const savedJob = () => JSON.parse(fs.readFileSync(path.join(data, 'queue.json'), 'utf8')).items[0];
    try {
      await wait('bridge/setup ready', () => execute(`typeof setupData !== 'undefined' && !!setupData && typeof api !== 'undefined'`));
      await wait('initial window presentation', () => window.isVisible());
      if (phase === 'save') {
        const { defaultSettings } = require('../src/profiles');
        const settings = { ...defaultSettings(), advanced: true, layoutPolicy: 'fixed', speakerLayout: 'stereo', retentionMode: 'keep',
          pathConfirmed: true, pathCodecs: ['pcm'], allowed: ['pcm'], passthrough: 'enabled' };
        await execute(`api.profileOperation(${JSON.stringify({ type: 'save', name: 'Restart stereo', settings })})`);
        await execute('api.pickOutput()');
        await execute('api.pickFiles()');
        await wait('import persisted', () => fs.existsSync(path.join(data, 'queue.json')) && savedJob()?.status === 'Ready');
        assert.equal(savedJob().output, '');
      } else {
        const setup = await execute('api.getSetup()');
        assert.equal(setup.settings.layoutPolicy, 'fixed');
        assert.equal(setup.settings.speakerLayout, 'stereo');
        assert.equal(setup.settings.retentionMode, 'keep');
        await wait('restored queue visible', () => execute('items.size === 1'));
        const preview = await execute('[...items.values()][0].outputPreview');
        if (phase === 'convert') {
          await wait('compact output preview rendered', () => execute(`!!document.querySelector('.audio-output-extra')`));
          assert.equal(await execute(`document.querySelector('.audio-output-extra').hidden`), true);
          await execute(`$('show-audio-details').click()`);
          await wait('expanded output preview rendered', () => execute(`document.querySelector('.audio-output-extra')?.hidden === false`));
          assert.deepEqual(preview.outputs.map(entry => [entry.channels, entry.default]), [[6, 0], [2, 1]]);
          assert.equal(await execute(`document.querySelector('.audio-output-preview').textContent.includes('Retained original') && document.querySelector('.audio-output-preview').textContent.includes('Compatibility track') && document.querySelector('.audio-output-preview').textContent.includes('DEFAULT flag')`), true);
          assert.equal(savedJob().status, 'Ready');
          const { Engine } = require('../src/engine');
          const original = Engine.prototype.convert;
          // Exercise real conversion while both minimized and hidden, without
          // relying on renderer animation frames for completion detection.
          Engine.prototype.convert = async function (...args) {
            const minimized = new Promise(resolve => window.once('minimize', resolve));
            window.minimize(); await minimized; window.hide();
            assert.equal(window.isVisible(), false);
            assert.equal(window.webContents.getBackgroundThrottling(), true);
            try { return await original.apply(this, args); }
            finally { Engine.prototype.convert = original; }
          };
          await execute('void api.start()');
          await wait('hidden conversion persisted', () => savedJob()?.status === 'Complete' && !!savedJob().conversionReport);
          assert.equal(window.isVisible(), false);
          window.restore(); window.show(); window.focus();
        } else {
          assert.equal(await execute(`$('show-audio-details').checked`), true);
          assert.equal(preview, null);
          assert.equal(savedJob().status, 'Complete');
          assert.ok(fs.existsSync(savedJob().output));
          const { Engine } = require('../src/engine');
          const probe = await new Engine(require('../src/tools').toolPaths()).probe(savedJob().output);
          assert.deepEqual(probe.streams.filter(s => s.codec_type === 'audio').map(s => s.channels), [6, 2]);
          assert.deepEqual(probe.streams.filter(s => s.codec_type === 'audio').map(s => s.disposition.default), [0, 1]);
        }
        await wait('restored completion rendered', () => execute(`[...items.values()][0]?.status === 'Complete' && !!document.querySelector('textarea[aria-label="Verified audio mapping"]')`));
        assert.equal(await execute(`document.querySelector('textarea[aria-label="Verified audio mapping"]').value`), savedJob().conversionReport);
        await wait('theme icon rendered', () => execute('paintedIconColors.length > 0'));
      }
      await wait('queue runner idle before graceful quit', () => execute('!running && !importing'));
      console.log(`Restart acceptance phase passed: ${phase}`);
      operation = 'graceful quit and queue persistence';
      // Keep watchdog alive until production before-quit persistence completes.
      app.once('will-quit', () => { console.log(`Restart acceptance will-quit: ${phase}`); clearTimeout(timer); });
      app.quit();
    } catch (error) { console.error(`${phase}: ${operation}`, error); clearTimeout(timer); app.exit(1); }
  });
});
require('../src/main');