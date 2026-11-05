// Downloads the official SoX-NG Windows build and its source into vendor/ so electron-builder
// can bundle SoX with PadReady. Runs before every `npm run dist*`. Files are checked by SHA-256.
//
// SoX-NG is GPL v2. Its source tarball is kept in vendor/ so it can be attached to each release.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = '14.7.2';
const BASE = `https://codeberg.org/sox_ng/sox_ng/releases/download/sox_ng-${VERSION}`;
const FILES = {
  [`sox_ng-${VERSION}-win64-exe.zip`]: '0447a4546066fa1d23634dabceeb7ead0b98389cdc6e9d2c33d037e11e7e86ff',
  [`sox_ng-${VERSION}.tar.gz`]: '16491fddcff8ed2f87bf37799d2e6de2531306e2bc60fb7fc360061511be4763',
};
// Files from the zip that go into the app; COPYING is the GPL text that must ship with SoX
const KEEP = ['sox_ng.exe', 'COPYING', 'AUTHORS', 'README', 'README.win32'];

const vendor = path.join(__dirname, '..', 'vendor');
const soxDir = path.join(vendor, 'sox');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function download(name, hash) {
  const file = path.join(vendor, name);
  if (fs.existsSync(file) && sha256(file) === hash) return file;
  console.log(`Downloading ${BASE}/${name}`);
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== hash) throw new Error(`${name}: SHA-256 is ${actual}, expected ${hash}`);
  fs.writeFileSync(file, data);
  return file;
}

async function main() {
  fs.mkdirSync(vendor, { recursive: true });
  const [zip] = await Promise.all(Object.entries(FILES).map(([name, hash]) => download(name, hash)));
  fs.rmSync(soxDir, { recursive: true, force: true });
  fs.mkdirSync(soxDir);
  // bsdtar reads zip files; Windows ships it as System32\tar.exe (Git Bash's GNU tar does not)
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar';
  const result = spawnSync(tar, ['-xf', zip, '-C', soxDir, ...KEEP], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not extract ${zip}: ${result.stderr || result.error}`);
  for (const name of KEEP) {
    if (!fs.existsSync(path.join(soxDir, name))) throw new Error(`${name} missing from ${zip}`);
  }
  console.log(`SoX-NG ${VERSION} ready in ${soxDir}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
