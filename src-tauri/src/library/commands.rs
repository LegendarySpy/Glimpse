use std::fs;
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::OnceLock;

use anyhow::{Context, Result};
#[cfg(target_os = "macos")]
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::{AppRuntime, AppState, LibraryJob, LibraryJobKind};

use super::processing::{
    build_export_content, create_item_from_path, library_root, probe_media_duration_ms,
    stored_original_path,
};
use super::queue::{release_library_slot, schedule_library_job};
#[cfg(target_os = "macos")]
use super::types::EVENT_LIBRARY_OPEN_IMPORT;
use super::types::{
    EVENT_LIBRARY_ERROR, ExportFormat, LibraryErrorPayload, LibraryFilter, LibraryImportOptions,
    LibraryItem, LibraryItemPatch, LibraryItemStatus, LibraryItemsPage,
};

#[cfg(target_os = "macos")]
#[derive(Default)]
struct PendingLibraryImport {
    renderer_ready: bool,
    paths: Vec<String>,
}

#[cfg(target_os = "macos")]
fn pending_library_import() -> &'static Mutex<PendingLibraryImport> {
    static PENDING: OnceLock<Mutex<PendingLibraryImport>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(PendingLibraryImport::default()))
}

#[cfg(target_os = "macos")]
fn flush_pending_library_import(app: &AppHandle<AppRuntime>) {
    let paths = {
        let mut pending = pending_library_import().lock();
        if !pending.renderer_ready || pending.paths.is_empty() {
            return;
        }
        std::mem::take(&mut pending.paths)
    };

    let _ = app.emit(EVENT_LIBRARY_OPEN_IMPORT, paths);
}

#[cfg(target_os = "macos")]
pub(crate) fn mark_library_import_renderer_ready(app: &AppHandle<AppRuntime>) {
    pending_library_import().lock().renderer_ready = true;
    flush_pending_library_import(app);
}

enum LibraryDeleteScope {
    SkipFilesystemDeletion,
    DeleteFile(PathBuf),
    DeleteDirectory(PathBuf),
}

fn require_library_license(state: &AppState) -> Result<(), String> {
    crate::license::require_license_gate(&state.settings_store, "Library")
}

#[tauri::command]
pub fn create_library_item(
    path: String,
    options: LibraryImportOptions,
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
) -> Result<LibraryItem, String> {
    require_library_license(&state)?;

    let source_path = PathBuf::from(path);
    let storage = state.storage();
    let item = create_item_from_path(&app, storage, &source_path, &options)
        .map_err(|err| err.to_string())?;
    schedule_library_job(
        &app,
        &state,
        LibraryJob {
            id: item.id.clone(),
            kind: LibraryJobKind::Import {
                source_path,
                store_original: options.store_original,
            },
        },
    );
    Ok(item)
}

#[tauri::command]
pub fn get_library_items_page(
    filter: Option<LibraryFilter>,
    limit: u32,
    offset: u32,
    state: tauri::State<'_, AppState>,
) -> Result<LibraryItemsPage, String> {
    let filter = filter.unwrap_or_default();
    let limit = limit.clamp(1, 200) as usize;
    let offset = offset as usize;
    state
        .storage()
        .get_library_items_page(filter, limit, offset)
        .map(|(items, has_more)| LibraryItemsPage { items, has_more })
        .map_err(|err| format!("Failed to load library items page: {err}"))
}

#[tauri::command]
pub fn update_library_item(
    id: String,
    patch: LibraryItemPatch,
    state: tauri::State<'_, AppState>,
) -> Result<LibraryItem, String> {
    require_library_license(&state)?;

    let storage = state.storage();
    let updated = storage
        .update_library_item(&id, patch.clone())
        .map_err(|err| format!("Failed to update library item: {err}"))?
        .ok_or_else(|| "Library item not found".to_string())?;

    Ok(updated)
}

#[tauri::command]
pub fn delete_library_item(
    id: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.remove_library_job(&id);
    state.cancel_library_transcription(&id);
    release_library_slot(&app, &state, &id);

    let storage = state.storage();
    let item = storage
        .get_library_item(&id)
        .map_err(|err| format!("Failed to load library item: {err}"))?;
    let Some(item) = item else {
        return Ok(());
    };

    match determine_delete_scope(&app, &item.audio_path) {
        LibraryDeleteScope::DeleteFile(path) => {
            if path.exists() {
                fs::remove_file(&path)
                    .map_err(|err| format!("Failed to delete library file: {err}"))?;
            }
        }
        LibraryDeleteScope::DeleteDirectory(path) => {
            crate::platform::remove_dir_all_compat(&path)
                .map_err(|err| format!("Failed to delete library files: {err}"))?;
        }
        LibraryDeleteScope::SkipFilesystemDeletion => {}
    }

    storage
        .delete_library_item(&id)
        .map_err(|err| format!("Failed to delete library item: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn cancel_library_transcription(
    id: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if state.remove_library_job(&id) {
        let _ = state.storage().update_library_item(
            &id,
            LibraryItemPatch {
                status: Some(LibraryItemStatus::Cancelled),
                ..Default::default()
            },
        );
        let _ = app.emit(
            EVENT_LIBRARY_ERROR,
            LibraryErrorPayload {
                id,
                message: "Transcription cancelled".to_string(),
                cancelled: true,
            },
        );
        return Ok(());
    }
    state.cancel_library_transcription(&id);
    let _ = state.storage().update_library_item(
        &id,
        LibraryItemPatch {
            status: Some(LibraryItemStatus::Cancelling),
            ..Default::default()
        },
    );
    Ok(())
}

#[tauri::command]
pub fn retry_library_transcription(
    id: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    require_library_license(&state)?;

    let storage = state.storage();
    let item = storage
        .get_library_item(&id)
        .map_err(|err| format!("Failed to load library item: {err}"))?
        .ok_or_else(|| "Library item not found".to_string())?;

    let job = match build_retry_job(&item) {
        Ok(job) => job,
        Err(message) => {
            set_library_item_error(&storage, &id, &message);
            let _ = app.emit(
                EVENT_LIBRARY_ERROR,
                LibraryErrorPayload {
                    id,
                    message: message.clone(),
                    cancelled: false,
                },
            );
            return Err(message);
        }
    };

    let _ = storage.update_library_item(
        &id,
        LibraryItemPatch {
            status: Some(LibraryItemStatus::Pending),
            ..Default::default()
        },
    );
    schedule_library_job(&app, &state, LibraryJob { id, kind: job });
    Ok(())
}

#[tauri::command]
pub fn export_library_item_to_path(
    id: String,
    format: ExportFormat,
    output_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    require_library_license(&state)?;

    let item = state
        .storage()
        .get_library_item(&id)
        .map_err(|err| format!("Failed to load library item: {err}"))?
        .ok_or_else(|| "Library item not found".to_string())?;

    let content = build_export_content(&item, format.clone())
        .map_err(|err| format!("Failed to build export: {err}"))?;

    let output_path = PathBuf::from(&output_path);

    // Validate output path is absolute and doesn't contain path traversal
    if !output_path.is_absolute() {
        return Err("Export path must be absolute".to_string());
    }
    if output_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Export path contains invalid components".to_string());
    }

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .context("Failed to create export directory")
            .map_err(|err| err.to_string())?;
    }

    fs::write(&output_path, content.as_bytes())
        .with_context(|| "Failed to write export file".to_string())
        .map_err(|err| err.to_string())?;

    Ok(())
}

#[derive(serde::Serialize)]
pub struct LibraryImportFileProbe {
    pub path: String,
    pub duration_ms: Option<u64>,
    pub size_bytes: Option<u64>,
}

#[tauri::command]
pub async fn probe_library_import_files(paths: Vec<String>) -> Vec<LibraryImportFileProbe> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let file_path = Path::new(&path);
                LibraryImportFileProbe {
                    duration_ms: probe_media_duration_ms(file_path),
                    size_bytes: fs::metadata(file_path).ok().map(|meta| meta.len()),
                    path,
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub fn get_library_tags(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    state
        .storage()
        .get_library_tags()
        .map_err(|err| format!("Failed to load tags: {err}"))
}

pub(crate) fn recover_interrupted_library_items(app: &AppHandle<AppRuntime>) {
    let state = app.state::<AppState>();
    if !crate::license::license_gate_active(&state.settings_store) {
        return;
    }

    let storage = state.storage();
    let items = match storage.get_recoverable_library_items() {
        Ok(items) => items,
        Err(err) => {
            tracing::error!("Failed to load recoverable library items: {err}");
            return;
        }
    };

    for item in items {
        match item.status {
            LibraryItemStatus::Cancelling => {
                let _ = storage.update_library_item(
                    &item.id,
                    LibraryItemPatch {
                        status: Some(LibraryItemStatus::Cancelled),
                        ..Default::default()
                    },
                );
                let _ = app.emit(
                    EVENT_LIBRARY_ERROR,
                    LibraryErrorPayload {
                        id: item.id.clone(),
                        message: "Transcription cancelled".to_string(),
                        cancelled: true,
                    },
                );
            }
            LibraryItemStatus::Pending
            | LibraryItemStatus::Importing { .. }
            | LibraryItemStatus::Transcribing { .. } => match build_recovery_job(&item) {
                Ok(kind) => {
                    let _ = storage.update_library_item(
                        &item.id,
                        LibraryItemPatch {
                            status: Some(LibraryItemStatus::Pending),
                            ..Default::default()
                        },
                    );
                    schedule_library_job(
                        app,
                        &state,
                        LibraryJob {
                            id: item.id.clone(),
                            kind,
                        },
                    );
                }
                Err(message) => {
                    set_library_item_error(&storage, &item.id, &message);
                }
            },
            _ => {}
        }
    }
}

#[cfg(target_os = "macos")]
pub fn handle_opened_paths(app: &AppHandle<AppRuntime>, urls: Vec<PathBuf>) -> Result<()> {
    let state = app.state::<AppState>();
    if require_library_license(&state).is_err() {
        if let Err(err) = crate::tray::toggle_settings_window(app) {
            tracing::error!("Failed to open settings window: {err}");
        }
        return Ok(());
    }

    let paths: Vec<String> = urls
        .into_iter()
        .filter(|path| path.is_file())
        .map(|path| path.display().to_string())
        .collect();
    if paths.is_empty() {
        return Ok(());
    }
    pending_library_import().lock().paths = paths;
    if let Err(err) = crate::tray::toggle_settings_window(app) {
        tracing::error!("Failed to open settings window: {err}");
    }
    flush_pending_library_import(app);
    Ok(())
}

fn determine_delete_scope(app: &AppHandle<AppRuntime>, audio_path: &str) -> LibraryDeleteScope {
    let path = PathBuf::from(audio_path);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return LibraryDeleteScope::SkipFilesystemDeletion;
    }

    let root = match library_root(app).and_then(|root| {
        root.canonicalize()
            .map_err(anyhow::Error::from)
            .context("Failed to resolve library storage location.")
    }) {
        Ok(root) => root,
        Err(err) => {
            tracing::error!("Skipping library file deletion: {err}");
            return LibraryDeleteScope::SkipFilesystemDeletion;
        }
    };

    determine_delete_scope_from_paths(&root, &path)
}

fn determine_delete_scope_from_paths(root: &Path, path: &Path) -> LibraryDeleteScope {
    let safe_path = if path.exists() {
        match path.canonicalize() {
            Ok(path) => path,
            Err(err) => {
                tracing::error!(
                    "Skipping library file deletion, failed to canonicalize file: {err}"
                );
                return LibraryDeleteScope::SkipFilesystemDeletion;
            }
        }
    } else if let Some(parent) = path.parent() {
        if parent.exists() {
            match parent.canonicalize() {
                Ok(parent) => parent.join(path.file_name().unwrap_or_default()),
                Err(err) => {
                    tracing::error!(
                        "Skipping library file deletion, failed to canonicalize parent folder: {err}"
                    );
                    return LibraryDeleteScope::SkipFilesystemDeletion;
                }
            }
        } else {
            path.to_path_buf()
        }
    } else {
        path.to_path_buf()
    };

    if !safe_path.starts_with(root) {
        return LibraryDeleteScope::SkipFilesystemDeletion;
    }

    match safe_path.parent() {
        Some(parent) if parent == root => LibraryDeleteScope::DeleteFile(safe_path),
        Some(parent) if parent.exists() => {
            LibraryDeleteScope::DeleteDirectory(parent.to_path_buf())
        }
        _ if safe_path.exists() => LibraryDeleteScope::DeleteFile(safe_path),
        _ => LibraryDeleteScope::SkipFilesystemDeletion,
    }
}

fn build_retry_job(item: &LibraryItem) -> Result<LibraryJobKind, String> {
    if PathBuf::from(&item.audio_path).exists() {
        return Ok(LibraryJobKind::TranscribeExisting);
    }

    find_recoverable_source_path(item)
        .map(|source_path| LibraryJobKind::Import {
            source_path,
            store_original: item.store_original,
        })
        .ok_or_else(missing_original_file_message)
}

fn build_recovery_job(item: &LibraryItem) -> Result<LibraryJobKind, String> {
    match item.status {
        LibraryItemStatus::Importing { .. } => {
            if let Some(source_path) = find_recoverable_source_path(item) {
                return Ok(LibraryJobKind::Import {
                    source_path,
                    store_original: item.store_original,
                });
            }
            if PathBuf::from(&item.audio_path).exists() {
                return Ok(LibraryJobKind::TranscribeExisting);
            }
            Err(missing_original_file_message())
        }
        LibraryItemStatus::Pending | LibraryItemStatus::Transcribing { .. } => {
            build_retry_job(item)
        }
        LibraryItemStatus::Cancelling => Err("Transcription cancelled".to_string()),
        _ => Err("Library item is not recoverable".to_string()),
    }
}

fn find_recoverable_source_path(item: &LibraryItem) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = stored_original_path(item) {
        candidates.push(path);
    }

    let source = item.source_path.trim();
    if !source.is_empty() {
        candidates.push(PathBuf::from(source));
    }

    candidates.into_iter().find(|path| path.exists())
}

fn missing_original_file_message() -> String {
    "Original file not found. Re-import the file to try again.".to_string()
}

fn set_library_item_error(
    storage: &std::sync::Arc<crate::storage::StorageManager>,
    id: &str,
    message: &str,
) {
    let _ = storage.update_library_item(
        id,
        LibraryItemPatch {
            status: Some(LibraryItemStatus::Error {
                message: message.to_string(),
            }),
            ..Default::default()
        },
    );
}
