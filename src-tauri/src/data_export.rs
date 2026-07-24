//! Dataset export (audio + text pairs) and full data deletion.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::library::{LibraryFilter, LibraryItemStatus, TranscriptSegment};
use crate::{AppRuntime, AppState};

const DATASET_DIR_NAME: &str = "glimpse-dataset";
const LIBRARY_PAGE_SIZE: usize = 200;
const DICTATION_PAGE_SIZE: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetPreview {
    pub pairs: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSummary {
    pub pairs: usize,
    pub skipped: usize,
    pub skipped_short: usize,
    pub path: String,
}

struct DatasetPair {
    audio: PathBuf,
    text: String,
    raw_text: Option<String>,
    duration_seconds: f32,
    created_at: String,
    source: &'static str,
    id: String,
    segments: Option<Vec<TranscriptSegment>>,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetExportOptions {
    pub include_timestamps: bool,
    pub verbatim_text: bool,
    pub skip_short_clips: bool,
}

const SHORT_CLIP_SECONDS: f32 = 1.0;

#[derive(Serialize)]
struct MetadataRow<'a> {
    file_name: String,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cleaned_text: Option<&'a str>,
    duration_seconds: f32,
    source: &'a str,
    created_at: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    segments: Option<&'a [TranscriptSegment]>,
}

fn visit_pairs(
    storage: &crate::storage::StorageManager,
    mut visit: impl FnMut(DatasetPair),
) -> Result<(), String> {
    let mut offset = 0;
    loop {
        let (items, has_more) = storage
            .get_library_items_page(LibraryFilter::default(), LIBRARY_PAGE_SIZE, offset)
            .map_err(|err| format!("Failed to read library: {err}"))?;
        offset += items.len();
        for item in items {
            if !matches!(item.status, LibraryItemStatus::Complete) {
                continue;
            }
            let Some(text) = item
                .transcript
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            else {
                continue;
            };
            let audio = PathBuf::from(&item.audio_path);
            if !audio.is_file() {
                continue;
            }
            visit(DatasetPair {
                audio,
                text: text.to_string(),
                raw_text: None,
                duration_seconds: item.duration_seconds,
                created_at: item.created_at.clone(),
                source: "library",
                id: item.id.clone(),
                segments: item.segments.clone().filter(|s| !s.is_empty()),
            });
        }
        if !has_more {
            break;
        }
    }

    let mut offset = 0;
    loop {
        let records = storage
            .get_recent_transcriptions_page(DICTATION_PAGE_SIZE, offset)
            .map_err(|err| format!("Failed to read dictation history: {err}"))?;
        let page_len = records.len();
        offset += page_len;
        for record in records {
            if !record.audio_available {
                continue;
            }
            let text = record.text.trim();
            if text.is_empty() {
                continue;
            }
            let audio = PathBuf::from(&record.audio_path);
            if !audio.is_file() {
                continue;
            }
            let raw_text = record
                .raw_text
                .as_deref()
                .map(str::trim)
                .filter(|raw| !raw.is_empty() && *raw != text)
                .map(str::to_string);
            visit(DatasetPair {
                audio,
                text: text.to_string(),
                raw_text,
                duration_seconds: record.audio_duration_seconds,
                created_at: record.timestamp.to_rfc3339(),
                source: "dictation",
                id: record.id.clone(),
                segments: None,
            });
        }
        if page_len < DICTATION_PAGE_SIZE {
            break;
        }
    }

    Ok(())
}

fn collect_pairs(storage: &crate::storage::StorageManager) -> Result<Vec<DatasetPair>, String> {
    let mut pairs = Vec::new();
    visit_pairs(storage, |pair| pairs.push(pair))?;
    Ok(pairs)
}

fn count_pairs(storage: &crate::storage::StorageManager) -> Result<usize, String> {
    let mut count = 0;
    visit_pairs(storage, |_| count += 1)?;
    Ok(count)
}

fn unique_dataset_dir(parent: &Path) -> Result<PathBuf, String> {
    let base = parent.join(DATASET_DIR_NAME);
    if !base.exists() {
        return Ok(base);
    }
    for suffix in 2..100 {
        let candidate = parent.join(format!("{DATASET_DIR_NAME}-{suffix}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Too many existing dataset folders at that location".to_string())
}

fn write_dataset(
    dest: &Path,
    pairs: &[DatasetPair],
    options: DatasetExportOptions,
) -> Result<DatasetSummary, String> {
    let audio_dir = dest.join("audio");
    fs::create_dir_all(&audio_dir)
        .map_err(|err| format!("Unable to create the dataset folder: {err}"))?;

    let mut lines = String::new();
    let mut exported = 0usize;
    let mut skipped = 0usize;
    let mut skipped_short = 0usize;

    for pair in pairs {
        if options.skip_short_clips && pair.duration_seconds < SHORT_CLIP_SECONDS {
            skipped_short += 1;
            continue;
        }
        let extension = pair
            .audio
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_lowercase)
            .unwrap_or_else(|| "wav".to_string());
        let file_name = format!("{}.{}", pair.id, extension);
        if fs::copy(&pair.audio, audio_dir.join(&file_name)).is_err() {
            skipped += 1;
            continue;
        }

        // The verbatim transcript becomes the label when requested; the other
        // variant rides along under its own key.
        let (text, raw_text, cleaned_text) = match (&pair.raw_text, options.verbatim_text) {
            (Some(raw), true) => (raw.as_str(), None, Some(pair.text.as_str())),
            (raw, false) => (pair.text.as_str(), raw.as_deref(), None),
            (None, true) => (pair.text.as_str(), None, None),
        };

        let row = MetadataRow {
            file_name: format!("audio/{file_name}"),
            text,
            raw_text,
            cleaned_text,
            duration_seconds: pair.duration_seconds,
            source: pair.source,
            created_at: &pair.created_at,
            segments: options
                .include_timestamps
                .then_some(pair.segments.as_deref())
                .flatten(),
        };
        let line = serde_json::to_string(&row)
            .map_err(|err| format!("Unable to encode metadata: {err}"))?;
        lines.push_str(&line);
        lines.push('\n');
        exported += 1;
    }

    fs::write(dest.join("metadata.jsonl"), lines)
        .map_err(|err| format!("Unable to write metadata.jsonl: {err}"))?;

    Ok(DatasetSummary {
        pairs: exported,
        skipped,
        skipped_short,
        path: dest.display().to_string(),
    })
}

#[tauri::command]
pub async fn dataset_preview(state: tauri::State<'_, AppState>) -> Result<DatasetPreview, String> {
    let storage = state.storage();
    let pairs = tauri::async_runtime::spawn_blocking(move || count_pairs(&storage))
        .await
        .map_err(|err| format!("Preview task failed: {err}"))??;
    Ok(DatasetPreview { pairs })
}

#[tauri::command]
pub async fn export_dataset(
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
    destination: String,
    options: DatasetExportOptions,
) -> Result<DatasetSummary, String> {
    let storage = state.storage();
    let dest = unique_dataset_dir(Path::new(&destination))?;
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let pairs = collect_pairs(&storage)?;
        if pairs.is_empty() {
            return Err("There are no audio and text pairs to export yet.".to_string());
        }
        write_dataset(&dest, &pairs, options)
    })
    .await
    .map_err(|err| format!("Export task failed: {err}"))??;

    let mut message = format!("Exported {} audio and text pairs", summary.pairs);
    if summary.skipped_short > 0 {
        message.push_str(&format!(", skipped {} short clips", summary.skipped_short));
    }
    if summary.skipped > 0 {
        message.push_str(&format!(", {} files could not be copied", summary.skipped));
    }
    let toast_type = if summary.skipped > 0 {
        "info"
    } else {
        "success"
    };
    crate::toast::show(&app, toast_type, None, &message);
    Ok(summary)
}

/// Every directory Glimpse owns on this machine. Each entry is verified to be
/// an absolute per-app directory before deletion.
fn wipe_targets(app: &AppHandle<AppRuntime>) -> Result<Vec<PathBuf>, String> {
    let identifier = app.config().identifier.clone();
    let resolver = app.path();
    let candidates = [
        resolver.app_data_dir(),
        resolver.app_config_dir(),
        resolver.app_local_data_dir(),
        resolver.app_cache_dir(),
        resolver.app_log_dir(),
    ];

    let mut targets = BTreeSet::new();
    for candidate in candidates.into_iter().flatten() {
        if is_safe_wipe_target(&candidate, &identifier) && candidate.exists() {
            targets.insert(candidate);
        }
    }
    if targets.is_empty() {
        return Err("Could not resolve the app data folders".to_string());
    }

    // MSIX file virtualization can redirect AppData writes into the package's
    // LocalCache, so a Store install must wipe that container too.
    #[cfg(windows)]
    if let Some(local_cache) = msix_local_cache_dir() {
        targets.insert(local_cache);
    }

    Ok(targets.into_iter().collect())
}

#[cfg(windows)]
fn msix_local_cache_dir() -> Option<PathBuf> {
    if !crate::platform::windows::store::is_msix_packaged() {
        return None;
    }
    let family = crate::platform::windows::store::package_family_name()?;
    let local_app_data = std::env::var_os("LOCALAPPDATA")?;
    let path = PathBuf::from(local_app_data)
        .join("Packages")
        .join(family)
        .join("LocalCache");
    path.is_dir().then_some(path)
}

fn is_safe_wipe_target(path: &Path, identifier: &str) -> bool {
    path.is_absolute()
        && path.components().count() >= 4
        && path
            .file_name()
            .is_some_and(|name| name.to_string_lossy() == identifier)
}

#[cfg(windows)]
fn spawn_windows_cleaner(targets: &[PathBuf]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let delete_commands = targets
        .iter()
        .map(|target| format!("rmdir /S /Q \"{}\"", target.display()))
        .collect::<Vec<_>>()
        .join(" & ");
    // SQLite and WebView2 files stay locked until the process exits, so a
    // detached shell waits, deletes, then retries once for slow teardown.
    let script = format!(
        "ping -n 4 127.0.0.1 >nul & {delete_commands} & ping -n 3 127.0.0.1 >nul & {delete_commands}"
    );

    // raw_arg: Command::args applies MSVC-style quoting that cmd.exe does not
    // understand, which would mangle the quoted paths.
    std::process::Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()))
        .raw_arg("/D")
        .raw_arg("/C")
        .raw_arg(&script)
        .current_dir(std::env::temp_dir())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|err| format!("Unable to start the cleanup task: {err}"))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_all_data(app: AppHandle<AppRuntime>) -> Result<(), String> {
    let targets = wipe_targets(&app)?;
    crate::sync_launch_at_login(&app, false)?;

    tauri::async_runtime::spawn_blocking(move || {
        let _ = crate::cli_install::remove_cli();

        #[cfg(windows)]
        spawn_windows_cleaner(&targets)?;

        #[cfg(not(windows))]
        for target in &targets {
            if let Err(err) = fs::remove_dir_all(target)
                && err.kind() != std::io::ErrorKind::NotFound
            {
                return Err(format!(
                    "Unable to delete {}: {err}",
                    target.to_string_lossy()
                ));
            }
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|err| format!("Delete task failed: {err}"))??;

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        app.exit(0);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wipe_targets_require_per_app_directories() {
        let id = "cc.tryglimpse.app";
        assert!(is_safe_wipe_target(
            Path::new("/Users/me/Library/Application Support/cc.tryglimpse.app"),
            id
        ));
        assert!(!is_safe_wipe_target(
            Path::new("/Users/me/Library/Application Support"),
            id
        ));
        assert!(!is_safe_wipe_target(Path::new("/cc.tryglimpse.app"), id));
        assert!(!is_safe_wipe_target(
            Path::new("relative/cc.tryglimpse.app"),
            id
        ));
    }

    #[test]
    fn export_writes_pairs_from_library_and_dictations() {
        use crate::library::LibraryItem;
        use crate::storage::{StorageManager, TranscriptionMetadata, TranscriptionStatus};

        let root = std::env::temp_dir().join(format!("glimpse-export-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create test root");

        let storage =
            StorageManager::new(root.join("transcriptions.db")).expect("open test storage");

        let dictation_audio = root.join("dictation.wav");
        fs::write(&dictation_audio, b"fake-wav").expect("write dictation audio");
        storage
            .save_transcription(
                "hello world".to_string(),
                dictation_audio.display().to_string(),
                TranscriptionStatus::Success,
                None,
                TranscriptionMetadata {
                    speech_model: "test-model".to_string(),
                    llm_model: None,
                    word_count: 2,
                    audio_duration_seconds: 1.5,
                    synced: false,
                    mode_id: None,
                    mode_name: None,
                },
                None,
                None,
            )
            .expect("save dictation");

        let library_audio = root.join("library.wav");
        fs::write(&library_audio, b"fake-wav-2").expect("write library audio");
        storage
            .insert_library_item(LibraryItem {
                id: "item-1".to_string(),
                name: "Test item".to_string(),
                audio_path: library_audio.display().to_string(),
                source_path: String::new(),
                store_original: false,
                status: LibraryItemStatus::Complete,
                transcript: Some("library text".to_string()),
                segments: Some(vec![TranscriptSegment {
                    start_ms: 0,
                    end_ms: 900,
                    text: "library text".to_string(),
                    speaker_id: None,
                }]),
                words: None,
                duration_seconds: 0.9,
                file_size_bytes: 10,
                original_format: "wav".to_string(),
                created_at: "2026-07-23T00:00:00Z".to_string(),
                transcribed_at: None,
                tags: Vec::new(),
                llm_cleanup_enabled: false,
                speech_model: "test-model".to_string(),
                show_timestamps: false,
                detect_speakers: false,
                kind: "import".to_string(),
                speakers: None,
            })
            .expect("insert library item");

        let pairs = collect_pairs(&storage).expect("collect pairs");
        assert_eq!(pairs.len(), 2);
        assert_eq!(count_pairs(&storage).expect("count pairs"), 2);

        let with_timestamps = DatasetExportOptions {
            include_timestamps: true,
            verbatim_text: false,
            skip_short_clips: false,
        };
        let dest = root.join("dataset");
        let summary = write_dataset(&dest, &pairs, with_timestamps).expect("write dataset");
        assert_eq!(summary.pairs, 2);
        assert_eq!(summary.skipped, 0);
        assert!(dest.join("audio").join("item-1.wav").is_file());

        let metadata = fs::read_to_string(dest.join("metadata.jsonl")).expect("read metadata");
        assert_eq!(metadata.lines().count(), 2);
        for line in metadata.lines() {
            let row: serde_json::Value = serde_json::from_str(line).expect("valid jsonl row");
            let file_name = row["file_name"].as_str().expect("file_name");
            assert!(file_name.starts_with("audio/"));
            assert!(dest.join(file_name).is_file());
            assert!(!row["text"].as_str().expect("text").is_empty());
        }
        assert!(metadata.contains("\"segments\""));

        // Skipping short clips drops the 0.9s library item.
        let skip_short = DatasetExportOptions {
            include_timestamps: false,
            verbatim_text: false,
            skip_short_clips: true,
        };
        let filtered =
            write_dataset(&root.join("dataset-filtered"), &pairs, skip_short).expect("filtered");
        assert_eq!(filtered.pairs, 1);

        let without_timestamps = write_dataset(
            &root.join("dataset-plain"),
            &pairs,
            DatasetExportOptions {
                include_timestamps: false,
                verbatim_text: false,
                skip_short_clips: false,
            },
        )
        .expect("plain dataset");
        assert_eq!(without_timestamps.pairs, 2);
        let plain = fs::read_to_string(root.join("dataset-plain").join("metadata.jsonl"))
            .expect("read plain metadata");
        assert!(!plain.contains("\"segments\""));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dataset_dir_picks_unused_name() {
        let parent =
            std::env::temp_dir().join(format!("glimpse-dataset-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&parent);
        fs::create_dir_all(&parent).expect("create test parent");

        let first = unique_dataset_dir(&parent).expect("first name");
        assert_eq!(first, parent.join(DATASET_DIR_NAME));
        fs::create_dir_all(&first).expect("occupy first name");

        let second = unique_dataset_dir(&parent).expect("second name");
        assert_eq!(second, parent.join(format!("{DATASET_DIR_NAME}-2")));

        let _ = fs::remove_dir_all(&parent);
    }
}
