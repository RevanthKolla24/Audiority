const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { preferencesDefaults } = require('../src/app-state');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audiority-recovery-ui-'));
app.setPath('userData', directory);
const discard = process.argv.includes('--discard');
const partial = path.join(directory, '.missing.audiority.12345678-1234-1234-1234-123456789abc.partial.mkv');
const completeOutput = path.join(directory, 'completed.mkv');
fs.writeFileSync(partial, 'orphan'); fs.writeFileSync(completeOutput, 'completed');
fs.writeFileSync(path.join(directory, 'app-settings.json'), JSON.stringify(preferencesDefaults()));
fs.writeFileSync(path.join(directory, 'queue.json'), JSON.stringify({ version: 1, items: [
  { id: 'interrupted', file: path.join(directory, 'missing.mkv'), status: 'Converting', temporaryOutput: partial },
  { id: 'completed', file: path.join(directory, 'missing-completed-source.mkv'), status: 'Complete', output: completeOutput }
] }));
let prompted = false;
dialog.showMessageBoxSync = options => {
  assert.ok(options.message.includes('unfinished queue'));
  prompted = true; return discard ? 1 : 0;
};
require('../src/main');
const timeout = setTimeout(() => { console.error('Recovery smoke timed out'); app.exit(1); }, 20000);
const poll = setInterval(async () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window || window.webContents.isLoading()) return;
  clearInterval(poll);
  try {
    assert.ok(prompted);
    assert.ok(!fs.existsSync(partial));
    assert.ok(fs.existsSync(completeOutput));
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'queue.json'), 'utf8'));
    assert.equal(saved.items.length, discard ? 0 : 2);
    if (!discard) {
      assert.equal(saved.items[0].status, 'Error');
      assert.equal(saved.items[1].status, 'Complete');
    }
    for (let i = 0; i < 100; i++) {
      const count = await window.webContents.executeJavaScript(`document.getElementById('count').textContent`);
      if (count === (discard ? '0' : '2')) break;
      if (i === 99) throw new Error('Restored queue did not appear in renderer');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    console.log(`Startup recovery smoke passed: ${discard ? 'discard' : 'restore'}, orphan cleanup, completed preservation and renderer delivery.`);
    clearTimeout(timeout); window.destroy(); app.quit();
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
}, 100);
app.on('quit', () => fs.rmSync(directory, { recursive: true, force: true }));