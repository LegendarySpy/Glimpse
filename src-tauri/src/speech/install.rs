use std::path::{Path, PathBuf};

use crate::AppRuntime;
use anyhow::{Context, Result, anyhow};
use glimpse_speech::models as speech_models;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub use super::catalog::{
    LocalModelEngine, MODEL_CAPABILITY_DICTIONARY, MODEL_CAPABILITY_TIMESTAMPS, ModelInfo,
    api_model_infos, definition, is_streaming_model, model_label, model_supports_capability,
};

#[derive(Debug, Clone)]
pub struct ReadyModel {
    pub key: String,
    pub path: PathBuf,
    pub engine: LocalModelEngine,
}

#[derive(Debug, Serialize, Clone)]
pub struct ModelStatus {
    pub key: String,
    pub installed: bool,
    pub ane_installed: bool,
    pub bytes_on_disk: u64,
    pub missing_files: Vec<String>,
    pub directory: String,
}

#[derive(Serialize, Clone)]
struct DownloadProgressPayload {
    model: String,
    file: String,
    downloaded: u64,
    total: u64,
    percent: f64,
    verifying: bool,
}

#[derive(Serialize, Clone)]
struct DownloadCompletePayload {
    model: String,
}

#[derive(Serialize, Clone)]
struct DownloadErrorPayload {
    model: String,
    error: String,
}

#[derive(Serialize, Clone)]
struct DownloadCancelledPayload {
    model: String,
}

#[derive(Serialize, Clone)]
struct AneCompilePayload {
    model: String,
    label: String,
    status: &'static str,
}

fn spawn_ane_compile(app: AppHandle<AppRuntime>, model: String) {
    std::thread::spawn(move || {
        let label = super::catalog::model_label(&model);
        let emit = |status: &'static str| {
            let _ = app.emit(
                "ane:compile",
                AneCompilePayload {
                    model: model.clone(),
                    label: label.clone(),
                    status,
                },
            );
        };

        let result = ensure_model_ready(&app, &model).and_then(|ready| {
            emit("start");
            let transcriber = app.state::<crate::AppState>().local_transcriber();
            let _ = glimpse_speech::take_coreml_log();
            if transcriber.loaded_model_id().as_deref() == Some(model.as_str()) {
                transcriber.preload_and_warm(&ready)
            } else {
                use glimpse_speech::TranscriptionEngine;
                let mut engine = glimpse_speech::engines::whisper::WhisperEngine::new();
                engine
                    .load_model(&ready.path)
                    .map_err(|err| anyhow!("{err}"))
            }
        });

        // whisper.cpp falls back to GPU when the Core ML load fails, so a
        // successful model load alone doesn't prove the encoder engaged.
        let coreml_failed = || {
            glimpse_speech::take_coreml_log()
                .iter()
                .any(|line| line.contains("failed to load Core ML model"))
        };

        let compiled = result.is_ok();

        match result {
            Ok(()) if coreml_failed() => {
                tracing::error!(
                    "[speech] Core ML encoder for {model} failed to load; whisper fell back to the GPU"
                );
                crate::toast::show(
                    &app,
                    "error",
                    None,
                    &format!(
                        "{label} couldn't use the Neural Engine and will run on the GPU instead."
                    ),
                );
                crate::analytics::track_model_download_failed(
                    &app,
                    &model,
                    "ane_compile",
                    "model_error",
                );
                emit("error");
            }
            Ok(()) => emit("done"),
            Err(err) => {
                tracing::error!("[speech] ANE compile warm-up failed: {err}");
                crate::analytics::track_model_download_failed(
                    &app,
                    &model,
                    "ane_compile",
                    crate::analytics::classify_failure_reason(&err.to_string()),
                );
                crate::toast::show(
                    &app,
                    "error",
                    None,
                    &format!("Couldn't optimize {label} for the Neural Engine."),
                );
                emit("error");
            }
        }

        if compiled {
            super::warm_model(&app, model.clone());
        }
    });
}

const MODELS_ROOT: &str = "models";

pub fn local_resolver() -> glimpse_speech::service::ModelResolver {
    std::sync::Arc::new(|model| super::catalog::install_spec(model, false))
}

fn spec_for(model: &str, ane: bool) -> Result<speech_models::InstallSpec> {
    super::catalog::install_spec(model, ane).ok_or_else(|| anyhow!("Unknown model: {model}"))
}

/// Headless installed-check against a models directory, without an `AppHandle`.
pub(crate) fn check_model_installed_at(models_dir: &std::path::Path, model: &str) -> bool {
    let manager = speech_models::ModelInstallManager::new(models_dir.to_path_buf());
    spec_for(model, false)
        .ok()
        .and_then(|spec| manager.status(&spec).ok())
        .map(|status| status.installed)
        .unwrap_or(false)
}

pub fn installed_api_model_infos(models_dir: &Path) -> Vec<glimpse_speech::api::ApiModelInfo> {
    api_model_infos()
        .into_iter()
        .filter(|info| check_model_installed_at(models_dir, &info.id))
        .collect()
}

pub fn model_cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let mut dir = app
        .path()
        .app_data_dir()
        .context("Unable to resolve app data directory")?;
    dir.push(MODELS_ROOT);
    Ok(dir)
}

fn model_manager<R: Runtime>(app: &AppHandle<R>) -> Result<speech_models::ModelInstallManager> {
    let dir = model_cache_dir(app)?;
    Ok(speech_models::ModelInstallManager::new(dir))
}

fn ensure_models_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = model_cache_dir(app)?;
    std::fs::create_dir_all(&dir).context("Failed to prepare models directory")?;
    Ok(dir)
}

fn ane_encoder_complete(dir: &std::path::Path) -> bool {
    dir.join("coremldata.bin").is_file()
        && dir.join("model.mil").is_file()
        && dir.join("weights").join("weight.bin").is_file()
}

fn ane_installed_for(model: &str, manager: &speech_models::ModelInstallManager) -> bool {
    super::catalog::ane_encoder_dir(model)
        .is_some_and(|dir_name| ane_encoder_complete(&manager.model_dir(model).join(dir_name)))
}

fn map_status(
    status: speech_models::ModelStatus,
    manager: &speech_models::ModelInstallManager,
) -> ModelStatus {
    let ane_installed = ane_installed_for(&status.id, manager);
    ModelStatus {
        key: status.id,
        installed: status.installed,
        ane_installed,
        bytes_on_disk: status.bytes_on_disk,
        missing_files: status.missing_files,
        directory: status.directory,
    }
}

#[tauri::command]
pub fn list_models() -> Vec<ModelInfo> {
    super::catalog::list_local_models()
}

#[tauri::command]
pub fn check_model_status<R: Runtime>(
    app: AppHandle<R>,
    model: String,
) -> Result<ModelStatus, String> {
    let manager = model_manager(&app).map_err(|err| err.to_string())?;
    let spec = spec_for(&model, false).map_err(|err| err.to_string())?;
    let status = manager.status(&spec).map_err(|err| err.to_string())?;
    Ok(map_status(status, &manager))
}

const MODEL_UNAVAILABLE: &str = "This model is no longer available for download.";

fn ensure_model_downloadable(
    model: &str,
    ane: bool,
    manager: &speech_models::ModelInstallManager,
) -> Result<(), String> {
    if super::catalog::model_is_downloadable(model) {
        return Ok(());
    }
    if !ane {
        return Err(MODEL_UNAVAILABLE.to_string());
    }
    let base_spec = spec_for(model, false).map_err(|err| err.to_string())?;
    let installed = manager
        .status(&base_spec)
        .map(|status| status.installed)
        .map_err(|err| err.to_string())?;
    if installed {
        Ok(())
    } else {
        Err(MODEL_UNAVAILABLE.to_string())
    }
}

#[tauri::command]
pub async fn download_model(
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, crate::AppState>,
    model: String,
    ane: Option<bool>,
) -> Result<ModelStatus, String> {
    let manager = model_manager(&app)
        .map_err(|err| track_download_error(&app, &model, "resolve", err.to_string()))?;
    let ane = ane.unwrap_or(false);
    ensure_model_downloadable(&model, ane, &manager)
        .map_err(|err| track_download_error(&app, &model, "resolve", err))?;
    let spec = spec_for(&model, ane)
        .map_err(|err| track_download_error(&app, &model, "resolve", err.to_string()))?;
    ensure_models_root(&app)
        .map_err(|err| track_download_error(&app, &model, "install", err.to_string()))?;
    let ane_pending = ane
        && super::catalog::ane_encoder_dir(&model).is_some()
        && !ane_installed_for(&model, &manager);
    let cancel_token = state.create_download_token(&model);
    let progress_app = app.clone();
    let progress = |event: speech_models::ModelDownloadProgress| {
        let _ = progress_app.emit(
            "download:progress",
            DownloadProgressPayload {
                model: event.model,
                file: event.file,
                downloaded: event.downloaded,
                total: event.total,
                percent: event.percent,
                verifying: event.verifying,
            },
        );
    };

    let result = manager
        .install(
            &spec,
            speech_models::InstallOptions {
                cancel_token: Some(cancel_token.clone()),
                progress: Some(&progress),
            },
        )
        .await;

    state.clear_download_token(&model);

    let status = match result {
        Ok(status) => status,
        Err(err) => {
            if cancel_token.is_cancelled() {
                let _ = app.emit(
                    "download:cancelled",
                    DownloadCancelledPayload {
                        model: model.clone(),
                    },
                );
                let status = manager.status(&spec).map_err(|err| err.to_string())?;
                return Ok(map_status(status, &manager));
            }
            let reason = crate::analytics::classify_failure_reason(&err.to_string());
            let stage = match reason {
                "verification" => "verify",
                "storage" => "install",
                _ => "download",
            };
            crate::analytics::track_model_download_failed(&app, &model, stage, reason);
            let _ = app.emit(
                "download:error",
                DownloadErrorPayload {
                    model,
                    error: err.to_string(),
                },
            );
            return Err(err.to_string());
        }
    };

    let _ = app.emit(
        "download:complete",
        DownloadCompletePayload {
            model: status.id.clone(),
        },
    );

    crate::analytics::track_model_downloaded(&app, &status.id);

    if ane_pending {
        // The compile loads the model itself and warms once it lands.
        spawn_ane_compile(app.clone(), model.clone());
    } else {
        super::warm_model(&app, status.id.clone());
    }

    let settings = state.current_settings();
    if let Err(err) = crate::tray::refresh_tray_menu(&app, &settings) {
        tracing::error!("Failed to refresh tray menu after download: {err}");
    }

    Ok(map_status(status, &manager))
}

fn track_download_error(
    app: &AppHandle<AppRuntime>,
    model: &str,
    stage: &str,
    message: String,
) -> String {
    crate::analytics::track_model_download_failed(
        app,
        model,
        stage,
        crate::analytics::classify_failure_reason(&message),
    );
    message
}

/// The manager deletes with `remove_dir_all`, so clear the tree first.
fn delete_model_dir(
    manager: &speech_models::ModelInstallManager,
    model: &str,
) -> Result<speech_models::ModelStatus> {
    let dir = manager.model_dir(model);
    crate::platform::remove_dir_all_compat(&dir)
        .with_context(|| format!("remove model directory {}", dir.display()))?;
    manager.delete(model)
}

/// Windows can hold a file open for a moment after it closes (antivirus,
/// indexer), so retry before reporting failure.
fn delete_with_retry(
    manager: &speech_models::ModelInstallManager,
    model: &str,
) -> Result<speech_models::ModelStatus> {
    let mut attempts = 0;
    loop {
        match delete_model_dir(manager, model) {
            Ok(status) => return Ok(status),
            Err(err) => {
                attempts += 1;
                if attempts == 3 {
                    return Err(err);
                }
                tracing::warn!("[speech] delete {model} retrying after: {err:#}");
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
    }
}

#[tauri::command]
pub async fn delete_model(
    app: AppHandle<AppRuntime>,
    model: String,
) -> Result<ModelStatus, String> {
    let handle = app.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        let manager = model_manager(&handle).map_err(|err| err.to_string())?;

        if let Some(state) = handle.try_state::<crate::AppState>() {
            let transcriber = state.local_transcriber();
            if transcriber.loaded_model_id().as_deref() == Some(model.as_str()) {
                transcriber.unload();
            }
        }

        delete_with_retry(&manager, &model)
            .map(|status| map_status(status, &manager))
            .map_err(|err| {
                tracing::error!("[speech] delete {model} failed: {err:#}");
                format!("{err:#}")
            })
    })
    .await
    .map_err(|err| err.to_string())??;

    if let Some(state) = app.try_state::<crate::AppState>() {
        let settings = state.current_settings();
        if let Err(err) = crate::tray::refresh_tray_menu(&app, &settings) {
            tracing::error!("Failed to refresh tray menu after delete: {err}");
        }
    }

    Ok(status)
}

#[tauri::command]
pub fn cancel_download(
    model: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<bool, String> {
    Ok(state.cancel_download(&model))
}

pub fn ensure_model_ready<R: Runtime>(app: &AppHandle<R>, model: &str) -> Result<ReadyModel> {
    let manager = model_manager(app)?;
    let spec = spec_for(model, false)?;
    let resolved = manager.resolve(&spec)?;
    Ok(ReadyModel {
        key: resolved.id,
        path: resolved.path,
        engine: resolved.engine,
    })
}

pub fn ensure_local_fallback_model<R: Runtime>(
    app: &AppHandle<R>,
    preferred: &str,
) -> Result<ReadyModel> {
    if let Ok(model) = ensure_model_ready(app, preferred) {
        return Ok(model);
    }

    for manifest in super::catalog::local_manifests() {
        if manifest.id == preferred {
            continue;
        }
        if let Ok(model) = ensure_model_ready(app, manifest.id) {
            tracing::error!(
                "[LocalTranscriber] Using installed local model `{}` for remote fallback (preferred `{preferred}` is unavailable)",
                manifest.id
            );
            return Ok(model);
        }
    }

    Err(anyhow::anyhow!(
        "No local transcription model is installed for fallback"
    ))
}
