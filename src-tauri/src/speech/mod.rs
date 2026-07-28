pub mod catalog;
pub mod engine;
pub mod install;
pub mod menu;
pub mod remote;

use std::path::Path;

use anyhow::{Result, anyhow};
use reqwest::Client;
use tauri::{AppHandle, Manager};

use crate::settings::UserSettings;
use crate::transcription_api::TranscriptionSuccess;
use crate::{AppRuntime, AppState};

pub use catalog::{SpeechModel, list_models};

pub const WHISPER_CHUNK_SECONDS: u32 = 28;
pub const WHISPER_CHUNK_OVERLAP_SECONDS: u32 = 2;
pub const WHISPER_LEADING_PAD_SECONDS: f32 = 0.2;
pub const PARAKEET_CHUNK_SECONDS: u32 = 180;
pub const PARAKEET_CHUNK_OVERLAP_SECONDS: u32 = 3;
pub const VAD_MIN_SPEECH_PERCENT_FILE: f32 = 2.0;
pub const VAD_MIN_SPEECH_PERCENT_CHUNK: f32 = 5.0;

pub fn selected_model(settings: &UserSettings) -> String {
    if remote::is_configured(settings) {
        remote::speech_model_storage_label(settings, None)
    } else {
        settings.local_model.clone()
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn transcribe<T, Fut>(
    app: &AppHandle<AppRuntime>,
    client: &Client,
    settings: &UserSettings,
    model_id: &str,
    wav_path: &Path,
    local_fallback_model: &str,
    wants_timestamps: bool,
    is_cancelled: impl Fn() -> bool,
    map_remote: impl FnOnce(TranscriptionSuccess) -> T,
    local: impl FnOnce() -> Fut,
) -> Result<T>
where
    Fut: std::future::Future<Output = Result<T>>,
{
    if !(remote::is_remote_model(model_id) && remote::is_configured(settings)) {
        return local().await;
    }

    match remote::attempt_remote(
        app,
        client,
        settings,
        wav_path,
        local_fallback_model,
        remote::TranscribeOptions {
            timestamps: wants_timestamps,
            diarization: false,
        },
        is_cancelled,
    )
    .await
    {
        remote::RemoteAttempt::Success(success) => Ok(map_remote(success.transcription)),
        remote::RemoteAttempt::Fallback => local().await,
        remote::RemoteAttempt::Cancelled => Err(anyhow!("Transcription cancelled")),
        remote::RemoteAttempt::Unavailable(message) => Err(anyhow!(message)),
    }
}

pub fn warm(app: &AppHandle<AppRuntime>, settings: &UserSettings) {
    if remote::is_configured(settings) {
        return;
    }

    warm_model(app, settings.local_model.clone());
}

/// Loads a model off-thread. The idle monitor unloads it again if it goes unused.
pub fn warm_model(app: &AppHandle<AppRuntime>, model_key: String) {
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let ready = match install::ensure_model_ready(&app_handle, &model_key) {
            Ok(model) => model,
            Err(err) => {
                tracing::error!("[speech] skipping warm: {err}");
                return;
            }
        };
        let transcriber = app_handle.state::<AppState>().local_transcriber();
        if let Err(err) = transcriber.preload_and_warm_if_needed(&ready) {
            tracing::error!("[speech] warm failed: {err}");
        }
    });
}
