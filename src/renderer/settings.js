// Settings rules: defaults and type checks. The Rust side stores the JSON in %APPDATA%\PadReady\settings.json.
'use strict';

const SETTINGS_DEFAULTS = {
  outputDir: '',
  language: 'English',
  deviceIdx: 0,
  sampleRateIdx: 1,
  bitDepthIdx: 0,
  channelsIdx: 0,
  formatIdx: 0,
  normalize: false,
  autoTrim: false,
  reverse: false,
  openDir: true,
  soxPath: '',
  customDevices: [], // the user's own samplers, same shape as the entries in devices.json
};

// Same values as SAMPLE_RATES / BIT_DEPTHS / CHANNELS / FORMATS in renderer.js
function isValidDevice(d) {
  return !!d && typeof d.name === 'string' && d.name.trim() !== ''
    && [12000, 24000, 44100, 48000].includes(d.sampleRate)
    && [16, 24].includes(d.bitDepth)
    && [1, 2].includes(d.channels)
    && [undefined, 'wav', 'aiff'].includes(d.format);
}

// Copies known keys whose type matches the default; anything else is ignored
function mergeSettings(values, patch) {
  for (const key of Object.keys(patch || {})) {
    if (!(key in SETTINGS_DEFAULTS)) continue;
    const def = SETTINGS_DEFAULTS[key];
    if (Array.isArray(def)) {
      if (Array.isArray(patch[key])) values[key] = patch[key].filter(isValidDevice);
    } else if (typeof patch[key] === typeof def) {
      values[key] = patch[key];
    }
  }
  return values;
}

// Settings from the stored JSON text; a missing or broken file gives the defaults
function parseSettings(json, defaults = {}) {
  let stored = null;
  try {
    stored = JSON.parse(json);
  } catch {
    // First run
  }
  return mergeSettings({ ...SETTINGS_DEFAULTS, ...defaults }, stored);
}

if (typeof module !== 'undefined') module.exports = { SETTINGS_DEFAULTS, isValidDevice, mergeSettings, parseSettings };
