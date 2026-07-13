use std::path::PathBuf;

use tauri::{AppHandle, Emitter, async_runtime};
use tracing::{debug, warn};

use crate::recorder::RecordingSaved;
use crate::{
    AppRuntime, AppState, EVENT_TRANSCRIPTION_COMPLETE, EVENT_TRANSCRIPTION_ERROR,
    TranscriptionCompletePayload, TranscriptionErrorPayload, llm_cleanup, storage, transcribe,
};

pub(crate) fn retry_transcription(
    id: String,
    app: &AppHandle<AppRuntime>,
    state: &AppState,
) -> Result<(), String> {
    debug!(transcription_id = %id, "retry transcription requested");

    let record = state
        .storage()
        .get_by_id(&id)
        .ok_or_else(|| "Transcription not found".to_string())?;

    debug!(
        transcription_id = %id,
        speech_model = %record.speech_model,
        synced = record.synced,
        "found transcription record for retry"
    );

    let audio_path = PathBuf::from(&record.audio_path);
    if !audio_path.exists() {
        return Err(
            "Cannot retry this transcription because its source audio is unavailable.".to_string(),
        );
    }

    let saved = RecordingSaved {
        path: audio_path,
        started_at: record.timestamp,
        ended_at: record.timestamp,
        duration_override_seconds: Some(record.audio_duration_seconds),
        pending_path: None,
    };

    let settings = state.current_settings();
    let saved_mode = (record.mode_id, record.mode_name);
    let cancel_token = state.register_retry_transcription(id.clone());
    transcribe::retry_transcription_async(app, saved, settings, id, saved_mode, cancel_token);

    Ok(())
}

pub(crate) fn retry_llm_cleanup(
    id: String,
    app: &AppHandle<AppRuntime>,
    state: &AppState,
) -> Result<(), String> {
    let record = state
        .storage()
        .get_by_id(&id)
        .ok_or_else(|| "Transcription not found".to_string())?;

    if record.status != storage::TranscriptionStatus::Success {
        return Err("Can only apply cleanup to successful transcriptions".to_string());
    }

    let settings = state.current_settings();
    if !llm_cleanup::is_llm_available(&settings) {
        return Err("Choose a language model in Settings -> Models.".to_string());
    }
    let llm_model = llm_cleanup::resolved_model_label(&settings);

    let text_to_clean = record.raw_text.unwrap_or(record.text);

    let saved_personality = record.mode_id.as_ref().and_then(|mode_id| {
        settings
            .personalities
            .iter()
            .find(|personality| &personality.id == mode_id && personality.enabled)
            .cloned()
    });

    let http = state.http();
    let storage = state.storage();
    let record_id = id.clone();
    let app_handle = app.clone();

    async_runtime::spawn(async move {
        match llm_cleanup::cleanup_transcription(
            &http,
            &text_to_clean,
            &settings,
            saved_personality.as_ref(),
        )
        .await
        {
            Ok(cleaned) => {
                match storage.update_with_llm_cleanup(&record_id, cleaned, llm_model.clone()) {
                    Ok(updated_record) => {
                        let _ = app_handle.emit(
                            EVENT_TRANSCRIPTION_COMPLETE,
                            TranscriptionCompletePayload {
                                transcript: String::new(),
                                auto_paste: false,
                                record: updated_record,
                            },
                        );
                    }
                    Err(err) => {
                        warn!(error = ?err, transcription_id = %record_id, "failed to save cleanup");
                    }
                }
            }
            Err(err) => {
                let message = llm_cleanup::llm_issue_message(&err);
                warn!(error = ?err, transcription_id = %record_id, "cleanup failed");
                let _ = app_handle.emit(
                    EVENT_TRANSCRIPTION_ERROR,
                    TranscriptionErrorPayload {
                        message: format!("Cleanup failed: {message}"),
                        stage: "llm_cleanup".to_string(),
                    },
                );
            }
        }
    });

    Ok(())
}

pub(crate) fn undo_llm_cleanup(
    id: String,
    app: &AppHandle<AppRuntime>,
    state: &AppState,
) -> Result<(), String> {
    let storage = state.storage();

    match storage.revert_to_raw(&id) {
        Ok(Some(record)) => {
            let _ = app.emit(
                EVENT_TRANSCRIPTION_COMPLETE,
                TranscriptionCompletePayload {
                    transcript: String::new(),
                    auto_paste: false,
                    record: Some(record),
                },
            );
            Ok(())
        }
        Ok(None) => Err("No raw text available to revert to".to_string()),
        Err(err) => Err(format!("Failed to undo cleanup: {err}")),
    }
}
