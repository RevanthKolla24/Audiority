const test = require('node:test');
const assert = require('node:assert/strict');
const { devices } = require('../src/catalog');

test('Fire TV catalog distinguishes model generations without assuming audio capabilities', () => {
  assert.equal(new Set(devices.map(device => device.id)).size, devices.length);
  const sticks = devices.filter(device => device.name.includes('Fire TV Stick'));
  assert.ok(sticks.length >= 10);
  for (const id of ['fire-tv-stick-4k-max-2021', 'fire-tv-stick-4k-max-2023', 'fire-tv-stick-hd-2024', 'fire-tv-stick-4k-select-2025']) {
    const device = devices.find(record => record.id === id);
    assert.ok(device, id);
    assert.equal(device.status, 'unknown');
    assert.equal(device.codecs, null);
    assert.ok(device.sources.length);
  }
});