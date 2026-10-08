const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { builtins, defaults, validateTheme, mutateThemes, saveThemes, loadThemes, contrast } = require('../src/themes');
const { discoverMedia, resolveOutputDirectory } = require('../src/imports');
const collect = async generator => { const result = []; for await (const item of generator) result.push(item); return result; };

test('themes validate colors, strip code, persist edits and restore default on deletion', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-theme-'));
  try {
    assert.equal((await loadThemes(directory)).state.activeId, 'warm-light');
    const theme = { ...builtins[1], version: 1, name: 'My dark theme', css: 'url(evil)' };
    assert.equal(validateTheme(theme).css, undefined);
    assert.throws(() => validateTheme({ ...theme, colors: { ...theme.colors, text: 'url(evil)' } }), /color/);
    let state = mutateThemes(defaults(), { type: 'save', theme });
    const id = state.activeId;
    state = mutateThemes(state, { type: 'save', id, theme: { ...theme, name: 'Edited' } });
    await saveThemes(directory, state);
    assert.deepEqual((await loadThemes(directory)).state, state);
    state = mutateThemes(state, { type: 'delete', id }); assert.equal(state.activeId, 'warm-light');
    assert.throws(() => mutateThemes(state, { type: 'delete', id: 'warm-light' }));
    assert.throws(() => mutateThemes(state, { type: 'select', id: 'unknown' }));
    assert.ok(contrast('#ffffff','#000000') > 20);
    await fs.writeFile(path.join(directory,'appearance.json'), 'broken');
    assert.ok((await loadThemes(directory)).warning);
    await assert.rejects(saveThemes(directory,state), /unreadable/);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test('recursive folder discovery: sidecars, season structure, duplicates, symlinks and generated files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-discover-'));
  try {
    const root = path.join(directory,'Anime'); const season = path.join(root,'Season 01');
    const out = path.join(root,'Output'); await fs.mkdir(season,{recursive:true}); await fs.mkdir(out);
    for (const file of ['Episode 01.mkv','Episode 02.mp4','Episode 01.eng.forced.ass','Episode 02.srt','poster.jpg','Episode 01.audiority.mkv','font.otf']) await fs.writeFile(path.join(season,file),'test');
    await fs.writeFile(path.join(out,'old.audiority.mkv'),'test');
    await fs.symlink(root,path.join(season,'loop'));
    const warnings = [], progress = [];
    const result = await collect(discoverMedia([root, path.join(season,'Episode 01.mkv')], { outputDirectory:out, onWarning:w => warnings.push(w), onProgress:p => progress.push(p) }));
    assert.equal(result.length,2); assert.equal(result[0].relativeDirectory,path.join('Anime','Season 01'));
    assert.equal(result[0].sidecars[0].suffix,'.eng.forced.ass');
    assert.ok(result[0].warnings.some(w => /External fonts/.test(w)));
    assert.ok(!warnings.some(w => /symbolic link/.test(w))); assert.ok(!warnings.some(w => /output folder/.test(w)));
    assert.ok(progress.length);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(collect(discoverMedia([root], { signal:cancelled.signal })), /Cancelled/);
    const during = new AbortController();
    await assert.rejects(collect(discoverMedia([root], { signal:during.signal, onProgress:() => during.abort() })), /Cancelled/);
    assert.deepEqual(await collect(discoverMedia([path.join(root,'missing')], { onWarning:w => warnings.push(w) })),[]);
    assert.ok(warnings.some(w => /Cannot read/.test(w)));
    await fs.writeFile(path.join(season,'Episode 01.mp4'),'test');
    const ambiguous = await collect(discoverMedia([root],{outputDirectory:out}));
    assert.equal(ambiguous[0].sidecars.length,0); assert.ok(ambiguous[0].warnings.some(w => /Ambiguous/.test(w)));
    const resolved = await resolveOutputDirectory(out,path.join('Anime','Season 02')); assert.ok(resolved.endsWith(path.join('Anime','Season 02')));
    await assert.rejects(resolveOutputDirectory(out,'../escape'), /Unsafe/);
    await fs.symlink(season,path.join(out,'linked'));
    await assert.rejects(resolveOutputDirectory(out,'linked'), /symbolic/);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test('same-folder imports retain sources and skip generated outputs including custom suffixes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-same-folder-'));
  try {
    const nested = path.join(directory, 'Season 01'); await fs.mkdir(nested);
    for (const name of ['Episode.mkv', 'Episode.audiority.mkv', 'Episode.audiority (1).mkv', 'Episode.partial.mkv', 'Episode.compatible.mkv', 'Episode.compatible (2).mkv']) await fs.writeFile(path.join(directory, name), 'test');
    await fs.writeFile(path.join(nested, 'Episode 02.mp4'), 'test');
    const options = { outputDirectory: directory, outputSuffix: '.compatible' };
    const result = await collect(discoverMedia([directory], options));
    assert.deepEqual(result.map(item => path.basename(item.file)), ['Episode.mkv', 'Episode 02.mp4']);
    const direct = await collect(discoverMedia([path.join(directory, 'Episode.mkv')], options));
    assert.equal(direct.length, 1);
    const childOutput = await collect(discoverMedia([directory], { ...options, outputDirectory: nested }));
    assert.equal(childOutput.length, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});