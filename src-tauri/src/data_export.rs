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
const DICTATION_FETCH_LIMIT: usize = 100_000;

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

#[derive(Serialize)]
struct MetadataRow<'a> {
    file_name: String,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_text: Option<&'a str>,
    duration_seconds: f32,
    source: &'a str,
    created_at: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    segments: Option<&'a [TranscriptSegment]>,
}

fn collect_pairs(storage: &crate::storage::StorageManager) -> Result<Vec<DatasetPair>, String> {
    let mut pairs = Vec::new();

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
            pairs.push(DatasetPair {
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

    let records = storage
        .get_recent_transcriptions(DICTATION_FETCH_LIMIT)
        .map_err(|err| format!("Failed to read dictation history: {err}"))?;
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
        pairs.push(DatasetPair {
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

    Ok(pairs)
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
    include_timestamps: bool,
) -> Result<DatasetSummary, String> {
    let audio_dir = dest.join("audio");
    fs::create_dir_all(&audio_dir)
        .map_err(|err| format!("Unable to create the dataset folder: {err}"))?;

    let mut lines = String::new();
    let mut exported = 0usize;
    let mut skipped = 0usize;

    for pair in pairs {
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

        let row = MetadataRow {
            file_name: format!("audio/{file_name}"),
            text: &pair.text,
            raw_text: pair.raw_text.as_deref(),
            duration_seconds: pair.duration_seconds,
            source: pair.source,
            created_at: &pair.created_at,
            segments: include_timestamps
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
        path: dest.display().to_string(),
    })
}

#[tauri::command]
pub fn dataset_preview(state: tauri::State<AppState>) -> Result<DatasetPreview, String> {
    Ok(DatasetPreview {
        pairs: collect_pairs(&state.storage())?.len(),
    })
}

#[tauri::command]
pub async fn export_dataset(
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
    destination: String,
    include_timestamps: bool,
) -> Result<DatasetSummary, String> {
    let pairs = collect_pairs(&state.storage())?;
    if pairs.is_empty() {
        return Err("There are no audio and text pairs to export yet.".to_string());
    }

    let dest = unique_dataset_dir(Path::new(&destination))?;
    let summary = tauri::async_runtime::spawn_blocking(move || {
        write_dataset(&dest, &pairs, include_timestamps)
    })
    .await
    .map_err(|err| format!("Export task failed: {err}"))??;

    crate::toast::show(
        &app,
        "success",
        None,
        &format!("Exported {} audio and text pairs", summary.pairs),
    );
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
    Ok(targets.into_iter().collect())
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

    let quoted = targets
        .iter()
        .map(|target| format!("\"{}\"", target.display()))
        .collect::<Vec<_>>()
        .join(" ");
    // SQLite and WebView2 files stay locked until the process exits, so a
    // detached shell waits, deletes, then retries once for slow teardown.
    let script = format!(
        "ping -n 4 127.0.0.1 >nul & rmdir /S /Q {quoted} & ping -n 3 127.0.0.1 >nul & rmdir /S /Q {quoted}"
    );

    std::process::Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()))
        .args(["/D", "/C", &script])
        .current_dir(std::env::temp_dir())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|err| format!("Unable to start the cleanup task: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_all_data(app: AppHandle<AppRuntime>) -> Result<(), String> {
    let targets = wipe_targets(&app)?;

    let _ = crate::cli_install::remove_cli();

    #[cfg(windows)]
    spawn_windows_cleaner(&targets)?;

    #[cfg(not(windows))]
    for target in &targets {
        let _ = fs::remove_dir_all(target);
    }

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

        let dest = root.join("dataset");
        let summary = write_dataset(&dest, &pairs, true).expect("write dataset");
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

        let without_timestamps =
            write_dataset(&root.join("dataset-plain"), &pairs, false).expect("plain dataset");
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
