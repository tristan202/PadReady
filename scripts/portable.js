// Packs the built app and the bundled SoX-NG into dist/PadReady-<version>-portable.zip.
// Unzip anywhere and run PadReady.exe; it finds SoX in the sox folder next to it. Needs WebView2 (built into Windows 10/11).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { version } = require('../package.json');

const root = path.join(__dirname, '..');
const exe = ['PadReady.exe', 'padready.exe'].map((n) => path.join(root, 'src-tauri', 'target', 'release', n)).find(fs.existsSync);
if (!exe) throw new Error('Build first: npm run dist');

const stage = path.join(root, 'dist', 'portable');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(exe, path.join(stage, 'PadReady.exe'));
fs.cpSync(path.join(root, 'vendor', 'sox'), path.join(stage, 'sox'), { recursive: true });

const zip = path.join(root, 'dist', `PadReady-${version}-portable.zip`);
fs.rmSync(zip, { force: true });
// Windows' own tar.exe (bsdtar) writes zip files with -a
const tar = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe');
const result = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', stage, 'PadReady.exe', 'sox'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`Wrote ${zip}`);
