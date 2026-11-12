const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Never alter a developer's actual playback settings during a smoke test.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'audiority-ui-'));
app.setPath('userData', userData);
app.on('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));
const started = Date.now();
let currentOperation = 'waiting for browser window';
function checkpoint(operation) {
  currentOperation = operation;
  console.log(`[smoke +${Date.now() - started}ms] ${operation}`);
}
const timeout = setTimeout(() => { console.error(`UI smoke test timed out after ${Date.now() - started}ms during: ${currentOperation}`); app.exit(1); }, 60000);
app.on('browser-window-created', (_event, window) => {
  checkpoint('waiting for did-finish-load');
  // Automated tests must advance animation-frame assertions even when another
  // desktop window occludes the smoke window. Production throttling is unchanged.
  window.webContents.setBackgroundThrottling(false);
  const errors = [];
  window.webContents.on('render-process-gone', (_event, details) => console.error('Smoke renderer exited:', details));
  const evaluate = async code => {
    checkpoint(`execute: ${code}`);
    return window.webContents.executeJavaScript(code);
  };
  const capture = async label => {
    checkpoint(`capturePage: ${label}`);
    return window.webContents.capturePage();
  };
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  window.webContents.once('did-finish-load', async () => {
    try {
      // Exercise Windows presentation on macOS too, without a production platform override.
      // This validates DOM/layout, not Windows DPI rendering or native menus.
      if (process.argv.includes('--windows-layout') && process.platform !== 'win32') {
        await evaluate(`document.documentElement.dataset.platform = 'win32'`);
        const source = fs.readFileSync(path.join(__dirname, '../src/ui/windows-desktop.js'), 'utf8');
        await evaluate(source.replace("if (api.platform === 'win32')", 'if (true)'));
      }
      const state = await evaluate(`({ title: document.title, bridge: typeof window.audiority.start, queue: document.getElementById('count').textContent, startDisabled: document.getElementById('start').disabled, node: typeof require })`);
      assert.deepEqual(state, { title: 'Audiority', bridge: 'function', queue: '0', startDisabled: true, node: 'undefined' });
      await evaluate('window.audiority.clear()');
      const execute = code => evaluate(code).catch(error => { throw new Error(`${error.message}\nSmoke script: ${code}`); });
      const waitFor = async code => {
        for (let i = 0; i < 200; i++) { if (await execute(code)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
        const diagnostic = await execute(`({ running, importing, message: $('message').textContent, summary: $('summary').textContent, items: [...items.values()].map(i => ({ id: i.id, status: i.status, output: i.output, needsConversion: i.needsConversion })) })`);
        throw new Error(`Timed out waiting for ${code}: ${JSON.stringify(diagnostic)}`);
      };
      await waitFor(`document.getElementById('catalog-count').textContent.includes('126')`);
      if (process.platform === 'win32' || process.argv.includes('--windows-layout')) {
        assert.equal(await evaluate(`document.querySelector('.app-nav').parentElement.classList.contains('sidebar') && !!document.getElementById('import-files') && getComputedStyle(document.getElementById('profile-name')).fontSize === '14px'`), true);
      }
      await waitFor(`document.querySelector('.queue-empty-logo')?.complete && document.querySelector('.queue-empty-logo').naturalWidth > 0`);
      assert.equal(await execute(`document.querySelector('.queue-empty-logo').alt`), 'Audiority logo');
      const brandTypography = await execute(`(() => {
        const mark = document.querySelector('.brand-mark');
        const style = getComputedStyle(mark);
        return { text: mark.textContent, family: style.fontFamily, style: style.fontStyle, weight: style.fontWeight };
      })()`);
      assert.equal(brandTypography.text, 'a');
      assert.match(brandTypography.family, /Georgia/i);
      assert.equal(brandTypography.style, 'italic');
      assert.equal(brandTypography.weight, '400');
      const usability = await execute(`(() => {
        const previousOutput = output;
        output = ''; syncOutputFolder(); render();
        const folderPrompt = $('start').textContent === 'Choose output folder first' && $('summary').textContent.includes('Choose an output folder');
        output = previousOutput; syncOutputFolder(); render();
        const durations = remainingText(125) === '2m 5s' && remainingText(3661) === '1h 1m 1s' && remainingText(9) === '9s';
        const selected = $('playback-device').value;
        $('device-search').value = 'firestick'; $('device-search').dispatchEvent(new Event('input', { bubbles: true }));
        const matching = [...$('playback-device').options].filter(option => option.textContent.includes('Fire TV Stick'));
        const search = matching.length >= 10 && $('playback-device').value === selected;
        $('device-search').value = ''; $('device-search').dispatchEvent(new Event('input', { bubbles: true }));
        const caret = getComputedStyle($('profile-name')).caretColor === getComputedStyle($('profile-name')).color;
        const cursor = getComputedStyle($('profile-name')).cursor.includes('text-cursor.svg');
        return { folderPrompt, durations, search, caret, cursor };
      })()`);
      assert.ok(Object.values(usability).every(Boolean), JSON.stringify(usability));
      const progressChecks = await execute(`(() => {
        const item = { id: 'progress-test', name: 'ETA test', status: 'Converting', progress: 0.5, progressStart: Date.now() - 10000 };
        items.set(item.id, item);
        const card = element('article'); card.dataset.id = item.id; card.append(element('span', 'status')); $('queue').append(card);
        patchProgress({ id: item.id, status: 'Converting', progress: 0.5 });
        const eta = /^50% · ~(10|11)s writing remaining · checks follow$/.test(card.querySelector('.progress-text').textContent);
        const thickness = getComputedStyle(card.querySelector('progress')).height === '6px';
        item.status = 'Verifying'; patchProgress({ id: item.id, status: 'Verifying', progress: 0.99 });
        const verifying = card.querySelector('.progress-text').textContent.includes('Estimating check time') && !card.querySelector('progress').hasAttribute('value');
        item.verificationStage = 'Checking video 1: output · 200 packets checked';
        patchProgress({ id: item.id, status: 'Verifying', progress: 0.99 });
        item.verification = { fraction: 0.5, completed: 1, total: 4, remainingLow: 60, remainingHigh: 240 };
        patchProgress({ id: item.id, status: 'Verifying', progress: 0.99 });
        const stage = card.querySelector('.progress-text').textContent.includes('50% of checks') && card.querySelector('.progress-text').textContent.includes('1m 0s–4m 0s') && card.querySelector('progress').value === 0.5;
        item.status = 'Complete'; item.progress = 1;
        const complete = createProgress(item).querySelector('.progress-text').textContent === 'Complete';
        item.status = 'Converting'; item.progress = 0; patchProgress({ id: item.id, status: 'Converting', progress: 0 });
        const reset = !item.progressStart && card.querySelector('.progress-text').textContent.includes('0% · Estimating… · writing only');
        const originalPage = currentPage; currentPage = 'settings'; item.progress = 0.1; patchProgress({ id: item.id, status: 'Converting', progress: 0.1 });
        const offscreen = !!item.progressStart; currentPage = originalPage;
        items.delete(item.id); card.remove();
        return { eta, thickness, verifying, stage, complete, reset, offscreen };
      })()`);
      assert.ok(Object.values(progressChecks).every(Boolean), JSON.stringify(progressChecks));
      const updateControls = await execute(`(() => {
        renderUpdateState({ status: 'downloading', version: '2.0.0', percent: 42 });
        const downloading = $('update-status').textContent.includes('42%') && $('update-check').disabled;
        renderUpdateState({ status: 'error', error: 'HTTP 404' });
        const retry = $('update-status').textContent.includes('HTTP 404') && !$('update-check').disabled && $('update-check').textContent.includes('Retry');
        renderUpdateState({ status: 'ready', version: '2.0.0' });
        const install = !$('update-install').hidden;
        renderUpdateState({ status: 'disabled' });
        return { downloading, retry, install };
      })()`);
      assert.ok(Object.values(updateControls).every(Boolean), JSON.stringify(updateControls));
      {
        const checks = await execute(`(() => {
          const original = readDraft();
          const results = ['manual', 'dts-core'].map(conversionMode => {
            fillDraft({ ...original, receiverId: '', conversionMode, retentionMode: 'replace', languageMode: 'custom', allowedLanguages: ['jpn'], keepDefaultTrack: false, ac3Bitrate: 384 });
            $('reset-advanced').click();
            const value = readDraft();
            return value.conversionMode === conversionMode && value.receiverId === '' && value.retentionMode === 'replace' && value.languageMode === 'custom' && value.allowedLanguages.join(',') === 'jpn' && !value.keepDefaultTrack && value.ac3Bitrate === setupData.defaults.ac3Bitrate;
          });
          renderUpdateState({ status: 'error', error: 'Installer launch failed', canInstall: true });
          results.push(!$('update-install').hidden && !$('update-install').disabled);
          renderUpdateState({ status: 'disabled' });
          fillDraft(original);
          return results;
        })()`);
        assert.ok(checks.every(Boolean), JSON.stringify(checks));
      }
      const languageRoundTrip = await execute(`(() => {
        const original = readDraft();
        fillDraft({ ...original, allowedLanguages: ['eng', 'jpn'], keepDefaultTrack: false });
        const value = readDraft();
        const correct = value.allowedLanguages.join(',') === 'eng,jpn' && value.keepDefaultTrack === false;
        fillDraft(original);
        return correct && !!$('pref-allowedLanguages') && !!$('pref-keepDefaultTrack');
      })()`);
      assert.equal(languageRoundTrip, true);
      const workflowGating = await execute(`(() => {
        const original = readDraft();
        fillDraft({ ...original, receiverId: '', advanced: false, conversionMode: 'playback' });
        const playbackBlocked = $('receiver-next').disabled;
        $('conversion-mode').value = 'dts-core';
        $('conversion-mode').dispatchEvent(new Event('change', { bubbles: true }));
        const coreEnabled = !$('receiver-next').disabled;
        $('receiver-next').click();
        const advancedWithoutReceiver = !$('playback-page').hidden;
        $('playback-back').click();
        $('conversion-mode').value = 'manual';
        $('conversion-mode').dispatchEvent(new Event('change', { bubbles: true }));
        const manualEnabled = !$('receiver-next').disabled;
        $('conversion-mode').value = 'playback';
        $('conversion-mode').dispatchEvent(new Event('change', { bubbles: true }));
        const playbackBlockedAgain = $('receiver-next').disabled;
        fillDraft(original);
        previewProfile();
        return { playbackBlocked, coreEnabled, advancedWithoutReceiver, manualEnabled, playbackBlockedAgain };
      })()`);
      assert.ok(Object.values(workflowGating).every(Boolean), JSON.stringify(workflowGating));
      const reconciliationChecks = await execute(`(() => {
        const originalPage = currentPage; currentPage = 'queue';
        const make = i => ({ id: 'reconcile-' + i, name: 'Episode ' + i, status: 'Inspecting', tracks: [] });
        items.set('reconcile-0', make(0)); render();
        const first = $('queue').querySelector('article');
        const head = first.querySelector('.item-head');
        for (let i = 1; i < 55; i++) { items.set('reconcile-' + i, make(i)); render(); }
        const retained = first === $('queue').querySelector('article') && head === first.querySelector('.item-head');
        const pagination = $('queue').querySelector('.queue-pagination');
        render(); const stableNav = pagination === $('queue').querySelector('.queue-pagination');
        items.get('reconcile-54').priority = 100;
        items.get('reconcile-53').priority = 101; render();
        const priorityOrder = $('queue').children[0].dataset.id === 'reconcile-53' && $('queue').children[1].dataset.id === 'reconcile-54';
        delete items.get('reconcile-54').priority; delete items.get('reconcile-53').priority; render();
        const item = items.get('reconcile-0'); item.status = 'Ready';
        item.tracks = [{ sourceCodec: 'flac', codec: 'dca', action: 'encode', channels: 6, language: 'eng', reason: 'First plan' }]; render();
        const readyButton = !first.querySelector('.prioritize-item');
        const second = items.get('reconcile-1'); second.status = 'Ready'; second.tracks = item.tracks;
        render();
        const reorderButtons = !first.querySelector('.prioritize-item') && !!$('queue').querySelector('[data-id="reconcile-1"] .prioritize-item');
        second.status = 'Inspecting'; second.tracks = []; render();
        if (!reorderButtons) throw new Error('Queue reorder controls should appear only for a runnable job behind another');
        const details = first.querySelector('details'); details.open = true; expandedTracks.add(item.id);
        render(); const retainedDetails = details === first.querySelector('details') && details.open;
        item.tracks[0].reason = 'Changed profile'; render();
        const refreshed = first.textContent.includes('Changed profile') && first.querySelector('details').open;
        item.status = 'Complete'; item.output = '/test/output.mkv'; item.progress = 1; render();
        const complete = first.querySelector('.progress-text').textContent === 'Complete' && !!first.querySelector('.reveal-output') && !first.querySelector('.prioritize-item');
        item.status = 'Error'; item.error = 'Test failure'; item.warnings = ['Test warning']; render(); render();
        const messages = first.querySelectorAll('.item-messages .error').length === 1 && first.textContent.includes('Test warning');
        delete item.error; item.warnings = []; delete item.output; delete item.progress; item.status = 'Ready'; render();
        const cleared = !first.querySelector('.item-messages .error') && !first.querySelector('.reveal-output') && !first.querySelector('.progress-wrap');
        pagination.lastElementChild.click();
        const nextPage = $('queue').querySelectorAll('article').length === 5 && $('queue').querySelector('article').dataset.id === 'reconcile-50';
        for (let i = 0; i < 55; i++) items.delete('reconcile-' + i);
        expandedTracks.delete(item.id); render();
        const empty = !$('queue').querySelector('article') && !!$('queue').querySelector('.queue-empty');
        currentPage = originalPage;
        return { retained, stableNav, priorityOrder, readyButton, retainedDetails, refreshed, complete, messages, cleared, nextPage, empty };
      })()`);
      assert.ok(Object.values(reconciliationChecks).every(Boolean), JSON.stringify(reconciliationChecks));
      assert.equal(await execute(`!!document.getElementById('matrix-panel') && !document.getElementById('advanced-panel') && !document.getElementById('compatibility-panel')`), true);
      await execute(`document.getElementById('advanced-rules-open').click()`);
      assert.equal(await execute(`document.getElementById('advanced-rules-dialog').open && document.getElementById('rule-list').closest('dialog').id === 'advanced-rules-dialog' && document.getElementById('downmix-list').closest('dialog').id === 'advanced-rules-dialog'`), true);
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await waitFor(`!document.getElementById('advanced-rules-dialog').open`);
      await execute(`document.getElementById('advanced-rules-open').click(); document.getElementById('advanced-rules-done').click()`);
      assert.equal(await execute(`!document.getElementById('advanced-rules-dialog').open`), true);
      const originalSize = window.getSize();
      const originalZoom = window.webContents.getZoomFactor();
      try {
        for (const [width, height, zoom] of [[960, 700, 1], [1280, 800, 1.25], [1440, 900, 1.5]]) {
          window.setSize(width, height);
          window.webContents.setZoomFactor(zoom);
          await execute(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
          const layout = await execute(`(() => {
            const item = { status: 'Verifying', verification: { phase: 'Video checks', fraction: 0.5, completed: 1, total: 2, remainingLow: 3600, remainingHigh: 14400, pending: ['Subtitle checks', 'Font / attachment checks'] } };
            const card = element('article'); card.append(createProgress(item));
            $('receiver-page').append(card);
            const text = card.querySelector('.progress-text'), bar = card.querySelector('progress');
            const visible = text.scrollWidth <= text.clientWidth + 1 && text.getBoundingClientRect().right <= card.getBoundingClientRect().right + 1 && bar.getBoundingClientRect().height === 6;
            card.remove();
            return { visible, pageFits: document.documentElement.scrollWidth <= innerWidth + 1 };
          })()`);
          assert.ok(Object.values(layout).every(Boolean), JSON.stringify({ width, height, zoom, ...layout }));
        }
      } finally { window.setSize(...originalSize); window.webContents.setZoomFactor(originalZoom); }
      const matrixChecks = await execute(`(() => {
        const original = readDraft();
        $('profile-keep-original').checked = true;
        if (!readDraft().keepOriginal) throw new Error('Compatibility checkbox mapping failed');
        fillDraft(original);
        if ($('profile-keep-original').checked !== original.keepOriginal) throw new Error('Compatibility checkbox round-trip failed');
        $('profile-normalize').checked = true;
        const normalization = readDraft().normalizeVolume;
        fillDraft(original);
        if (!normalization || $('profile-normalize').checked !== original.normalizeVolume) throw new Error('Normalization form round-trip failed');
        const legacy = { ...original, advanced: true, extractDtsCore: false, allowDownmix: true,
          excludedFormats: ['eac3', 'mp3'], downmixRules: [{ source: '7.1', target: '3.1' }],
          rules: [{ source: 'flac', scope: 'surround', target: 'dts' }, { source: 'alac', scope: 'surround', target: 'ac3' },
            { source: 'aac', scope: 'stereo', target: 'pcm' }, { source: 'dtshd', scope: 'surround', target: 'ac3' }] };
        fillDraft(legacy);
        const roundTrip = JSON.stringify(readDraft()) === JSON.stringify(legacy);
        const divergent = ['lossless', 'other', 'dtshd'].every(id => document.getElementById('matrix-' + id).value === 'auto');
        const set = (id, value) => { const node = document.getElementById('matrix-' + id); node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); };
        set('eac3', 'ac3'); set('lossless', 'dts'); set('dtshd', 'core'); set('other', 'pcm');
        const result = readDraft();
        const repeated = JSON.stringify(result) === JSON.stringify(readDraft());
        fillDraft(result);
        const reload = JSON.stringify(readDraft()) === JSON.stringify(result);
        const specificPreserved = !result.rules.some(r => r.source === 'aac' && r.scope === 'stereo') && result.rules.some(r => r.source === 'dtshd' && r.scope === 'any' && r.target === 'dts') && !result.rules.some(r => r.source === 'dtshd' && r.scope === 'surround');
        const fallback = result.lossless === 'dts' && result.lossy === 'pcm' && result.stereo === 'pcm';
        const mappings = !result.excludedFormats.includes('eac3') && result.rules.some(r => r.source === 'eac3' && r.scope === 'any' && r.target === 'ac3') && result.extractDtsCore && result.allowed.includes('pcm');
        const downmix = JSON.stringify(result.downmixRules) === JSON.stringify(legacy.downmixRules);
        fillDraft(original);
        return { roundTrip, divergent, repeated, reload, specificPreserved, fallback, mappings, downmix };
      })()`);
      assert.ok(Object.values(matrixChecks).every(Boolean), JSON.stringify(matrixChecks));
      const workflowChecks = await execute(`(async () => {
        const original = readDraft();
        try {
          fillDraft({ ...original, conversionMode: 'dts-core', retentionMode: 'replace', languageMode: 'all', receiverId: '', advanced: false });
          const value = readDraft();
          const profile = await api.previewProfile(value);
          const independent = profile.allowed.join(',') === 'dts' && profile.conversionMode === 'dts-core';
          const policies = value.retentionMode === 'replace' && value.languageMode === 'all' && effectivePolicyText(profile).includes('profile overrides global');
          ruleRow({ source: 'dtshd', scope: 'surround', target: 'ac3' });
          applyMatrix(matrixRows[0], 'auto');
          const reset = !readDraft().rules.some(rule => rule.source === 'dtshd') && !readDraft().extractDtsCore;
          return { independent, policies, reset };
        } finally { fillDraft(original); }
      })()`);
      assert.ok(Object.values(workflowChecks).every(Boolean), JSON.stringify(workflowChecks));
      const systemChecks = await execute(`(async () => {
        const original = readDraft();
        try {
          fillDraft({ ...original, conversionMode: 'playback', advanced: true, layoutPolicy: 'fixed', speakerLayout: 'stereo' });
          const fixed = readDraft(), profile = await api.previewProfile(fixed);
          const roundTrip = fixed.layoutPolicy === 'fixed' && fixed.speakerLayout === 'stereo';
          const mappings = profile.allowDownmix && profile.downmixRules.some(rule => rule.source === '7.1' && rule.target === 'stereo');
          $('layout-policy').value = 'receiver';
          const receiver = await api.previewProfile(readDraft());
          return { roundTrip, mappings, receiver: !receiver.allowDownmix && receiver.preserve && receiver.systemExplanation.includes('Playback system manages') };
        } finally { fillDraft(original); }
      })()`);
      assert.ok(Object.values(systemChecks).every(Boolean), JSON.stringify(systemChecks));
      assert.equal(await execute(`document.getElementById('workspace').hidden`), true);
      assert.equal(await execute(`document.getElementById('matrix-panel').closest('#advanced-rules-dialog') !== null && !document.getElementById('advanced-rules-dialog').open`), true);
      await execute(`document.getElementById('advanced-rules-open').click()`);
      assert.equal(await execute(`document.getElementById('advanced-rules-dialog').open`), true);
      await execute(`document.getElementById('advanced-rules-done').click()`);
      await waitFor(`!document.getElementById('advanced-rules-dialog').open && document.activeElement.id === 'advanced-rules-open'`);
      await execute(`document.getElementById('avr-search').value='bose v20'; document.getElementById('avr-search').dispatchEvent(new Event('input'));`);
      assert.equal(await execute(`document.querySelectorAll('#avr-results button').length`), 1);
      await execute(`document.querySelector('#avr-results button').click(); document.getElementById('receiver-next').click();`);
      await execute(`document.getElementById('allow-downmix').checked=true; document.getElementById('extract-dts-core').checked=true; document.querySelector('#excluded-formats input[value="eac3"]').checked=true; document.querySelector('#downmix-list select[data-field="target"]').value='3.1';`);
      assert.equal(await execute(`document.getElementById('playback-page').hidden`), false);
      await execute(`document.getElementById('media-platform').value='jellyfin'; document.getElementById('playback-device').value='shield-tv-pro'; document.getElementById('passthrough').value='enabled'; document.getElementById('path-confirmed').checked=true; for(const el of document.querySelectorAll('#path-formats input')) el.checked=['dts','ac3','pcm'].includes(el.value); document.getElementById('path-confirmed').dispatchEvent(new Event('change',{bubbles:true}));`);
      await waitFor(`document.getElementById('profile-preview').textContent.includes('Bose Lifestyle V20') && !document.getElementById('setup-save').disabled`);
      await execute(`document.getElementById('profile-name').value='Living room'; document.getElementById('setup-save').click()`);
      await waitFor(`!document.getElementById('workspace').hidden`);
      const stored = JSON.parse(fs.readFileSync(path.join(userData, 'playback-profiles.json'), 'utf8'));
      assert.equal(stored.profiles[0].settings.receiverId, 'bose-lifestyle-v20'); assert.equal(stored.profiles[0].settings.platform, 'jellyfin');
      assert.equal(stored.profiles[0].settings.extractDtsCore, true); assert.equal(stored.profiles[0].settings.allowDownmix, true);
      await execute(`$('change-setup').click(); $('speaker-layout').value = 'stereo'; $('layout-policy').value = 'fixed'; previewProfile()`);
      await waitFor(`!$('setup-save').disabled && $('profile-preview').textContent.includes('Fixed-layout compatibility')`);
      await execute(`$('setup-save').click()`);
      await waitFor(`!$('workspace').hidden`);
      const systemStored = JSON.parse(fs.readFileSync(path.join(userData, 'playback-profiles.json'), 'utf8')).profiles[0].settings;
      assert.equal(systemStored.layoutPolicy, 'fixed'); assert.equal(systemStored.speakerLayout, 'stereo');
      await execute(`location.reload()`);
      await waitFor(`document.readyState === 'complete' && typeof setupData !== 'undefined' && setupData?.settings?.layoutPolicy === 'fixed' && !$('workspace').hidden`);
      assert.equal(await execute(`setupData.profile.speakerLayout === 'stereo' && setupData.profile.downmixRules.some(rule => rule.source === '7.1' && rule.target === 'stereo')`), true);
      // Restore legacy policy for the remaining independent smoke scenarios.
      await execute(`$('change-setup').click(); $('layout-policy').value = 'legacy'; previewProfile()`);
      await waitFor(`!$('setup-save').disabled`);
      await execute(`$('setup-save').click()`);
      await waitFor(`!$('workspace').hidden`);
      assert.deepEqual(stored.profiles[0].settings.excludedFormats, ['eac3']);
      assert.deepEqual(stored.profiles[0].settings.downmixRules, [{ source: '7.1', target: '3.1' }]);
      await execute(`document.getElementById('duplicate-profile').click(); document.getElementById('dialog-name').value='Bedroom'; document.getElementById('profile-dialog-form').requestSubmit()`);
      await waitFor(`document.getElementById('profile-count').textContent === '2' && !document.getElementById('profile-dialog').open`);
      await execute(`document.getElementById('rename-profile').click(); document.getElementById('dialog-name').value='Bedroom TV'; document.getElementById('profile-dialog-form').requestSubmit()`);
      await waitFor(`document.querySelector('.profile-entry.active strong').textContent === 'Bedroom TV'`);
      await execute(`document.querySelector('#profile-list button').click()`);
      await waitFor(`document.querySelector('.profile-entry.active strong').textContent === 'Living room'`);
      await execute(`document.getElementById('new-profile').click()`);
      assert.equal(await execute(`document.getElementById('profile-name').value`), '');
      await execute(`$('profile-name').value = 'Unsaved draft'; $('nav-queue').click()`);
      assert.equal(await execute(`profileEditing && !$('setup').hidden && $('workspace').hidden && $('profile-name').value === 'Unsaved draft'`), true);
      await execute(`document.getElementById('setup-cancel').click()`);
      await execute(`document.getElementById('delete-profile').click(); document.getElementById('profile-dialog-form').requestSubmit()`);
      await waitFor(`document.getElementById('profile-count').textContent === '1' && !document.getElementById('profile-dialog').open`);
      await execute(`document.getElementById('change-setup').click(); document.getElementById('custom-receiver').click(); document.getElementById('add-rule').click();`);
      assert.equal(await execute(`document.querySelectorAll('#rule-list .rule-row').length`), 1);
      assert.equal(await execute(`document.getElementById('advanced-enabled').checked`), true);
      await execute(`document.getElementById('setup-cancel').click()`);
      assert.equal(await execute(`document.getElementById('workspace').hidden`), false);
      await waitFor(`!document.getElementById('advanced-rules-dialog').open`);
      await waitFor(`document.getElementById('theme-select').options.length === 12`);
      await waitFor(`paintedIconColors.length > 0`);
      const iconChecks = await execute(`(async () => {
        const originalExport = HTMLCanvasElement.prototype.toDataURL;
        const originalTheme = activeTheme();
        const images = [];
        HTMLCanvasElement.prototype.toDataURL = function(...args) { const data = originalExport.apply(this, args); images.push(data); return data; };
        try {
          paintedIconColors = '';
          applyTheme(appearanceData.builtins[0]);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          applyTheme(appearanceData.builtins.find(t => t.id === 'graphite'));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          let rejected = false;
          try { await api.updateThemeIcon('data:image/png;base64,AAAA'); } catch { rejected = true; }
          return { changed: images.length === 2 && images[0] !== images[1], png: images.every(data => data.startsWith('data:image/png;base64,')), rejected, images };
        } finally {
          HTMLCanvasElement.prototype.toDataURL = originalExport;
          paintedIconColors = ''; applyTheme(originalTheme);
        }
      })()`);
      const { images: iconImages, ...iconResults } = iconChecks;
      assert.ok(Object.values(iconResults).every(Boolean), JSON.stringify(iconResults));
      for (const data of iconImages) assert.deepEqual(require('electron').nativeImage.createFromDataURL(data).getSize(), { width: 256, height: 256 });
      await execute(`document.getElementById('nav-settings').click()`);
      await waitFor(`!document.getElementById('settings-page').hidden`);
      assert.equal(await execute(`!document.querySelector('header #appearance-open') && !document.getElementById('about-toggle') && document.getElementById('about-panel').closest('#settings-page') !== null && !document.getElementById('about-panel').hidden && document.getElementById('theme-form').closest('#app-settings-form') === null`), true);
      await execute(`document.getElementById('theme-select').value='graphite'; document.getElementById('theme-select').dispatchEvent(new Event('change'))`);
      await waitFor(`document.documentElement.dataset.theme === 'graphite' && !document.getElementById('theme-create').disabled`);
      await execute(`document.getElementById('theme-create').click(); document.getElementById('theme-name').value='Custom smoke theme'; document.querySelector('#theme-colors input[data-token="accent"]').value='#77bbcc'; document.getElementById('theme-form').dispatchEvent(new Event('input')); document.getElementById('theme-form').requestSubmit()`);
      await waitFor(`document.getElementById('theme-select').options.length === 13 && document.getElementById('theme-form').hidden`);
      assert.equal(await execute(`document.documentElement.style.getPropertyValue('--theme-accent')`),'#77bbcc');
      await execute(`document.getElementById('theme-edit').click(); document.getElementById('theme-name').value='Edited smoke theme'; document.getElementById('theme-form').requestSubmit()`);
      await waitFor(`document.getElementById('theme-select').selectedOptions[0].textContent === 'Edited smoke theme'`);
      await execute(`document.getElementById('nav-queue').click()`);
      const { run } = require('../src/engine'); const { toolPaths } = require('../src/tools');
      const show = path.join(userData,'Anime','Season 01'); fs.mkdirSync(show,{recursive:true});
      await run(toolPaths().ffmpeg,['-v','error','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','0.1','-c:a','flac',path.join(show,'Episode 01.mkv')]);
      fs.writeFileSync(path.join(show,'Episode 01.eng.srt'),'1\n00:00:00,000 --> 00:00:00,100\nTest\n');
      const originalDialog = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => ({canceled:false,filePaths:[path.dirname(show)]});
      await execute(`document.getElementById('import-folder').click()`);
      await waitFor(`document.getElementById('count').textContent === '1' && document.getElementById('cancel-import').hidden`);
      assert.ok(await execute(`document.getElementById('queue').textContent.includes('Anime') && document.getElementById('queue').textContent.includes('1 external subtitle')`));
      if (process.platform === 'win32' || process.argv.includes('--windows-layout')) {
        const commands = await execute(`(() => {
          const button = $('import-files');
          const before = button.disabled;
          $('import-folder').disabled = true;
          return new Promise(resolve => queueMicrotask(() => {
            const blocked = button.disabled;
            $('import-folder').disabled = before;
            queueMicrotask(() => resolve(blocked && button.disabled === before));
          }));
        })()`);
        assert.equal(commands, true);
        const image = await capture('Windows workspace');
        fs.writeFileSync(path.join(os.tmpdir(), 'audiority-windows-workspace.png'), image.toPNG());
      }
      assert.equal(await execute(`document.querySelector('#queue .prioritize-item') === null`), true);
      // A one-job queue needs no reorder control; priority IPC still persists safely.
      await execute(`api.prioritizeItem(items.values().next().value.id)`);
      await waitFor(`items.values().next().value.priority > 0`);
      const priorityState = JSON.parse(fs.readFileSync(path.join(userData, 'queue.json'), 'utf8'));
      assert.ok(priorityState.items[0].priority > 0);
      assert.equal(await execute(`window.audiority.prioritizeItem('missing-id').then(() => false, () => true)`), true);
      await execute(`document.getElementById('import-folder').click()`);
      await waitFor(`document.getElementById('import-result').textContent.includes('1 already queued') && !importing`);
      const overflow = await execute(`(() => {
        const node = document.querySelector('#queue .name');
        const original = node.textContent;
        node.textContent = 'The.Lord.Of.The.Rings.The.Return.Of.The.King.Extended.Edition.2160p.TrueHD.7.1.Atmos.MKV'.repeat(3);
        const style = getComputedStyle(node);
        const valid = style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap' && node.scrollWidth > node.clientWidth;
        node.textContent = original;
        return valid;
      })()`);
      assert.equal(overflow, true);
      // Paths and errors must remain readable without widening the entire workspace.
      const pathLayout = await execute(`(() => {
        const previousPage = currentPage;
        const nodes = [$('message'), $('settings-output'), $('settings-watch-folder')];
        const originals = nodes.map(node => node.textContent);
        const longPath = 'C:/' + 'VeryLongMediaFolderName'.repeat(24) + '/movie.mkv';
        try {
          for (const node of nodes) node.textContent = longPath;
          showPage('settings');
          return { fits: document.documentElement.scrollWidth <= innerWidth + 1,
            wraps: nodes.every(node => node.scrollWidth <= node.clientWidth + 1) };
        } finally {
          nodes.forEach((node, index) => { node.textContent = originals[index]; });
          showPage(previousPage);
        }
      })()`);
      assert.ok(Object.values(pathLayout).every(Boolean), JSON.stringify(pathLayout));
      dialog.showOpenDialog = originalDialog;
      await execute(`document.getElementById('nav-settings').click()`);
      await waitFor(`!document.getElementById('settings-page').hidden && document.querySelectorAll('#theme-presets button').length === 12`);
      assert.equal(await execute(`$('pref-performanceMode').closest('.setup-card') === $('pref-threads').closest('.setup-card') && $('pref-performanceMode').selectedOptions[0].textContent === 'Balanced' && [...$('pref-performanceMode').options].some(option => option.textContent.includes('experimental'))`), true);
      await execute(`document.getElementById('pref-compact').checked=true; document.getElementById('pref-reducedMotion').checked=true; document.getElementById('pref-outputSuffix').value='.compatible'; document.getElementById('pref-inspectionConcurrency').value='3'; document.getElementById('app-settings-form').requestSubmit()`);
      await waitFor(`document.getElementById('settings-result').textContent === 'Settings saved.'`);
      fs.writeFileSync(path.join(os.tmpdir(), 'audiority-settings-preview.png'), (await capture('settings')).toPNG());
      const prefs = JSON.parse(fs.readFileSync(path.join(userData, 'app-settings.json'), 'utf8'));
      assert.equal(prefs.compact, true); assert.equal(prefs.inspectionConcurrency, 3); assert.equal(prefs.storeFilenames, false);
      await execute(`$('pref-performanceMode').value='adaptive'; $('app-settings-form').requestSubmit()`);
      await waitFor(`$('settings-result').textContent === 'Settings saved.' && !$('settings-save').disabled && preferencesData.preferences.performanceMode === 'adaptive'`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'app-settings.json'), 'utf8')).performanceMode, 'adaptive');
      const outputFolder = path.join(userData, 'Converted'); fs.mkdirSync(outputFolder);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [outputFolder] });
      await execute(`document.getElementById('settings-pick-output').click()`);
      await waitFor(`document.getElementById('settings-output').textContent === ${JSON.stringify(outputFolder)}`);
      assert.equal(await execute(`document.getElementById('destination').textContent === ${JSON.stringify(outputFolder)} && document.getElementById('folder').closest('footer') !== null`), true);
      await execute(`document.getElementById('nav-queue').click(); chooseOutputFolder()`);
      await waitFor(`document.getElementById('settings-output').textContent === ${JSON.stringify(outputFolder)} && !document.getElementById('folder').disabled`);
      dialog.showOpenDialog = originalDialog;
      // Hold the active conversion briefly so pause/resume IPC tests are deterministic,
      // even when the real FFmpeg fixture finishes in a fraction of a second.
      const { Engine } = require('../src/engine');
      // Never send fixture files to the real OS Trash during automated tests.
      const { shell } = require('electron');
      const originalTrashItem = shell.trashItem;
      const originalMessageBox = dialog.showMessageBox;
      dialog.showMessageBox = async (_window, options) => {
        assert.equal(options.title, 'Enable Auto-Trash?');
        assert.equal(options.defaultId, 0);
        return { response: 1 };
      };
      const trashedSources = [];
      shell.trashItem = async file => { trashedSources.push(file); };
      await execute(`$('nav-settings').click()`);
      await waitFor(`!$('settings-page').hidden`);
      assert.equal(await execute(`$('pref-trashOriginals').checked`), false);
      const watchDialog = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [userData] });
      await execute(`$('settings-pick-watch').click()`);
      await waitFor(`$('settings-watch-folder').textContent === ${JSON.stringify(userData)}`);
      dialog.showOpenDialog = watchDialog;
      await execute(`$('pref-watchEnabled').checked = true; $('app-settings-form').requestSubmit()`);
      await waitFor(`$('settings-result').textContent === 'Settings saved.' && !$('settings-save').disabled`);
      const watchPreferences = JSON.parse(fs.readFileSync(path.join(userData, 'app-settings.json'), 'utf8'));
      assert.equal(watchPreferences.watchEnabled, true);
      assert.equal(watchPreferences.watchFolder, userData);
      await execute(`$('nav-queue').click(); $('nav-settings').click()`);
      await waitFor(`!$('settings-page').hidden && $('pref-watchEnabled').checked`);
      await execute(`$('pref-watchEnabled').checked = false`);
      await execute(`$('pref-trashOriginals').checked = true; $('app-settings-form').requestSubmit()`);
      await waitFor(`$('settings-result').textContent === 'Settings saved.' && !$('settings-save').disabled`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'app-settings.json'), 'utf8')).trashOriginals, true);
      assert.equal(await execute(`!$('trash-warning').hidden && $('trash-warning').textContent.includes('Auto-Trash is enabled')`), true);
      const originalConvert = Engine.prototype.convert;
      let releaseConversion;
      const conversionGate = new Promise(resolve => { releaseConversion = resolve; });
      Engine.prototype.convert = async function (...args) { await conversionGate; return originalConvert.apply(this, args); };
      await execute(`document.getElementById('nav-queue').click()`);
      await waitFor(`!$('start').disabled && currentPage === 'queue'`);
      await execute(`document.getElementById('start').click()`);
      await waitFor(`running && !$('pause').hidden`);
      await execute(`$('nav-settings').click()`);
      await waitFor(`currentPage === 'settings'`);
      assert.equal(await execute(`$('import-folder').disabled && $('settings-pick-output').disabled`), true);
      await execute(`$('nav-queue').click()`);
      await execute(`$('pause').click()`);
      await waitFor(`queuePaused && !pauseRequestPending && $('pause').textContent === 'Resume'`);
      assert.equal(await execute(`$('summary').textContent === 'Queue Paused. The active conversion will finish safely.'`), true);
      // Repeated pause requests must not replace the resolver and strand the runner.
      await execute(`window.audiority.pause()`);
      await execute(`$('pause').click()`);
      await waitFor(`!queuePaused && !pauseRequestPending && $('pause').textContent === 'Pause'`);
      await execute(`$('pause').click()`);
      await waitFor(`queuePaused && !pauseRequestPending`);
      releaseConversion();
      Engine.prototype.convert = originalConvert;
      await waitFor(`[...items.values()].some(item => item.status === 'Complete')`);
      assert.equal(await execute(`(() => {
        const item = [...items.values()].find(item => item.status === 'Complete');
        const report = [...document.querySelectorAll('textarea')].find(node => node.getAttribute('aria-label') === 'Verified audio mapping');
        return Number.isFinite(item.timings?.total) && report?.readOnly && report.value === item.conversionReport && report.value.includes('Output audio ordinal');
      })()`), true);
      // A paused final job must finish the run without requiring Resume or Cancel.
      await waitFor(`!running && !queuePaused && $('pause').hidden`);
      // Native resolution expands Windows 8.3 aliases consistently on both sides.
      assert.deepEqual(trashedSources.map(file => fs.realpathSync.native(file)), [path.join(show, 'Episode 01.mkv')].map(file => fs.realpathSync.native(file)));
      assert.ok(fs.existsSync(path.join(show, 'Episode 01.eng.srt')));
      dialog.showMessageBox = originalMessageBox;
      assert.ok(fs.existsSync(trashedSources[0]));
      shell.trashItem = originalTrashItem;
      await execute(`window.audiority.pause()`);
      assert.equal(await execute(`queuePaused`), false);
      assert.equal(await execute(`window.audiority.start().then(() => false, error => error.message.includes('No runnable jobs'))`), true);
      await waitFor(`!running && !queuePaused`);
      await execute(`document.getElementById('nav-statistics').click()`);
      await waitFor(`!document.getElementById('statistics-page').hidden && document.getElementById('stats-recent').textContent.includes('completed')`);
      fs.writeFileSync(path.join(os.tmpdir(), 'audiority-statistics-preview.png'), (await capture('statistics')).toPNG());
      const stats = JSON.parse(fs.readFileSync(path.join(userData, 'statistics.json'), 'utf8'));
      assert.equal(stats.totals.completed, 1); assert.equal(stats.totals.encoded, 1);
      assert.ok(stats.totals.outputBytes > 0); assert.equal(stats.recent[0].filename, undefined);
      assert.ok(fs.existsSync(path.join(outputFolder, 'Anime', 'Season 01', 'Episode 01.compatible.mkv')));
      const savedJob = JSON.parse(fs.readFileSync(path.join(userData, 'queue.json'), 'utf8')).items.find(item => item.output);
      assert.ok(Number.isFinite(savedJob.timings.total));
      assert.match(savedJob.conversionReport, /Output audio ordinal/);
      await execute(`document.getElementById('nav-queue').click()`);
      await execute(`location.reload()`);
      await waitFor(`document.readyState === 'complete' && !document.getElementById('workspace').hidden && document.getElementById('active-profile').textContent.includes('Bose Lifestyle V20')`);
      await waitFor(`document.getElementById('theme-select').selectedOptions[0]?.textContent === 'Edited smoke theme'`);
      await waitFor(`!!document.querySelector('textarea[aria-label="Verified audio mapping"]')`);
      assert.equal(await execute(`document.querySelector('textarea[aria-label="Verified audio mapping"]').value`), savedJob.conversionReport);
      assert.equal(await execute(`document.documentElement.classList.contains('compact') && document.documentElement.classList.contains('reduced-motion')`), true);
      assert.equal(await execute(`document.getElementById('destination').textContent`), outputFolder);
      await execute(`document.getElementById('change-setup').click()`);
      assert.equal(await execute(`document.getElementById('allow-downmix').checked && document.getElementById('extract-dts-core').checked && document.querySelector('#excluded-formats input[value="eac3"]').checked && document.querySelector('#downmix-list select[data-field="target"]').value === '3.1'`), true);
      await execute(`document.getElementById('setup-cancel').click()`);
      assert.equal(await execute(`document.documentElement.style.getPropertyValue('--theme-accent')`),'#77bbcc');
      assert.deepEqual(errors, []);
      const screenshot = await capture('final workspace');
      fs.writeFileSync(path.join(os.tmpdir(), 'audiority-desktop-preview.png'), screenshot.toPNG());
      await execute(`document.getElementById('delete-profile').click(); document.getElementById('profile-dialog-form').requestSubmit()`);
      await waitFor(`document.getElementById('profile-count').textContent === '0' && !document.getElementById('setup').hidden && !document.getElementById('profile-dialog').open`);
      assert.equal(await execute(`document.getElementById('workspace').hidden`), true);
      console.log('UI smoke test passed: profiles, folder import, 12 themes, settings/navigation persistence, real conversion/statistics, and reload.');
      clearTimeout(timeout); app.exit(0);
    } catch (error) { console.error(error, errors); clearTimeout(timeout); app.exit(1); }
  });
});
require('../src/main');