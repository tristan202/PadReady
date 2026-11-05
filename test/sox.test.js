const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sox = require('../src/main/sox');
const { Settings } = require('../src/main/settings');
const { STRINGS } = require('../src/main/i18n');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'padready-'));
}

// 16-bit PCM WAV: silence, a sine burst, then silence
function writeTestWav(file, { rate = 44100, channels = 2, seconds = 1 } = {}) {
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const inBurst = i > frames * 0.25 && i < frames * 0.75;
    const v = inBurst ? Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000) : 0;
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function readWavFormat(file) {
  const buf = fs.readFileSync(file);
  let offset = 12;
  const format = {};
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      format.channels = buf.readUInt16LE(offset + 10);
      format.rate = buf.readUInt32LE(offset + 12);
      format.bits = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      format.frames = size / (format.channels * (format.bits / 8));
      break;
    }
    offset += 8 + size + (size & 1);
  }
  return format;
}

test('cleanFileName replaces spaces and invalid characters', () => {
  assert.strictEqual(sox.cleanFileName(path.join('x', 'My Kick: 01?.wav')), 'My_Kick__01_');
});

test('uniqueOutputName adds a counter instead of overwriting', () => {
  const dir = tempDir();
  const first = sox.uniqueOutputName(dir, 'kick', '_rev');
  assert.strictEqual(path.basename(first), 'kick_rev.wav');
  fs.writeFileSync(first, '');
  assert.strictEqual(path.basename(sox.uniqueOutputName(dir, 'kick', '_rev')), 'kick_rev_001.wav');
  assert.strictEqual(path.basename(sox.uniqueOutputName(dir, 'kick', '', 'aiff')), 'kick.aiff');
});

test('buildArgs matches the original SoX command line', () => {
  const args = sox.buildArgs('in.wav', 'out.wav', {
    normalize: true, autoTrim: true, reverse: true, bitDepth: 16, channels: 1, sampleRate: '24000',
  });
  assert.deepStrictEqual(args, [
    '--norm', 'in.wav', '-b', '16', 'out.wav', 'channels', '1', 'rate', '24000',
    'silence', '1', '0.1', '1%', 'reverse', 'silence', '1', '0.1', '1%', 'reverse', 'reverse',
  ]);
});

test('expandPaths scans folders and skips non-audio files', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'b.WAV'), '');
  fs.writeFileSync(path.join(dir, 'a.mp3'), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'c.wav'), '');
  const result = sox.expandPaths([dir, path.join(dir, 'notes.txt')]).map((p) => path.basename(p));
  assert.deepStrictEqual(result, ['a.mp3', 'b.WAV']);
});

test('settings are saved and bad values are ignored', () => {
  const dir = tempDir();
  const settings = new Settings(dir);
  settings.load();
  settings.update({ deviceIdx: 2, bogus: 1, normalize: 'yes' });
  const reloaded = new Settings(dir).load();
  assert.strictEqual(reloaded.deviceIdx, 2);
  assert.strictEqual(reloaded.normalize, false); // 'yes' is not a boolean, so it is ignored
  assert.ok(!('bogus' in reloaded));
});

test('every language has every string', () => {
  const keys = Object.keys(STRINGS.English).sort();
  for (const [lang, strings] of Object.entries(STRINGS)) {
    assert.deepStrictEqual(Object.keys(strings).sort(), keys, lang);
  }
});

const soxPath = sox.findSox([path.join(__dirname, '..')]);

test('converts a WAV for the Lofi-12 XT with SoX', { skip: !soxPath && 'SoX not found' }, async () => {
  const dir = tempDir();
  const input = path.join(dir, 'Test Sample.wav');
  const broken = path.join(dir, 'broken.wav');
  writeTestWav(input);
  fs.writeFileSync(broken, 'not audio');
  const outputDir = path.join(dir, 'out');
  assert.ok(sox.ensureDirectory(outputDir));
  const progress = [];
  const failures = await sox.convertAll({
    soxPath, files: [input, broken], outputDir,
    sampleRate: '24000', bitDepth: 16, channels: 1, normalize: true, autoTrim: true, reverse: false,
  }, (p) => progress.push(p));

  assert.strictEqual(progress.length, 2);
  assert.strictEqual(failures.length, 1);
  assert.strictEqual(failures[0].file, broken);
  assert.ok(failures[0].error.length > 0);

  const output = path.join(outputDir, 'Test_Sample.wav');
  const format = readWavFormat(output);
  assert.strictEqual(format.rate, 24000);
  assert.strictEqual(format.channels, 1);
  assert.strictEqual(format.bits, 16);
  // Auto-Trim removes the silence around the 0.5 s burst
  assert.ok(format.frames > 24000 * 0.4 && format.frames < 24000 * 0.6, `frames=${format.frames}`);
});

test('devices.json entries use values the app offers', () => {
  const devices = require('../src/main/devices.json');
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

const { writeZip } = require('../src/main/zip');
const { spawnSync } = require('child_process');
// bsdtar reads zip files (GNU tar from Git Bash does not), so use the one Windows ships
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar';
const hasTar = spawnSync(tar, ['--version']).status === 0;

test('writeZip writes a zip that tar can extract and reports progress', { skip: !hasTar && 'bsdtar not found' }, async () => {
  const dir = tempDir();
  const big = Buffer.alloc(100000, 7);
  const kick = path.join(dir, 'kick.wav');
  fs.writeFileSync(kick, big);
  const zipFile = path.join(dir, 'kit.zip');
  const progress = [];
  await writeZip(zipFile, [
    { name: 'kick.wav', file: kick },
    { name: 'README.txt', data: Buffer.from('Lofi-12 XT · 24000 Hz') },
  ], (done, total) => progress.push(`${done}/${total}`));
  assert.deepStrictEqual(progress, ['1/2', '2/2']);
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const result = spawnSync(tar, ['-xf', zipFile, '-C', out]);
  assert.strictEqual(result.status, 0, String(result.stderr));
  assert.ok(fs.readFileSync(path.join(out, 'kick.wav')).equals(big));
  assert.strictEqual(fs.readFileSync(path.join(out, 'README.txt'), 'utf8'), 'Lofi-12 XT · 24000 Hz');
});

test('converts to AIFF for the OP-1 with SoX', { skip: !soxPath && 'SoX not found' }, async () => {
  const dir = tempDir();
  const input = path.join(dir, 'kick.wav');
  writeTestWav(input);
  const failures = await sox.convertAll({
    soxPath, files: [input], outputDir: dir, format: 'aiff',
    sampleRate: '44100', bitDepth: 16, channels: 1, normalize: false, autoTrim: false, reverse: false,
  });
  assert.deepStrictEqual(failures, []);
  const header = fs.readFileSync(path.join(dir, 'kick.aiff')).subarray(0, 12);
  assert.strictEqual(header.toString('ascii', 0, 4), 'FORM');
  assert.strictEqual(header.toString('ascii', 8, 12), 'AIFF');
});

test('writeZip removes the half-written zip when a file is missing', async () => {
  const dir = tempDir();
  const zipFile = path.join(dir, 'kit.zip');
  await assert.rejects(writeZip(zipFile, [{ name: 'gone.wav', file: path.join(dir, 'gone.wav') }]));
  assert.ok(!fs.existsSync(zipFile));
});
