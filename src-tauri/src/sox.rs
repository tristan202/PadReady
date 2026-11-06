// SoX helpers: locating the executable, building arguments, running conversions and writing zip kits.
// Kept free of Tauri so it can be unit tested with `cargo test`.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

pub const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "flac", "ogg", "wma", "m4a"];
#[cfg(windows)]
const SOX_NAMES: [&str; 2] = ["sox_ng.exe", "sox.exe"];
#[cfg(not(windows))]
const SOX_NAMES: [&str; 2] = ["sox_ng", "sox"];
const WINDOWS_SOX_DIR: &str = r"C:\Program Files (x86)\sox-14-4-2";

pub fn is_audio_file(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Finds sox_ng/sox in the given folders, then the default Windows install folder, then PATH.
pub fn find_sox(search_dirs: &[PathBuf]) -> Option<PathBuf> {
    let mut dirs = search_dirs.to_vec();
    if cfg!(windows) {
        dirs.push(PathBuf::from(WINDOWS_SOX_DIR));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    SOX_NAMES.iter().flat_map(|name| dirs.iter().map(move |d| d.join(name))).find(|c| c.is_file())
}

pub fn is_sox_ng(sox: &Path) -> bool {
    sox.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().starts_with("sox_ng"))
}

/// File names compared case-insensitively with numbers by value, so "kick 2" comes before "kick 10".
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut n = String::new();
                    while let Some(c) = it.next_if(|c| c.is_ascii_digit()) {
                        n.push(c);
                    }
                    n.trim_start_matches('0').to_string()
                };
                let (nx, ny) = (take(&mut a), take(&mut b));
                let ord = nx.len().cmp(&ny.len()).then(nx.cmp(&ny));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                a.next();
                b.next();
            }
        }
    }
}

/// Lists audio files in a folder (not recursive, like "Add Folder" always did).
fn scan_directory(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter(|p| is_audio_file(p))
        .collect();
    files.sort_by(|a, b| natural_cmp(&a.file_name().unwrap().to_string_lossy(), &b.file_name().unwrap().to_string_lossy()));
    files
}

/// Turns dropped/picked paths into a flat list of audio files; folders are scanned.
pub fn expand_paths(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut result = vec![];
    for p in paths {
        if p.is_dir() {
            result.extend(scan_directory(p));
        } else if p.is_file() && is_audio_file(p) {
            result.push(p.clone());
        }
    }
    result
}

pub fn clean_file_name(full_path: &str) -> String {
    let base = Path::new(full_path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let cleaned: String = base.chars().map(|c| if c.is_whitespace() || r#"\/:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    if cleaned.is_empty() { "sample".into() } else { cleaned }
}

pub fn unique_output_name(output_dir: &Path, base: &str, suffix: &str, ext: &str) -> PathBuf {
    (0..)
        .map(|n| match n {
            0 => output_dir.join(format!("{base}{suffix}.{ext}")),
            n => output_dir.join(format!("{base}{suffix}_{n:03}.{ext}")),
        })
        .find(|c| !c.exists())
        .unwrap()
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub files: Vec<String>,
    pub output_dir: String,
    pub sample_rate: String,
    pub bit_depth: u32,
    pub channels: u32,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub normalize: bool,
    #[serde(default)]
    pub auto_trim: bool,
    #[serde(default)]
    pub reverse: bool,
}

pub fn build_args(input: &str, output: &str, job: &Job) -> Vec<String> {
    let mut args: Vec<String> = vec![];
    if job.normalize {
        args.push("--norm".into());
    }
    args.extend([input, "-b", &job.bit_depth.to_string(), output].map(String::from));
    args.extend(["channels", &job.channels.to_string(), "rate", &job.sample_rate].map(String::from));
    if job.auto_trim {
        args.extend(["silence", "1", "0.1", "1%", "reverse", "silence", "1", "0.1", "1%", "reverse"].map(String::from));
    }
    if job.reverse {
        args.push("reverse".into());
    }
    args
}

pub fn ensure_directory(dir: &Path) -> bool {
    let _ = std::fs::create_dir_all(dir);
    dir.is_dir()
}

/// The running SoX process, so it can be stopped when the app quits.
pub type ChildSlot = Mutex<Option<Child>>;

fn run_sox(sox: &Path, args: &[String], slot: &ChildSlot) -> Result<(), String> {
    let mut cmd = Command::new(sox);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stderr = child.stderr.take().unwrap();
    *slot.lock().unwrap() = Some(child);
    // Reading to the end returns when SoX exits; the slot stays free so quitting can kill it meanwhile
    let mut text = String::new();
    let _ = stderr.read_to_string(&mut text);
    let Some(mut child) = slot.lock().unwrap().take() else { return Err("stopped".into()) };
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        return Ok(());
    }
    let last = text.trim().lines().last().map(str::to_string);
    Err(last.unwrap_or_else(|| format!("exit code {}", status.code().unwrap_or(-1))))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub index: usize,
    pub total: usize,
    pub file: String,
    pub output: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Failure {
    pub file: String,
    pub error: String,
}

/// Converts files one at a time and reports each one.
pub fn convert_all(sox: &Path, job: &Job, slot: &ChildSlot, mut on_progress: impl FnMut(Progress)) -> Vec<Failure> {
    let suffix = if job.reverse { "_rev" } else { "" };
    let ext = job.format.as_deref().unwrap_or("wav");
    let mut failures = vec![];
    for (i, input) in job.files.iter().enumerate() {
        let output = unique_output_name(Path::new(&job.output_dir), &clean_file_name(input), suffix, ext);
        let output = output.to_string_lossy().into_owned();
        let result = run_sox(sox, &build_args(input, &output, job), slot);
        if let Err(e) = &result {
            failures.push(Failure { file: input.clone(), error: e.clone() });
        }
        on_progress(Progress { index: i + 1, total: job.files.len(), file: input.clone(), output, ok: result.is_ok(), error: result.err() });
    }
    failures
}

pub enum Entry {
    File(String, PathBuf),
    Data(String, Vec<u8>),
}

/// Writes a deflated zip one file at a time, calling on_progress(done, total) after each.
/// A half-written zip is removed if anything fails.
pub fn write_zip(zip_path: &Path, entries: &[Entry], mut on_progress: impl FnMut(usize, usize)) -> Result<(), String> {
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(zip_path)?);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        for (i, entry) in entries.iter().enumerate() {
            let (name, data) = match entry {
                Entry::File(name, file) => (name, std::fs::read(file)?),
                Entry::Data(name, data) => (name, data.clone()),
            };
            zip.start_file(name.as_str(), options)?;
            zip.write_all(&data)?;
            on_progress(i + 1, entries.len());
        }
        zip.finish()?;
        Ok(())
    })();
    result.map_err(|e| {
        let _ = std::fs::remove_file(zip_path);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("padready-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn job(files: Vec<String>, output_dir: &Path) -> Job {
        Job {
            files, output_dir: output_dir.to_string_lossy().into(), sample_rate: "24000".into(), bit_depth: 16, channels: 1,
            format: None, normalize: true, auto_trim: true, reverse: false,
        }
    }

    // 16-bit PCM WAV: silence, a 440 Hz burst in the middle half, then silence
    fn write_test_wav(file: &Path) {
        let (rate, channels, frames) = (44100u32, 2u16, 44100u32);
        let mut data = vec![];
        for i in 0..frames {
            let burst = i > frames / 4 && i < frames * 3 / 4;
            let v = if burst { ((2.0 * std::f64::consts::PI * 440.0 * i as f64 / rate as f64).sin() * 8000.0) as i16 } else { 0 };
            for _ in 0..channels {
                data.extend(v.to_le_bytes());
            }
        }
        let mut h = vec![];
        h.extend(b"RIFF");
        h.extend((36 + data.len() as u32).to_le_bytes());
        h.extend(b"WAVEfmt ");
        h.extend(16u32.to_le_bytes());
        h.extend(1u16.to_le_bytes());
        h.extend(channels.to_le_bytes());
        h.extend(rate.to_le_bytes());
        h.extend((rate * channels as u32 * 2).to_le_bytes());
        h.extend((channels * 2).to_le_bytes());
        h.extend(16u16.to_le_bytes());
        h.extend(b"data");
        h.extend((data.len() as u32).to_le_bytes());
        h.extend(data);
        std::fs::write(file, h).unwrap();
    }

    // (channels, rate, bits, frames)
    fn read_wav_format(file: &Path) -> (u16, u32, u16, u32) {
        let b = std::fs::read(file).unwrap();
        let u16at = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
        let u32at = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let (mut off, mut fmt) = (12, (0, 0, 0));
        while off + 8 <= b.len() {
            let size = u32at(off + 4) as usize;
            match &b[off..off + 4] {
                b"fmt " => fmt = (u16at(off + 10), u32at(off + 12), u16at(off + 22)),
                b"data" => return (fmt.0, fmt.1, fmt.2, size as u32 / (fmt.0 as u32 * fmt.2 as u32 / 8)),
                _ => {}
            }
            off += 8 + size + (size & 1);
        }
        panic!("no data chunk");
    }

    fn test_sox() -> Option<PathBuf> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        find_sox(&[root.clone(), root.join("vendor").join("sox")])
    }

    #[test]
    fn clean_file_name_replaces_spaces_and_invalid_characters() {
        assert_eq!(clean_file_name(&Path::new("x").join("My Kick: 01?.wav").to_string_lossy()), "My_Kick__01_");
        assert_eq!(clean_file_name(".wav"), ".wav");
    }

    #[test]
    fn unique_output_name_adds_a_counter_instead_of_overwriting() {
        let dir = temp_dir();
        let first = unique_output_name(&dir, "kick", "_rev", "wav");
        assert_eq!(first.file_name().unwrap(), "kick_rev.wav");
        std::fs::write(&first, "").unwrap();
        assert_eq!(unique_output_name(&dir, "kick", "_rev", "wav").file_name().unwrap(), "kick_rev_001.wav");
        assert_eq!(unique_output_name(&dir, "kick", "", "aiff").file_name().unwrap(), "kick.aiff");
    }

    #[test]
    fn build_args_matches_the_original_sox_command_line() {
        let mut j = job(vec![], Path::new("."));
        j.reverse = true;
        assert_eq!(
            build_args("in.wav", "out.wav", &j),
            ["--norm", "in.wav", "-b", "16", "out.wav", "channels", "1", "rate", "24000", "silence", "1", "0.1", "1%", "reverse",
             "silence", "1", "0.1", "1%", "reverse", "reverse"]
        );
    }

    #[test]
    fn expand_paths_scans_folders_and_skips_non_audio_files() {
        let dir = temp_dir();
        for f in ["b.WAV", "a.mp3", "notes.txt", "kick 10.wav", "kick 2.wav"] {
            std::fs::write(dir.join(f), "").unwrap();
        }
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("c.wav"), "").unwrap();
        let names: Vec<String> = expand_paths(&[dir.clone(), dir.join("notes.txt")])
            .iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["a.mp3", "b.WAV", "kick 2.wav", "kick 10.wav"]);
    }

    #[test]
    fn write_zip_writes_a_readable_zip_and_reports_progress() {
        let dir = temp_dir();
        let big = vec![7u8; 100_000];
        std::fs::write(dir.join("kick.wav"), &big).unwrap();
        let zip_file = dir.join("kit.zip");
        let mut progress = vec![];
        write_zip(&zip_file, &[
            Entry::File("kick.wav".into(), dir.join("kick.wav")),
            Entry::Data("README.txt".into(), "Lofi-12 XT · 24000 Hz".as_bytes().to_vec()),
        ], |d, t| progress.push(format!("{d}/{t}"))).unwrap();
        assert_eq!(progress, ["1/2", "2/2"]);
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&zip_file).unwrap()).unwrap();
        let mut out = vec![];
        zip.by_name("kick.wav").unwrap().read_to_end(&mut out).unwrap();
        assert_eq!(out, big);
        let mut text = String::new();
        zip.by_name("README.txt").unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, "Lofi-12 XT · 24000 Hz");
    }

    #[test]
    fn write_zip_removes_the_half_written_zip_when_a_file_is_missing() {
        let dir = temp_dir();
        let zip_file = dir.join("kit.zip");
        assert!(write_zip(&zip_file, &[Entry::File("gone.wav".into(), dir.join("gone.wav"))], |_, _| {}).is_err());
        assert!(!zip_file.exists());
    }

    #[test]
    fn converts_a_wav_for_the_lofi_12_xt_with_sox() {
        let Some(sox) = test_sox() else { return eprintln!("SoX not found, skipped") };
        let dir = temp_dir();
        let input = dir.join("Test Sample.wav");
        let broken = dir.join("broken.wav");
        write_test_wav(&input);
        std::fs::write(&broken, "not audio").unwrap();
        let out = dir.join("out");
        assert!(ensure_directory(&out));
        let files = vec![input.to_string_lossy().into_owned(), broken.to_string_lossy().into_owned()];
        let mut progress = vec![];
        let failures = convert_all(&sox, &job(files, &out), &Mutex::new(None), |p| progress.push(p));
        assert_eq!(progress.len(), 2);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].file, broken.to_string_lossy());
        assert!(!failures[0].error.is_empty());
        let (channels, rate, bits, frames) = read_wav_format(&out.join("Test_Sample.wav"));
        assert_eq!((channels, rate, bits), (1, 24000, 16));
        // Auto-Trim removes the silence around the 0.5 s burst
        assert!(frames > 24000 * 4 / 10 && frames < 24000 * 6 / 10, "frames={frames}");
    }

    #[test]
    fn converts_to_aiff_for_the_op_1_with_sox() {
        let Some(sox) = test_sox() else { return eprintln!("SoX not found, skipped") };
        let dir = temp_dir();
        let input = dir.join("kick.wav");
        write_test_wav(&input);
        let mut j = job(vec![input.to_string_lossy().into_owned()], &dir);
        (j.format, j.sample_rate, j.normalize, j.auto_trim) = (Some("aiff".into()), "44100".into(), false, false);
        assert!(convert_all(&sox, &j, &Mutex::new(None), |_| {}).is_empty());
        let header = std::fs::read(dir.join("kick.aiff")).unwrap();
        assert_eq!((&header[0..4], &header[8..12]), (&b"FORM"[..], &b"AIFF"[..]));
    }
}
