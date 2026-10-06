const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectInOrder } = require('../src/app-state');
const { matchSidecars, indexSidecars } = require('../src/imports');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'audiority-benchmark-'));
app.setPath('userData', data);
app.on('will-quit', () => fs.rmSync(data, { recursive: true, force: true }));
const timeout = setTimeout(() => { console.error('Benchmark timed out'); app.exit(1); }, 60000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const ui = await window.webContents.executeJavaScript(`(() => {
        currentPage = 'queue'; document.getElementById('setup').hidden = true; document.getElementById('workspace').hidden = false;
        for (let i = 0; i < 5000; i++) items.set(String(i), { id: String(i), name: 'Episode '+i+'.mkv', status: 'Ready', duration: 1200, size: 2e9, tracks: [{ sourceCodec: 'flac', codec: 'dca', action: 'encode', channels: 6, layout: '5.1(side)', language: 'eng', reason: 'Benchmark conversion plan.' }] });
        render();
        const original = document.querySelector('#queue article');
        let start = performance.now();
        for (let i = 0; i < 200; i++) patchProgress({ id: '0', status: 'Converting', progress: i / 200 });
        const patchMs = performance.now() - start;
        const retainedNode = original === document.querySelector('#queue article');
        start = performance.now(); for (let i = 0; i < 200; i++) render();
        const reconcileMs = performance.now() - start;
        const retainedAfterRender = original === document.querySelector('#queue article');
        start = performance.now(); for (let i = 0; i < 200; i++) { $('queue').replaceChildren(); render(); }
        const forcedRebuildMs = performance.now() - start;
        return { queuedFiles: items.size, visibleCards: document.querySelectorAll('#queue article').length, updates: 200, retainedNode, retainedAfterRender, patchMs, reconcileMs, forcedRebuildMs };
      })()`);
      const entries = [];
      for (let i = 0; i < 300; i++) for (const name of [`Episode ${i}.mkv`, `Episode ${i}.eng.ass`]) entries.push({ name, isFile: () => true, isDirectory: () => false });
      let start = performance.now();
      for (let i = 0; i < 300; i++) matchSidecars(path.join(data, `Episode ${i}.mkv`), entries);
      const originalMs = performance.now() - start;
      start = performance.now(); const index = indexSidecars(data, entries);
      for (let i = 0; i < 300; i++) matchSidecars(path.join(data, `Episode ${i}.mkv`), entries, index);
      const indexedMs = performance.now() - start;
      const simulated = {};
      for (const concurrency of [1, 2, 4]) {
        start = performance.now();
        await inspectInOrder((async function* () { for (let i = 0; i < 24; i++) yield i; })(), async n => { await new Promise(resolve => setTimeout(resolve, 10)); return n; }, () => {}, concurrency);
        simulated[concurrency] = performance.now() - start;
      }
      console.log(JSON.stringify({ note: 'Synthetic local benchmark; not audio encoding or disk throughput. Times vary by machine.', ui, sidecars: { episodes: 300, originalMs, indexedMs }, simulatedInspectionMs: simulated }, null, 2));
      clearTimeout(timeout); app.exit(0);
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
});
require('../src/main');