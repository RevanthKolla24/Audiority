const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { defaultSettings } = require('../src/profiles');
const { saveSettings } = require('../src/settings');
const { emptyLibrary, mutateLibrary, validateLibrary, loadLibrary, saveLibrary } = require('../src/profile-library');
const settings = () => ({ ...defaultSettings(), receiverId: 'bose-lifestyle-v20' });
test('create, rename, duplicate, edit, switch and delete independent profiles', () => {
  let library = mutateLibrary(emptyLibrary(), { type: 'save', name: 'Living room', settings: settings() });
  const first = library.activeId;
  library = mutateLibrary(library, { type: 'duplicate', id: first, name: 'Bedroom' });
  const second = library.activeId;
  library = mutateLibrary(library, { type: 'rename', id: second, name: ' Bedroom TV ' });
  assert.equal(library.profiles[1].name, 'Bedroom TV');
  library = mutateLibrary(library, { type: 'save', id: second, name: 'Bedroom TV', settings: { ...settings(), pcmBits: 16 } });
  assert.equal(library.profiles[0].settings.pcmBits, 24);
  library = mutateLibrary(library, { type: 'switch', id: first }); assert.equal(library.activeId, first);
  library = mutateLibrary(library, { type: 'delete', id: first }); assert.equal(library.activeId, second);
  library = mutateLibrary(library, { type: 'delete', id: second }); assert.deepEqual(library, emptyLibrary());
});
test('no artificial profile-count cap and invalid operations do not mutate input', () => {
  const profiles = Array.from({ length: 1000 }, (_, i) => ({ id: `profile-${i}`, name: `Room ${i}`, settings: settings() }));
  const library = validateLibrary({ version: 2, activeId: 'profile-0', profiles });
  const next = mutateLibrary(library, { type: 'save', name: 'Another room', settings: settings() });
  assert.equal(next.profiles.length, 1001); assert.equal(library.profiles.length, 1000);
  for (const action of [{ type: 'rename', id: 'profile-0', name: ' ' }, { type: 'delete', id: 'missing' }, { type: 'bad' }]) assert.throws(() => mutateLibrary(library, action));
});
test('legacy migration, persistence, backup and corrupt-library protection', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-library-'));
  try {
    assert.deepEqual((await loadLibrary(directory)).library, emptyLibrary());
    await saveSettings(directory, settings());
    const migrated = (await loadLibrary(directory)).library;
    assert.equal(migrated.profiles[0].name, 'My playback setup');
    const next = mutateLibrary(migrated, { type: 'duplicate', id: migrated.activeId });
    await saveLibrary(directory, next);
    assert.deepEqual((await loadLibrary(directory)).library, next);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'playback-profiles.json.backup'), 'utf8')), migrated);
    await fs.writeFile(path.join(directory, 'playback-profiles.json'), '{broken');
    assert.match((await loadLibrary(directory)).warning, /not been overwritten/);
    await assert.rejects(saveLibrary(directory, next), /unreadable/);
    assert.equal(await fs.readFile(path.join(directory, 'playback-profiles.json'), 'utf8'), '{broken');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});