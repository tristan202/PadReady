// Tests for the pure renderer modules. SoX, file listing and zip export are tested in Rust: `npm run test:rust`.
const test = require('node:test');
const assert = require('node:assert');
const { parseSettings, mergeSettings } = require('../src/renderer/settings');
const { STRINGS } = require('../src/renderer/i18n');

test('settings keep valid values and ignore bad ones', () => {
  const settings = parseSettings('{"deviceIdx": 2, "bogus": 1, "normalize": "yes"}', { outputDir: 'C:\out' });
  assert.strictEqual(settings.deviceIdx, 2);
  assert.strictEqual(settings.normalize, false); // 'yes' is not a boolean, so it is ignored
  assert.strictEqual(settings.outputDir, 'C:\out');
  assert.ok(!('bogus' in settings));
  mergeSettings(settings, { language: 'Dansk', openDir: 'no' });
  assert.strictEqual(settings.language, 'Dansk');
  assert.strictEqual(settings.openDir, true);
});

test('a missing or broken settings file gives the defaults', () => {
  assert.strictEqual(parseSettings('').language, 'English');
  assert.strictEqual(parseSettings('{oops').sampleRateIdx, 1);
});

test('every language has every string', () => {
  const keys = Object.keys(STRINGS.English).sort();
  for (const [lang, strings] of Object.entries(STRINGS)) {
    assert.deepStrictEqual(Object.keys(strings).sort(), keys, lang);
  }
});

test('devices.json entries use values the app offers', () => {
  const devices = require('../src/renderer/devices.json');
  assert.ok(devices.length > 0);
  const names = new Set();
  for (const d of devices) {
    assert.ok(typeof d.name === 'string' && d.name.trim(), `missing name: ${JSON.stringify(d)}`);
    assert.ok(!names.has(d.name), `duplicate name: ${d.name}`);
    names.add(d.name);
    // Must match SAMPLE_RATES / BIT_DEPTHS / CHANNELS in src/renderer/renderer.js
    assert.ok([12000, 24000, 44100, 48000].includes(d.sampleRate), `${d.name}: sampleRate ${d.sampleRate}`);
    assert.ok([16, 24].includes(d.bitDepth), `${d.name}: bitDepth ${d.bitDepth}`);
    assert.ok([1, 2].includes(d.channels), `${d.name}: channels ${d.channels}`);
    assert.ok([undefined, 'wav', 'aiff'].includes(d.format), `${d.name}: format ${d.format}`);
  }
});
