// PadReady: runs SoX, lists audio files, shows dialogs and writes zip kits.
// The UI, strings and settings rules live in src/renderer; this side only stores the settings JSON.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sox;

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogKind};

#[derive(Default)]
struct AppState {
    sox: Mutex<PathBuf>,
    busy: AtomicBool,                 // a conversion or zip export is running
    last_outputs: Mutex<Vec<PathBuf>>, // files written by the last conversion, for Export as Zip
    child: Arc<sox::ChildSlot>,
}

#[derive(Serialize)]
struct SoxStatus {
    path: String,
    found: bool,
    ng: bool,
}

fn sox_status(sox: &Path) -> SoxStatus {
    let found = !sox.as_os_str().is_empty();
    SoxStatus { path: sox.to_string_lossy().into(), found, ng: found && sox::is_sox_ng(sox) }
}

// Same file the Electron versions used (%APPDATA%\PadReady\settings.json), so settings carry over
fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().config_dir().map_err(|e| e.to_string())?.join("PadReady").join("settings.json"))
}

// Folders searched for sox_ng/sox before the default install folder and PATH
fn app_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)).into_iter().collect();
    dirs.extend(std::env::current_dir().ok());
    dirs.dedup();
    dirs
}

// SoX-NG bundled from vendor/sox; only used when no other SoX is found, so the user's own SoX wins
fn bundled_sox(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) { "sox_ng.exe" } else { "sox_ng" };
    let mut dirs: Vec<PathBuf> = app.path().resource_dir().ok().map(|d| d.join("sox")).into_iter().collect();
    if cfg!(debug_assertions) {
        dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/sox"));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

fn resolve_sox(app: &AppHandle, saved: &str) -> PathBuf {
    if !saved.is_empty() {
        let saved = Path::new(saved);
        let candidates = if saved.is_absolute() { vec![saved.to_path_buf()] } else { app_dirs().iter().map(|d| d.join(saved)).collect() };
        if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
            return found;
        }
    }
    sox::find_sox(&app_dirs()).or_else(|| bundled_sox(app)).unwrap_or_default()
}

fn strings(paths: Vec<PathBuf>) -> Vec<String> {
    paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

fn into_paths(picked: Option<Vec<FilePath>>) -> Vec<PathBuf> {
    picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect()
}

#[tauri::command]
fn get_initial_state(app: AppHandle, state: State<AppState>) -> Result<Value, String> {
    let settings = std::fs::read_to_string(settings_file(&app)?).unwrap_or_default();
    let documents = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(json!({
        "settingsJson": settings,
        "defaultOutputDir": documents.join("PadReady"),
        "sox": sox_status(&state.sox.lock().unwrap()),
        "version": app.package_info().version.to_string(),
    }))
}

#[tauri::command]
fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    let file = settings_file(&app)?;
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn show_about(app: AppHandle, title: String, message: String) {
    app.dialog().message(message).title(title).kind(MessageDialogKind::Info).blocking_show();
}

#[tauri::command(async)]
fn pick_files(app: AppHandle, title: String, audio_name: String, all_name: String) -> Vec<String> {
    let picked = app.dialog().file().set_title(title)
        .add_filter(audio_name, sox::AUDIO_EXTENSIONS)
        .add_filter(all_name, &["*"])
        .blocking_pick_files();
    strings(sox::expand_paths(&into_paths(picked)))
}

#[tauri::command(async)]
fn pick_folder(app: AppHandle, title: String) -> Vec<String> {
    let picked = app.dialog().file().set_title(title).blocking_pick_folder();
    strings(sox::expand_paths(&into_paths(picked.map(|p| vec![p]))))
}

#[tauri::command(async)]
fn expand_paths(paths: Vec<PathBuf>) -> Vec<String> {
    strings(sox::expand_paths(&paths))
}

#[tauri::command(async)]
fn pick_output_dir(app: AppHandle, title: String, current: String) -> Option<String> {
    let picked = app.dialog().file().set_title(title).set_directory(current).blocking_pick_folder();
    into_paths(picked.map(|p| vec![p])).pop().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command(async)]
fn pick_sox(app: AppHandle, state: State<AppState>, title: String) -> SoxStatus {
    let mut dialog = app.dialog().file().set_title(title);
    dialog = if cfg!(windows) {
        dialog.set_directory(r"C:\").add_filter("SoX (sox.exe, sox_ng.exe)", &["exe"])
    } else {
        dialog.set_directory("/usr/bin")
    };
    let picked = into_paths(dialog.blocking_pick_file().map(|p| vec![p])).pop();
    let mut sox = state.sox.lock().unwrap();
    if let Some(picked) = picked {
        *sox = picked;
    }
    sox_status(&sox)
}

#[tauri::command(async)]
fn read_file(path: PathBuf) -> Result<Response, String> {
    Ok(Response::new(std::fs::read(path).map_err(|e| e.to_string())?))
}

#[tauri::command]
fn open_path(dir: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn convert(app: AppHandle, state: State<AppState>, job: sox::Job) -> Value {
    let sox = state.sox.lock().unwrap().clone();
    if sox.as_os_str().is_empty() {
        return json!({ "started": false, "reason": "sox" });
    }
    if state.busy.swap(true, Ordering::SeqCst) {
        return json!({ "started": false, "reason": "busy" });
    }
    if !sox::ensure_directory(Path::new(&job.output_dir)) {
        state.busy.store(false, Ordering::SeqCst);
        return json!({ "started": false, "reason": "output" });
    }
    state.last_outputs.lock().unwrap().clear();
    let slot = state.child.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let failures = sox::convert_all(&sox, &job, &slot, |p| {
            if p.ok {
                state.last_outputs.lock().unwrap().push(PathBuf::from(&p.output));
            }
            let _ = app.emit("convert-progress", &p);
        });
        state.busy.store(false, Ordering::SeqCst);
        let _ = app.emit("convert-done", json!({ "failures": failures, "outputDir": job.output_dir }));
    });
    json!({ "started": true })
}

#[tauri::command(async)]
fn export_zip(app: AppHandle, state: State<AppState>, title: String, name: String, output_dir: String, summary: String) -> Value {
    if state.last_outputs.lock().unwrap().is_empty() || state.busy.swap(true, Ordering::SeqCst) {
        return json!({ "saved": false });
    }
    let picked = app.dialog().file().set_title(title).set_directory(&output_dir)
        .set_file_name(format!("{}_kit.zip", sox::clean_file_name(if name.is_empty() { "kit" } else { &name })))
        .add_filter("Zip", &["zip"])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok());
    let result = match picked {
        None => json!({ "saved": false }),
        Some(zip_path) => {
            let mut entries: Vec<sox::Entry> = state.last_outputs.lock().unwrap().iter()
                .map(|f| sox::Entry::File(f.file_name().unwrap().to_string_lossy().into(), f.clone()))
                .collect();
            let version = app.package_info().version.to_string();
            let readme = [summary.as_str(), "", &format!("Converted with PadReady {version}"), "https://github.com/tristan202/PadReady", ""].join("\r\n");
            entries.push(sox::Entry::Data("README.txt".into(), readme.into_bytes()));
            match sox::write_zip(&zip_path, &entries, |done, total| {
                let _ = app.emit("export-progress", json!({ "done": done, "total": total }));
            }) {
                Ok(()) => json!({ "saved": true, "filePath": zip_path }),
                Err(error) => json!({ "saved": false, "error": error }),
            }
        }
    };
    state.busy.store(false, Ordering::SeqCst);
    result
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle();
            let saved: Value = std::fs::read_to_string(settings_file(handle)?).ok()
                .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            *app.state::<AppState>().sox.lock().unwrap() = resolve_sox(handle, saved["soxPath"].as_str().unwrap_or(""));
            if let Some(window) = app.get_webview_window("main") {
                window.set_title(&format!("PadReady v{}", app.package_info().version))?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_state, save_settings, show_about, pick_files, pick_folder, expand_paths,
            pick_output_dir, pick_sox, read_file, open_path, convert, export_zip
        ])
        .build(tauri::generate_context!())
        .expect("error while building PadReady")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<AppState>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
