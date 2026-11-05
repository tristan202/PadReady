// Settings are stored as JSON in the user data folder (%APPDATA%\PadReady on Windows).

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
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

class Settings {
  constructor(dir, defaults = {}) {
    this.file = path.join(dir, 'settings.json');
    this.values = { ...DEFAULTS, ...defaults };
  }

  load() {
    let stored = null;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // First run
    }
    if (stored) {
      for (const key of Object.keys(DEFAULTS)) {
        if (key in stored && typeof stored[key] === typeof DEFAULTS[key]) this.values[key] = stored[key];
      }
    }
    return this.values;
  }

  update(patch) {
    for (const key of Object.keys(patch)) {
      if (key in DEFAULTS && typeof patch[key] === typeof DEFAULTS[key]) this.values[key] = patch[key];
    }
    this.save();
    return this.values;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    } catch {
      // Not fatal: the app keeps working with the settings in memory
    }
  }
}

module.exports = { Settings, DEFAULTS };
