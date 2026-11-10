'use strict';

const $ = (id) => document.getElementById(id);

let BUILTIN_DEVICES = []; // loaded from devices.json
let customDevices = [];   // the user's own samplers, stored in settings
let DEVICES = [];         // both, in the order of the device list
const SAMPLE_RATES = ['12000', '24000', '44100', '48000'];
const BIT_DEPTHS = [{ label: '16-bit', value: 16 }, { label: '24-bit', value: 24 }];
const CHANNELS = [{ label: 'Mono', value: 1 }, { label: 'Stereo', value: 2 }];
const FORMATS = [{ label: 'WAV', value: 'wav' }, { label: 'AIFF', value: 'aiff' }];

const COLORS = {
  accent: 'rgb(255, 135, 0)',
  waveBack: 'rgb(30, 30, 30)',
  centerLine: 'rgb(70, 70, 70)',
};

const state = {
  strings: {},
  sox: { found: false, ng: false },
  files: [],          // { path, failed, error }
  selected: -1,
  converting: false,
  total: 0,
  outputDir: '',
  playUrl: null,
  waveToken: 0,
  decoded: null,      // AudioBuffer of the selected file, kept for redraws on resize
};

let audioContext = null;

// --- Helpers ---------------------------------------------------------------

function fillSelect(select, items) {
  select.replaceChildren(...items.map((label, i) => new Option(label, String(i))));
}

// Built-in samplers first, then the user's own under their own heading
function fillDevices(selected) {
  DEVICES = [...BUILTIN_DEVICES, ...customDevices];
  const select = $('comboDevice');
  fillSelect(select, BUILTIN_DEVICES.map((d) => d.name));
  if (customDevices.length) {
    const group = document.createElement('optgroup');
    group.label = state.strings.GroupCustom || '';
    group.append(...customDevices.map((d, i) => new Option(d.name, String(BUILTIN_DEVICES.length + i))));
    select.append(group);
  }
  select.selectedIndex = clampIndex(selected, DEVICES.length);
  $('btnDeleteDevice').disabled = select.selectedIndex < BUILTIN_DEVICES.length;
}

function deviceFromSelects(name) {
  return {
    name,
    sampleRate: Number(SAMPLE_RATES[$('comboSampleRate').selectedIndex]),
    bitDepth: BIT_DEPTHS[$('comboBitDepth').selectedIndex].value,
    channels: CHANNELS[$('comboChannels').selectedIndex].value,
    format: FORMATS[$('comboFormat').selectedIndex].value,
  };
}

function splitPath(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

function setStatus(text, kind = '') {
  const el = $('txtStatus');
  el.textContent = text;
  el.className = kind;
}

function setProgress(fraction, kind = '') {
  const bar = $('progressBar');
  bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  bar.className = kind;
}

// Summary of the chosen target format, shown in the convert bar while idle
function targetSummary() {
  return [
    $('comboDevice').selectedOptions[0]?.textContent,
    `${SAMPLE_RATES[$('comboSampleRate').selectedIndex]} Hz`,
    BIT_DEPTHS[$('comboBitDepth').selectedIndex].label,
    CHANNELS[$('comboChannels').selectedIndex].label,
    FORMATS[$('comboFormat').selectedIndex].label,
  ].filter(Boolean).join('  ·  ');
}

function showIdle() {
  if (state.converting) return;
  setStatus(targetSummary(), 'idle');
  setProgress(0);
}

function updateSoxStatus() {
  const s = state.strings;
  const el = $('txtSoxStatus');
  // Short label in the sidebar footer; the full status text and path are in the tooltip
  const full = !state.sox.found ? s.StatusError : state.sox.ng ? s.StatusReadyNG : s.StatusReady;
  el.textContent = !state.sox.found ? s.StatusError : state.sox.ng ? 'SoX-NG' : 'SoX';
  el.className = state.sox.found ? '' : 'error';
  el.title = state.sox.path ? `${full}\n${state.sox.path}` : full;
}

// The path box is right-to-left so long paths are cut at the start; the LRM marks keep
// a trailing backslash at the end instead of moving it to the front
function showOutputDir(dir) {
  $('txtOutputDir').textContent = `\u200E${dir}\u200E`;
  $('txtOutputDir').title = dir;
}

function save(patch) {
  window.api.saveSettings(patch);
}

// --- Language --------------------------------------------------------------

function applyStrings(strings) {
  state.strings = strings;
  const s = strings;
  const text = {
    txtListHeader: s.ListHeader, colName: s.ColName, colPath: s.ColPath,
    btnAddFiles: s.BtnFiles, btnAddFolder: s.BtnFolder, btnClear: s.BtnClear,
    txtFrameOutput: s.FrameOut, btnSetOutputDir: s.BtnChange,
    txtFrameSettings: s.FrameSet, lblDevice: s.LabelDev, lblSampleRate: s.LabelSR,
    lblBitDepth: s.LabelBD, lblChannels: s.LabelCH, lblFormat: s.LabelFmt,
    lblNormalize: s.CheckNorm, lblAutoTrim: s.CheckTrim, lblReverse: s.CheckReverse,
    lblOpenDir: s.CheckOpenDir, btnConvert: s.BtnStart, btnExport: s.BtnExport,
    txtEmptyTitle: s.EmptyTitle, txtEmptyText: s.EmptyText,
  };
  for (const [id, value] of Object.entries(text)) $(id).textContent = value;
  $('btnPreview').title = s.TipPlay;
  $('btnStop').title = s.TipStop;
  $('btnAbout').title = s.MenuAbout;
  $('btnAddDevice').title = s.TipAddDevice;
  $('btnDeleteDevice').title = s.TipDeleteDevice;
  const group = $('comboDevice').querySelector('optgroup');
  if (group) group.label = s.GroupCustom;
  $('langPick').title = s.MenuLang;
  updateSoxStatus();
  updateCount();
}

// --- File list -------------------------------------------------------------

function updateCount() {
  $('txtCount').textContent = state.files.length ? String(state.files.length) : '';
}

function renderList() {
  const body = $('fileListBody');
  body.replaceChildren(...state.files.map((file, i) => {
    const { dir, name } = splitPath(file.path);
    const row = document.createElement('div');
    row.className = 'prow' + (i === state.selected ? ' cursor' : '')
      + (file.failed ? ' failed' : file.done ? ' ok' : '');
    row.dataset.index = String(i);
    row.title = file.error || file.path;
    const nameCell = document.createElement('span');
    nameCell.className = 't';
    nameCell.textContent = name;
    const pathCell = document.createElement('span');
    pathCell.className = 'p';
    pathCell.textContent = dir;
    const statusCell = document.createElement('span');
    statusCell.className = 's';
    statusCell.textContent = file.failed ? '!' : file.done ? '\u2713' : '';
    row.append(nameCell, pathCell, statusCell);
    return row;
  }));
  $('emptyState').hidden = state.files.length > 0;
  updateCount();
}

function addFiles(paths) {
  const known = new Set(state.files.map((f) => f.path.toLowerCase()));
  for (const p of paths) {
    if (known.has(p.toLowerCase())) continue;
    known.add(p.toLowerCase());
    state.files.push({ path: p, done: false, failed: false, error: '' });
  }
  renderList();
}

function selectRow(index) {
  if (index < 0 || index >= state.files.length || index === state.selected) return;
  state.selected = index;
  renderList();
  const row = $('fileListBody').children[index];
  if (row) row.scrollIntoView({ block: 'nearest' });
  previewSelected();
}

// --- Waveform & playback ---------------------------------------------------

function canvasContext() {
  const canvas = $('canvasWave');
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { ctx: canvas.getContext('2d'), width, height };
}

function clearWaveform() {
  state.decoded = null;
  const { ctx, width, height } = canvasContext();
  ctx.fillStyle = COLORS.waveBack;
  ctx.fillRect(0, 0, width, height);
}

function drawWaveform(audioBuffer) {
  state.decoded = audioBuffer;
  const { ctx, width, height } = canvasContext();
  ctx.fillStyle = COLORS.waveBack;
  ctx.fillRect(0, 0, width, height);
  const data = audioBuffer.getChannelData(0);
  const perPixel = data.length / width;
  const mid = height / 2;
  ctx.fillStyle = COLORS.accent;
  for (let x = 0; x < width; x++) {
    const start = Math.floor(x * perPixel);
    const end = Math.max(start + 1, Math.floor((x + 1) * perPixel));
    let min = 0;
    let max = 0;
    for (let i = start; i < end && i < data.length; i++) {
      const v = data[i];
      if (v > max) max = v;
      if (v < min) min = v;
    }
    const y1 = Math.round(mid - max * mid);
    const y2 = Math.round(mid - min * mid);
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  ctx.fillStyle = COLORS.centerLine;
  ctx.fillRect(0, Math.floor(mid), width, Math.max(1, Math.round(window.devicePixelRatio || 1)));
}

function stopPlayback() {
  const player = $('player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  if (state.playUrl) {
    URL.revokeObjectURL(state.playUrl);
    state.playUrl = null;
  }
}

async function loadSelected() {
  const file = state.files[state.selected];
  if (!file) return null;
  try {
    return await window.api.readFile(file.path);
  } catch {
    return null;
  }
}

function play(bytes) {
  stopPlayback();
  state.playUrl = URL.createObjectURL(new Blob([bytes]));
  const player = $('player');
  player.src = state.playUrl;
  player.play().catch(() => {});
}

// Shows the waveform and plays the selected file (what a click in the list did before)
async function previewSelected() {
  const token = ++state.waveToken;
  const bytes = await loadSelected();
  if (token !== state.waveToken) return;
  if (!bytes) {
    clearWaveform();
    return;
  }
  play(bytes);
  try {
    audioContext = audioContext || new AudioContext();
    const decoded = await audioContext.decodeAudioData(bytes.slice().buffer);
    if (token === state.waveToken) drawWaveform(decoded);
  } catch {
    if (token === state.waveToken) clearWaveform();
  }
}

// --- Conversion ------------------------------------------------------------

function currentJob() {
  return {
    files: state.files.map((f) => f.path),
    outputDir: state.outputDir,
    sampleRate: SAMPLE_RATES[$('comboSampleRate').selectedIndex],
    bitDepth: BIT_DEPTHS[$('comboBitDepth').selectedIndex].value,
    channels: CHANNELS[$('comboChannels').selectedIndex].value,
    format: FORMATS[$('comboFormat').selectedIndex].value,
    normalize: $('checkNormalize').checked,
    autoTrim: $('checkAutoTrim').checked,
    reverse: $('checkReverse').checked,
  };
}

async function startConversion() {
  const s = state.strings;
  if (!state.sox.found) {
    state.sox = await window.api.pickSox();
    updateSoxStatus();
    if (!state.sox.found) return;
  }
  if (state.files.length === 0) {
    window.alert(s.MsgNoFiles);
    return;
  }
  const job = currentJob();
  for (const f of state.files) {
    f.done = false;
    f.failed = false;
    f.error = '';
  }
  renderList();
  state.converting = true;
  state.total = job.files.length;
  $('btnConvert').disabled = true;
  $('btnExport').disabled = true;
  setStatus(s.StatusConverting);
  setProgress(0);
  const result = await window.api.convert(job);
  if (!result.started) {
    state.converting = false;
    $('btnConvert').disabled = false;
    if (result.reason === 'output') window.alert(s.MsgOutputError);
    showIdle();
  }
}

window.api.onConvertProgress((p) => {
  setStatus(`${state.strings.StatusConverting}  ${p.index} ${state.strings.WordOf} ${state.total}`);
  setProgress(p.index / state.total);
  const file = state.files.find((f) => f.path === p.file);
  if (file) {
    file.done = p.ok;
    file.failed = !p.ok;
    file.error = p.ok ? '' : p.error;
    renderList();
  }
});

window.api.onExportProgress(({ done, total }) => {
  setStatus(`${state.strings.StatusExporting}  ${done} ${state.strings.WordOf} ${total}`);
  setProgress(done / total);
});

window.api.onConvertDone(({ failures, outputDir }) => {
  const s = state.strings;
  state.converting = false;
  $('btnConvert').disabled = false;
  $('btnExport').disabled = !state.files.some((f) => f.done);
  if (failures.length > 0) {
    setStatus(s.MsgDoneErrors.replace('%ERRORS%', String(failures.length)), 'warning');
    setProgress(1, 'warn');
  } else {
    setStatus(s.MsgDone);
    setProgress(1, 'done');
  }
  if ($('checkOpenDir').checked) window.api.openPath(outputDir);
});


// --- Events ----------------------------------------------------------------

function bindEvents() {
  $('btnAddFiles').addEventListener('click', async () => addFiles(await window.api.pickFiles()));
  $('btnAddFolder').addEventListener('click', async () => addFiles(await window.api.pickFolder()));
  $('btnClear').addEventListener('click', () => {
    state.files = [];
    state.selected = -1;
    state.waveToken++;
    renderList();
    clearWaveform();
    showIdle();
  });
  $('btnPreview').addEventListener('click', async () => {
    const bytes = await loadSelected();
    if (bytes) play(bytes);
  });
  $('btnStop').addEventListener('click', stopPlayback);
  $('btnSetOutputDir').addEventListener('click', async () => {
    const dir = await window.api.pickOutputDir();
    if (dir) {
      state.outputDir = dir;
      showOutputDir(dir);
    }
  });
  $('btnConvert').addEventListener('click', startConversion);
  $('btnExport').addEventListener('click', async () => {
    const s = state.strings;
    // Busy like a conversion, so the status bar keeps showing export progress
    state.converting = true;
    $('btnExport').disabled = true;
    $('btnConvert').disabled = true;
    const result = await window.api.exportZip({
      name: $('comboDevice').selectedOptions[0]?.textContent,
      summary: targetSummary(),
    });
    state.converting = false;
    $('btnExport').disabled = false;
    $('btnConvert').disabled = false;
    if (result.saved) {
      setStatus(s.MsgExportDone.replace('%FILE%', splitPath(result.filePath).name));
      setProgress(1, 'done');
    } else {
      showIdle();
      if (result.error) window.alert(`${s.MsgExportError}\n${result.error}`);
    }
  });
  $('btnAbout').addEventListener('click', () => window.api.showAbout());
  $('langSelect').addEventListener('change', async () => {
    applyStrings(await window.api.setLanguage($('langSelect').value));
    showIdle();
  });
  new ResizeObserver(() => {
    if (state.decoded) drawWaveform(state.decoded);
    else clearWaveform();
  }).observe($('canvasWave'));

  $('fileListBody').addEventListener('click', (e) => {
    const row = e.target.closest('.prow');
    if (row) selectRow(Number(row.dataset.index));
  });
  $('fileList').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') selectRow(Math.min(state.selected + 1, state.files.length - 1));
    else if (e.key === 'ArrowUp') selectRow(Math.max(state.selected - 1, 0));
    else return;
    e.preventDefault();
  });

  $('comboDevice').addEventListener('change', () => {
    const device = DEVICES[$('comboDevice').selectedIndex];
    const idx = {
      sampleRateIdx: SAMPLE_RATES.indexOf(String(device.sampleRate)),
      bitDepthIdx: BIT_DEPTHS.findIndex((b) => b.value === device.bitDepth),
      channelsIdx: CHANNELS.findIndex((c) => c.value === device.channels),
      formatIdx: FORMATS.findIndex((f) => f.value === (device.format || 'wav')),
    };
    $('comboSampleRate').selectedIndex = idx.sampleRateIdx;
    $('comboBitDepth').selectedIndex = idx.bitDepthIdx;
    $('comboChannels').selectedIndex = idx.channelsIdx;
    $('comboFormat').selectedIndex = idx.formatIdx;
    $('btnDeleteDevice').disabled = $('comboDevice').selectedIndex < BUILTIN_DEVICES.length;
    save({ deviceIdx: $('comboDevice').selectedIndex, ...idx });
    showIdle();
  });
  $('btnAddDevice').addEventListener('click', () => {
    const s = state.strings;
    const current = DEVICES[$('comboDevice').selectedIndex];
    const name = window.prompt(s.AskDeviceName, customDevices.includes(current) ? current.name : '')?.trim();
    if (!name) return;
    if (BUILTIN_DEVICES.some((d) => d.name === name)) {
      window.alert(s.MsgDeviceBuiltIn);
      return;
    }
    const device = deviceFromSelects(name);
    // Saving under the name of one of your own replaces it
    const i = customDevices.findIndex((d) => d.name === name);
    customDevices = i < 0 ? [...customDevices, device] : customDevices.map((d, j) => (j === i ? device : d));
    const deviceIdx = BUILTIN_DEVICES.length + (i < 0 ? customDevices.length - 1 : i);
    fillDevices(deviceIdx);
    save({ customDevices, deviceIdx });
    showIdle();
  });
  $('btnDeleteDevice').addEventListener('click', async () => {
    const i = $('comboDevice').selectedIndex - BUILTIN_DEVICES.length;
    // The Tauri dialog plugin makes window.confirm async
    if (i < 0 || !await window.confirm(state.strings.AskDeleteDevice.replace('%NAME%', customDevices[i].name))) return;
    customDevices = customDevices.filter((_, j) => j !== i);
    save({ customDevices });
    // Select the sampler above the deleted one and use its settings
    fillDevices(BUILTIN_DEVICES.length + i - 1);
    $('comboDevice').dispatchEvent(new Event('change'));
  });
  const selects = { comboSampleRate: 'sampleRateIdx', comboBitDepth: 'bitDepthIdx', comboChannels: 'channelsIdx', comboFormat: 'formatIdx' };
  for (const [id, key] of Object.entries(selects)) {
    $(id).addEventListener('change', () => {
      save({ [key]: $(id).selectedIndex });
      // Changes while one of your own samplers is selected are saved into that sampler
      const i = $('comboDevice').selectedIndex - BUILTIN_DEVICES.length;
      if (i >= 0) {
        customDevices = customDevices.map((d, j) => (j === i ? deviceFromSelects(d.name) : d));
        DEVICES = [...BUILTIN_DEVICES, ...customDevices];
        save({ customDevices });
      }
      showIdle();
    });
  }
  const checks = { checkNormalize: 'normalize', checkAutoTrim: 'autoTrim', checkReverse: 'reverse', checkOpenDir: 'openDir' };
  for (const [id, key] of Object.entries(checks)) {
    $(id).addEventListener('change', () => save({ [key]: $(id).checked }));
  }

  // Drag and drop of files and folders anywhere on the window (the window reports the dropped paths)
  window.api.onDragDrop(async ({ type, paths }) => {
    document.body.classList.toggle('dragging', type === 'enter' || type === 'over');
    if (type === 'drop' && paths.length) addFiles(await window.api.expandPaths(paths));
  });
}

// --- Start -----------------------------------------------------------------

function clampIndex(i, length) {
  return Number.isInteger(i) && i >= 0 && i < length ? i : 0;
}

async function init() {
  const { settings, strings, sox, languages, devices } = await window.api.getInitialState();
  BUILTIN_DEVICES = devices;
  customDevices = settings.customDevices;
  state.sox = sox;
  state.outputDir = settings.outputDir;

  fillDevices(settings.deviceIdx);
  fillSelect($('comboSampleRate'), SAMPLE_RATES);
  fillSelect($('comboBitDepth'), BIT_DEPTHS.map((b) => b.label));
  fillSelect($('comboChannels'), CHANNELS.map((c) => c.label));
  fillSelect($('comboFormat'), FORMATS.map((f) => f.label));
  $('langSelect').replaceChildren(...languages.map((l) => new Option(l.label, l.key)));
  $('langSelect').value = settings.language;
  $('comboSampleRate').selectedIndex = clampIndex(settings.sampleRateIdx, SAMPLE_RATES.length);
  $('comboBitDepth').selectedIndex = clampIndex(settings.bitDepthIdx, BIT_DEPTHS.length);
  $('comboChannels').selectedIndex = clampIndex(settings.channelsIdx, CHANNELS.length);
  $('comboFormat').selectedIndex = clampIndex(settings.formatIdx, FORMATS.length);
  $('checkNormalize').checked = settings.normalize;
  $('checkAutoTrim').checked = settings.autoTrim;
  $('checkReverse').checked = settings.reverse;
  $('checkOpenDir').checked = settings.openDir;
  showOutputDir(settings.outputDir);

  applyStrings(strings);
  bindEvents();
  renderList();
  clearWaveform();
  showIdle();
}

init();
