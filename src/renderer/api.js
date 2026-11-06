// Bridge to the Rust side (src-tauri) with the same window.api calls the Electron preload had.
// Needs i18n.js and settings.js loaded first.
'use strict';

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  let settings = null;
  let strings = null;
  let version = '';

  function saveSettings(patch) {
    mergeSettings(settings, patch);
    invoke('save_settings', { json: JSON.stringify(settings, null, 2) }).catch(() => {
      // Not fatal: the app keeps working with the settings in memory
    });
    return settings;
  }

  window.api = {
    async getInitialState() {
      const env = await invoke('get_initial_state');
      settings = parseSettings(env.settingsJson, { outputDir: env.defaultOutputDir });
      strings = getStrings(settings.language);
      version = env.version;
      const devices = await (await fetch('devices.json')).json();
      return { settings, strings, languages: LANGUAGES, devices, sox: env.sox, version };
    },
    saveSettings,
    setLanguage(language) {
      saveSettings({ language });
      strings = getStrings(settings.language);
      return strings;
    },
    showAbout: () => invoke('show_about', {
      title: strings.MenuAbout,
      message: `PadReady v${version}\n\n${strings.AboutTxt}\n${strings.License}\n${strings.SoxNotice}`,
    }),
    pickFiles: () => invoke('pick_files', { title: strings.BtnFiles, audioName: strings.FilterAudio, allName: strings.FilterAll }),
    pickFolder: () => invoke('pick_folder', { title: strings.BtnFolder }),
    expandPaths: (paths) => invoke('expand_paths', { paths }),
    async pickOutputDir() {
      const dir = await invoke('pick_output_dir', { title: strings.BtnChange, current: settings.outputDir });
      if (dir) saveSettings({ outputDir: dir });
      return dir;
    },
    async pickSox() {
      const before = settings.soxPath;
      const sox = await invoke('pick_sox', { title: strings.FindSox });
      if (sox.found && sox.path !== before) saveSettings({ soxPath: sox.path });
      return sox;
    },
    readFile: async (path) => new Uint8Array(await invoke('read_file', { path })),
    openPath: (dir) => invoke('open_path', { dir }),
    convert: (job) => invoke('convert', { job }),
    exportZip: ({ name, summary }) => invoke('export_zip', {
      title: strings.BtnExport, name: name || '', outputDir: settings.outputDir, summary,
    }),
    onConvertProgress: (cb) => listen('convert-progress', (e) => cb(e.payload)),
    onExportProgress: (cb) => listen('export-progress', (e) => cb(e.payload)),
    onConvertDone: (cb) => listen('convert-done', (e) => cb(e.payload)),
    // Files dropped on the window; the payload type is enter, over, drop or leave
    onDragDrop: (cb) => window.__TAURI__.webview.getCurrentWebview().onDragDropEvent((e) => cb(e.payload)),
  };
})();
