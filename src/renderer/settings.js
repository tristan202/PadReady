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
};

// Copies known keys whose type matches the default; anything else is ignored
function mergeSettings(values, patch) {
  for (const key of Object.keys(patch || {})) {
    if (key in SETTINGS_DEFAULTS && typeof patch[key] === typeof SETTINGS_DEFAULTS[key]) values[key] = patch[key];
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

if (typeof module !== 'undefined') module.exports = { SETTINGS_DEFAULTS, mergeSettings, parseSettings };
