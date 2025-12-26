use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tauri::{async_runtime, AppHandle, Manager};

use crate::{
    analytics, assistive, cloud, dictionary, llm_cleanup, model_manager,
    recorder::{CompletedRecording, RecordingSaved},
    settings::{TranscriptionMode, UserSettings},
    storage, toast, transcription_api, AppRuntime, AppState, EVENT_TRANSCRIPTION_COMPLETE,
    EVENT_TRANSCRIPTION_ERROR, EVENT_TRANSCRIPTION_START,
};

#[derive(Serialize, Clone)]
struct TranscriptionStartPayload {
    path: String,
}

#[derive(Serialize, Clone)]
struct TranscriptionCompletePayload {
    transcript: String,
    auto_paste: bool,
}

#[derive(Serialize, Clone)]
struct TranscriptionErrorPayload {
    message: String,
    stage: String,
}

pub(crate) fn queue_transcription(
    app: &AppHandle<AppRuntime>,
    saved: RecordingSaved,
    recording: CompletedRecording,
) {
    emit_transcription_start(app, &saved);

    let state = app.state::<AppState>();
    state.clear_cancellation();
    state.set_pending_path(Some(saved.path.clone()));

    let pending_selected_text = state.take_pending_selected_text();

    let http = state.http();
    let app_handle = app.clone();
    let saved_for_task = saved.clone();
    let recording_for_task = recording.clone();

    async_runtime::spawn(async move {
        let is_cancelled = || app_handle.state::<AppState>().is_cancelled();

        let settings = app_handle.state::<AppState>().current_settings();
        let config = transcription_api::TranscriptionConfig::from_settings(&settings);
        let use_local = matches!(settings.transcription_mode, TranscriptionMode::Local);

        let cloud_creds = app_handle
            .state::<AppState>()
            .cloud_manager()
            .get_credentials();
        let use_cloud_auth = !use_local && cloud_creds.is_some();

        eprintln!(
            "[transcription] mode={:?} use_local={} has_cloud_creds={} use_cloud_auth={}",
            settings.transcription_mode,
            use_local,
            cloud_creds.is_some(),
            use_cloud_auth
        );

        // Cloud transcription path - handles everything server-side
        if use_cloud_auth {
            let creds = cloud_creds.unwrap();
            let has_selection = pending_selected_text.is_some();
            eprintln!(
                "[transcription] Using cloud auth: url={} edit_mode={}",
                creds.function_url, has_selection
            );
            let cloud_config = transcription_api::CloudTranscriptionConfig::new(
                creds.function_url,
                creds.jwt,
                true,
                if settings.user_context.trim().is_empty() {
                    None
                } else {
                    Some(settings.user_context.clone())
                },
            )
            .with_selected_text(pending_selected_text.clone());

            match transcription_api::request_cloud_transcription(
                &http,
                &saved_for_task,
                &cloud_config,
            )
            .await
            {
                Ok(cloud_result) => {
                    if is_cancelled() {
                        app_handle.state::<AppState>().pill().reset(&app_handle);
                        app_handle.state::<AppState>().set_pending_path(None);
                        return;
                    }

                    let final_transcript = cloud_result.transcript.clone();
                    if count_words(&final_transcript) == 0 {
                        handle_empty_transcription(&app_handle, &saved_for_task.path);
                        return;
                    }

                    let final_transcript =
                        dictionary::apply_replacements(&final_transcript, &settings.replacements);

                    if is_cancelled() {
                        app_handle.state::<AppState>().pill().reset(&app_handle);
                        app_handle.state::<AppState>().set_pending_path(None);
                        return;
                    }

                    let mut pasted = false;
                    if config.auto_paste && !final_transcript.trim().is_empty() {
                        let text = final_transcript.clone();
                        match async_runtime::spawn_blocking(move || assistive::paste_text(&text))
                            .await
                        {
                            Ok(Ok(())) => pasted = true,
                            Ok(Err(err)) => {
                                emit_auto_paste_error(
                                    &app_handle,
                                    format!("Auto paste failed: {err}"),
                                );
                            }
                            Err(err) => {
                                emit_auto_paste_error(
                                    &app_handle,
                                    format!("Auto paste task error: {err}"),
                                );
                            }
                        }
                    }

                    // Use cloud response data directly - ensure speech_model has cloud- prefix
                    let speech_model = if cloud_result.speech_model.starts_with("cloud-") {
                        cloud_result.speech_model.clone()
                    } else {
                        format!("cloud-{}", cloud_result.speech_model)
                    };

                    let metadata = storage::TranscriptionMetadata {
                        speech_model,
                        llm_model: cloud_result.llm_model.clone(),
                        word_count: count_words(&final_transcript),
                        audio_duration_seconds: compute_audio_duration_seconds(&saved_for_task),
                        synced: false,
                    };

                    analytics::track_transcription_completed(
                        &app_handle,
                        "cloud_auth",
                        "cloud_auth",
                        Some(&metadata.speech_model),
                        cloud_result.llm_cleaned,
                        metadata.audio_duration_seconds as f64,
                    );

                    crate::emit_event(
                        &app_handle,
                        EVENT_TRANSCRIPTION_COMPLETE,
                        TranscriptionCompletePayload {
                            transcript: final_transcript.clone(),
                            auto_paste: pasted,
                        },
                    );

                    // Save with proper cloud data
                    if cloud_result.llm_cleaned {
                        let raw = cloud_result
                            .raw_text
                            .unwrap_or_else(|| final_transcript.clone());
                        let _ = app_handle
                            .state::<AppState>()
                            .storage()
                            .save_transcription_with_cleanup(
                                raw,
                                final_transcript,
                                saved_for_task.path.display().to_string(),
                                metadata,
                            );
                    } else {
                        let _ = app_handle.state::<AppState>().storage().save_transcription(
                            final_transcript,
                            saved_for_task.path.display().to_string(),
                            storage::TranscriptionStatus::Success,
                            None,
                            metadata,
                        );
                    }

                    app_handle.state::<AppState>().pill().reset(&app_handle);
                    app_handle.state::<AppState>().set_pending_path(None);
                }
                Err(err) => {
                    emit_transcription_error(
                        &app_handle,
                        format!("Transcription failed: {err}"),
                        "cloud_auth",
                        saved_for_task.path.display().to_string(),
                    );
                    app_handle.state::<AppState>().set_pending_path(None);
                }
            }
            return;
        }

        // Local or legacy API path
        let result = if use_local {
            let model_key = settings.local_model.clone();
            match model_manager::ensure_model_ready(&app_handle, &model_key) {
                Ok(ready_model) => {
                    let dictionary_prompt =
                        dictionary::dictionary_prompt_for_model(&ready_model, &settings);
                    let language = settings.language.clone();
                    let transcriber = app_handle.state::<AppState>().local_transcriber();
                    let local_recording = recording_for_task.clone();
                    match async_runtime::spawn_blocking(move || {
                        transcriber.transcribe(
                            &ready_model,
                            &local_recording.samples,
                            local_recording.sample_rate,
                            dictionary_prompt.as_deref(),
                            Some(&language),
                        )
                    })
                    .await
                    {
                        Ok(inner) => inner,
                        Err(err) => Err(anyhow!("Local transcription task failed: {err}")),
                    }
                }
                Err(err) => Err(err),
            }
        } else {
            transcription_api::request_transcription(&http, &saved_for_task, &config).await
        };

        match result {
            Ok(result) => {
                if is_cancelled() {
                    app_handle.state::<AppState>().pill().reset(&app_handle);
                    app_handle.state::<AppState>().set_pending_path(None);
                    return;
                }

                let raw_transcript = result.transcript.clone();
                let reported_model = result.speech_model.clone();

                if count_words(&raw_transcript) == 0 {
                    handle_empty_transcription(&app_handle, &saved_for_task.path);
                    return;
                }

                if is_cancelled() {
                    app_handle.state::<AppState>().pill().reset(&app_handle);
                    app_handle.state::<AppState>().set_pending_path(None);
                    return;
                }

                if pending_selected_text.is_some() && !llm_cleanup::is_cleanup_available(&settings)
                {
                    emit_transcription_error(
                        &app_handle,
                        "Edit mode requires LLM cleanup to be configured. Enable LLM cleanup in Settings → Models.".to_string(),
                        "edit_mode",
                        saved_for_task.path.display().to_string(),
                    );
                    app_handle.state::<AppState>().set_pending_path(None);
                    return;
                }

                let (final_transcript, llm_cleaned) =
                    if llm_cleanup::is_cleanup_available(&settings) {
                        if let Some(ref selected) = pending_selected_text {
                            match llm_cleanup::edit_transcription(
                                &http,
                                selected,
                                &raw_transcript,
                                &settings,
                            )
                            .await
                            {
                                Ok(edited) => (edited, true),
                                Err(err) => {
                                    eprintln!("LLM edit failed, using raw transcript: {err}");
                                    (raw_transcript.clone(), false)
                                }
                            }
                        } else {
                            match llm_cleanup::cleanup_transcription(
                                &http,
                                &raw_transcript,
                                &settings,
                            )
                            .await
                            {
                                Ok(cleaned) => (cleaned, true),
                                Err(err) => {
                                    eprintln!("LLM cleanup failed, using raw transcript: {err}");
                                    (raw_transcript.clone(), false)
                                }
                            }
                        }
                    } else {
                        (raw_transcript.clone(), false)
                    };

                let final_transcript =
                    dictionary::apply_replacements(&final_transcript, &settings.replacements);

                if count_words(&final_transcript) == 0 {
                    handle_empty_transcription(&app_handle, &saved_for_task.path);
                    return;
                }

                if is_cancelled() {
                    app_handle.state::<AppState>().pill().reset(&app_handle);
                    app_handle.state::<AppState>().set_pending_path(None);
                    return;
                }

                let mut pasted = false;
                if config.auto_paste && !final_transcript.trim().is_empty() {
                    let text = final_transcript.clone();
                    match async_runtime::spawn_blocking(move || assistive::paste_text(&text)).await
                    {
                        Ok(Ok(())) => pasted = true,
                        Ok(Err(err)) => {
                            emit_auto_paste_error(&app_handle, format!("Auto paste failed: {err}"));
                        }
                        Err(err) => {
                            emit_auto_paste_error(
                                &app_handle,
                                format!("Auto paste task error: {err}"),
                            );
                        }
                    }
                }

                let metadata = build_transcription_metadata(
                    &saved_for_task,
                    &settings,
                    use_local,
                    reported_model.as_deref(),
                    &final_transcript,
                    llm_cleaned,
                    false, // Not synced - local transcriptions need to be synced later
                );

                emit_transcription_complete_with_cleanup(
                    &app_handle,
                    raw_transcript,
                    final_transcript,
                    pasted,
                    saved_for_task.path.display().to_string(),
                    llm_cleaned,
                    metadata,
                    "unknown",
                    if use_local { "local" } else { "cloud" },
                );

                app_handle.state::<AppState>().pill().reset(&app_handle);
                app_handle.state::<AppState>().set_pending_path(None);
            }
            Err(err) => {
                let stage = if use_local { "local" } else { "api" };
                emit_transcription_error(
                    &app_handle,
                    format!("Transcription failed: {err}"),
                    stage,
                    saved_for_task.path.display().to_string(),
                );
                app_handle.state::<AppState>().set_pending_path(None);
            }
        }
    });
}

pub(crate) fn retry_transcription_async(
    app: &AppHandle<AppRuntime>,
    saved: RecordingSaved,
    settings: UserSettings,
) {
    let http = app.state::<AppState>().http();
    let cloud_creds = app.state::<AppState>().cloud_manager().get_credentials();
    let app_handle = app.clone();
    let saved_for_task = saved.clone();

    async_runtime::spawn(async move {
        let use_local = matches!(settings.transcription_mode, TranscriptionMode::Local);
        let use_cloud_auth = !use_local && cloud_creds.is_some();

        eprintln!(
            "[retry_transcription] mode={:?} use_local={} has_cloud_creds={} use_cloud_auth={}",
            settings.transcription_mode,
            use_local,
            cloud_creds.is_some(),
            use_cloud_auth
        );

        // Cloud transcription path for retry
        if use_cloud_auth {
            let creds = cloud_creds.unwrap();
            eprintln!(
                "[retry_transcription] Using cloud auth: url={}",
                creds.function_url
            );
            let cloud_config = transcription_api::CloudTranscriptionConfig::new(
                creds.function_url,
                creds.jwt,
                true,
                if settings.user_context.trim().is_empty() {
                    None
                } else {
                    Some(settings.user_context.clone())
                },
            );

            match transcription_api::request_cloud_transcription(
                &http,
                &saved_for_task,
                &cloud_config,
            )
            .await
            {
                Ok(cloud_result) => {
                    eprintln!(
                        "[retry_transcription] Cloud response: transcript_len={} raw_text_len={:?} llm_cleaned={}",
                        cloud_result.transcript.len(),
                        cloud_result.raw_text.as_ref().map(|s| s.len()),
                        cloud_result.llm_cleaned
                    );

                    let final_transcript = cloud_result.transcript.clone();
                    if count_words(&final_transcript) == 0 {
                        handle_empty_transcription(&app_handle, &saved_for_task.path);
                        return;
                    }

                    let final_transcript =
                        dictionary::apply_replacements(&final_transcript, &settings.replacements);

                    // Ensure speech_model has cloud- prefix
                    let speech_model = if cloud_result.speech_model.starts_with("cloud-") {
                        cloud_result.speech_model.clone()
                    } else {
                        format!("cloud-{}", cloud_result.speech_model)
                    };

                    let metadata = storage::TranscriptionMetadata {
                        speech_model,
                        llm_model: cloud_result.llm_model.clone(),
                        word_count: count_words(&final_transcript),
                        audio_duration_seconds: compute_audio_duration_seconds(&saved_for_task),
                        synced: false, // Let frontend sync to establish local_id linkage
                    };

                    analytics::track_transcription_completed(
                        &app_handle,
                        "cloud_auth",
                        "cloud_auth",
                        Some(&metadata.speech_model),
                        cloud_result.llm_cleaned,
                        metadata.audio_duration_seconds as f64,
                    );

                    crate::emit_event(
                        &app_handle,
                        EVENT_TRANSCRIPTION_COMPLETE,
                        TranscriptionCompletePayload {
                            transcript: final_transcript.clone(),
                            auto_paste: false,
                        },
                    );

                    if cloud_result.llm_cleaned {
                        let raw = cloud_result
                            .raw_text
                            .unwrap_or_else(|| final_transcript.clone());
                        eprintln!(
                            "[retry_transcription] Saving with cleanup: raw_len={} cleaned_len={}",
                            raw.len(),
                            final_transcript.len()
                        );
                        let _ = app_handle
                            .state::<AppState>()
                            .storage()
                            .save_transcription_with_cleanup(
                                raw,
                                final_transcript,
                                saved_for_task.path.display().to_string(),
                                metadata,
                            );
                    } else {
                        eprintln!(
                            "[retry_transcription] Saving without cleanup: text_len={}",
                            final_transcript.len()
                        );
                        let _ = app_handle.state::<AppState>().storage().save_transcription(
                            final_transcript,
                            saved_for_task.path.display().to_string(),
                            storage::TranscriptionStatus::Success,
                            None,
                            metadata,
                        );
                    }
                }
                Err(err) => {
                    emit_transcription_error(
                        &app_handle,
                        format!("Transcription failed: {err}"),
                        "cloud_auth",
                        saved_for_task.path.display().to_string(),
                    );
                }
            }
            return;
        }

        // Local or legacy API path
        let result = if use_local {
            match load_audio_for_transcription(&saved_for_task.path) {
                Ok((samples, sample_rate)) => {
                    let model_key = settings.local_model.clone();
                    match model_manager::ensure_model_ready(&app_handle, &model_key) {
                        Ok(ready_model) => {
                            let dictionary_prompt =
                                dictionary::dictionary_prompt_for_model(&ready_model, &settings);
                            let language = settings.language.clone();
                            let transcriber = app_handle.state::<AppState>().local_transcriber();
                            match async_runtime::spawn_blocking(move || {
                                transcriber.transcribe(
                                    &ready_model,
                                    &samples,
                                    sample_rate,
                                    dictionary_prompt.as_deref(),
                                    Some(&language),
                                )
                            })
                            .await
                            {
                                Ok(inner) => inner,
                                Err(err) => Err(anyhow!("Local transcription task failed: {err}")),
                            }
                        }
                        Err(err) => Err(err),
                    }
                }
                Err(err) => Err(err),
            }
        } else {
            let config = transcription_api::TranscriptionConfig::from_settings(&settings);
            transcription_api::request_transcription(&http, &saved_for_task, &config).await
        };

        match result {
            Ok(result) => {
                let raw_transcript = result.transcript.clone();
                let reported_model = result.speech_model.clone();

                if count_words(&raw_transcript) == 0 {
                    handle_empty_transcription(&app_handle, &saved_for_task.path);
                    return;
                }

                let (final_transcript, llm_cleaned) =
                    if llm_cleanup::is_cleanup_available(&settings) {
                        match llm_cleanup::cleanup_transcription(&http, &raw_transcript, &settings)
                            .await
                        {
                            Ok(cleaned) => (cleaned, true),
                            Err(err) => {
                                eprintln!(
                                    "LLM cleanup failed during retry, using raw transcript: {err}"
                                );
                                (raw_transcript.clone(), false)
                            }
                        }
                    } else {
                        (raw_transcript.clone(), false)
                    };

                let final_transcript =
                    dictionary::apply_replacements(&final_transcript, &settings.replacements);

                if count_words(&final_transcript) == 0 {
                    handle_empty_transcription(&app_handle, &saved_for_task.path);
                    return;
                }

                let metadata = build_transcription_metadata(
                    &saved_for_task,
                    &settings,
                    use_local,
                    reported_model.as_deref(),
                    &final_transcript,
                    llm_cleaned,
                    false, // Local retries are not synced
                );

                emit_transcription_complete_with_cleanup(
                    &app_handle,
                    raw_transcript,
                    final_transcript,
                    false,
                    saved_for_task.path.display().to_string(),
                    llm_cleaned,
                    metadata,
                    "unknown",
                    if use_local { "local" } else { "cloud" },
                );
            }
            Err(err) => {
                let stage = if use_local { "local" } else { "api" };
                emit_transcription_error(
                    &app_handle,
                    format!("Transcription failed: {err}"),
                    stage,
                    saved_for_task.path.display().to_string(),
                );
            }
        }
    });
}

fn emit_transcription_start(app: &AppHandle<AppRuntime>, saved: &RecordingSaved) {
    crate::emit_event(
        app,
        EVENT_TRANSCRIPTION_START,
        TranscriptionStartPayload {
            path: saved.path.display().to_string(),
        },
    );
}

fn emit_transcription_complete_with_cleanup(
    app: &AppHandle<AppRuntime>,
    raw_transcript: String,
    final_transcript: String,
    auto_paste: bool,
    audio_path: String,
    llm_cleaned: bool,
    metadata: storage::TranscriptionMetadata,
    mode: &str,
    engine: &str,
) {
    analytics::track_transcription_completed(
        app,
        mode,
        engine,
        Some(&metadata.speech_model),
        llm_cleaned,
        metadata.audio_duration_seconds as f64,
    );

    crate::emit_event(
        app,
        EVENT_TRANSCRIPTION_COMPLETE,
        TranscriptionCompletePayload {
            transcript: final_transcript.clone(),
            auto_paste,
        },
    );

    app.state::<AppState>().pill().reset(app);

    if llm_cleaned {
        let _ = app
            .state::<AppState>()
            .storage()
            .save_transcription_with_cleanup(
                raw_transcript,
                final_transcript,
                audio_path,
                metadata,
            );
    } else {
        let _ = app.state::<AppState>().storage().save_transcription(
            final_transcript,
            audio_path,
            storage::TranscriptionStatus::Success,
            None,
            metadata,
        );
    }
}

fn handle_empty_transcription(app: &AppHandle<AppRuntime>, audio_path: &Path) {
    crate::emit_event(
        app,
        EVENT_TRANSCRIPTION_COMPLETE,
        TranscriptionCompletePayload {
            transcript: String::new(),
            auto_paste: false,
        },
    );

    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "warning".to_string(),
            title: None,
            message: "No words detected. Recording deleted.".to_string(),
            auto_dismiss: Some(true),
            duration: Some(3000),
            retry_id: None,
            mode: None,
            action: None,
            action_label: None,
        },
    );

    if audio_path.exists() {
        if let Err(err) = std::fs::remove_file(audio_path) {
            eprintln!(
                "Failed to remove empty transcription audio {}: {err}",
                audio_path.display()
            );
        }
    }

    app.state::<AppState>().pill().reset(app);
    app.state::<AppState>().set_pending_path(None);
}

pub(crate) fn emit_transcription_error(
    app: &AppHandle<AppRuntime>,
    message: String,
    stage: &str,
    audio_path: String,
) {
    emit_transcription_error_inner(app, message, stage, audio_path, true);
}

fn emit_auto_paste_error(app: &AppHandle<AppRuntime>, message: String) {
    analytics::track_transcription_failed(app, "auto_paste", "n/a", "paste_error");

    let settings = app.state::<AppState>().current_settings();
    let is_local = matches!(settings.transcription_mode, TranscriptionMode::Local);

    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "error".to_string(),
            title: None,
            message,
            auto_dismiss: Some(true),
            duration: Some(3000),
            retry_id: None,
            mode: Some(if is_local {
                "local".into()
            } else {
                "cloud".into()
            }),
            action: None,
            action_label: None,
        },
    );
}

fn emit_transcription_error_inner(
    app: &AppHandle<AppRuntime>,
    message: String,
    stage: &str,
    audio_path: String,
    reset_state: bool,
) {
    let engine = if stage == "local" { "local" } else { "cloud" };
    let reason = if message.contains("No speech") || message.contains("empty") {
        "no_speech"
    } else if message.contains("Model") || message.contains("model") {
        "model_error"
    } else {
        "api_error"
    };
    analytics::track_transcription_failed(app, stage, engine, reason);

    if stage == "cloud_auth" && is_auth_error(&message) {
        cloud::emit_auth_error(app);
    }

    crate::emit_event(
        app,
        EVENT_TRANSCRIPTION_ERROR,
        TranscriptionErrorPayload {
            message: message.clone(),
            stage: stage.to_string(),
        },
    );

    let state = app.state::<AppState>();
    let pill = state.pill();
    pill.transition_to_error_silent(app);

    let settings = state.current_settings();
    let is_local = matches!(settings.transcription_mode, TranscriptionMode::Local);

    let toast_message = format_transcription_error(&message, is_local);
    let metadata = storage::TranscriptionMetadata {
        speech_model: resolve_speech_model_label(&settings, is_local, None),
        ..Default::default()
    };

    let record_result = state.storage().save_transcription(
        String::new(),
        audio_path.clone(),
        storage::TranscriptionStatus::Error,
        Some(toast_message.clone()),
        metadata,
    );

    let retry_id = if !is_local {
        match record_result {
            Ok(record) => Some(record.id),
            Err(err) => {
                eprintln!("Failed to persist failed transcription: {err}");
                None
            }
        }
    } else {
        if let Err(err) = record_result {
            eprintln!("Failed to persist failed transcription: {err}");
        }
        None
    };

    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "error".to_string(),
            title: None,
            message: toast_message,
            auto_dismiss: None,
            duration: None,
            retry_id,
            mode: Some(if is_local {
                "local".into()
            } else {
                "cloud".into()
            }),
            action: None,
            action_label: None,
        },
    );

    if reset_state {
        pill.reset(app);
    }
}

fn is_auth_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthorized")
        || lower.contains("jwt")
        || lower.contains("expired")
        || lower.contains("not authenticated")
        || lower.contains("authentication")
}

fn format_transcription_error(message: &str, is_local: bool) -> String {
    let msg_lower = message.to_lowercase();

    if is_local {
        if msg_lower.contains("not fully installed") || msg_lower.contains("missing:") {
            return "No transcription model installed".to_string();
        }
        if msg_lower.contains("model not found") || msg_lower.contains("no model") {
            return "No transcription model selected".to_string();
        }
    } else {
        if msg_lower.contains("network") || msg_lower.contains("connection") {
            return "Network error. Recording saved. Tap Retry to send again.".to_string();
        }
        if msg_lower.contains("api key") || msg_lower.contains("unauthorized") {
            return "Invalid API key. Update it in Settings.".to_string();
        }
        if msg_lower.contains("timeout") {
            return "Request timed out. Recording saved. Tap Retry to send again.".to_string();
        }
    }

    if msg_lower.contains("microphone") || msg_lower.contains("audio input") {
        return "Microphone error".to_string();
    }
    if msg_lower.contains("permission") {
        return "Permission denied".to_string();
    }
    if msg_lower.contains("auto paste") {
        return "Pasted to clipboard instead".to_string();
    }

    "Transcription failed".to_string()
}

fn build_transcription_metadata(
    saved: &RecordingSaved,
    settings: &UserSettings,
    use_local: bool,
    reported_model: Option<&str>,
    final_text: &str,
    llm_cleaned: bool,
    synced: bool,
) -> storage::TranscriptionMetadata {
    storage::TranscriptionMetadata {
        speech_model: resolve_speech_model_label(settings, use_local, reported_model),
        llm_model: if llm_cleaned {
            llm_cleanup::resolved_model_name(settings)
        } else {
            None
        },
        word_count: count_words(final_text),
        audio_duration_seconds: compute_audio_duration_seconds(saved),
        synced,
    }
}

fn resolve_speech_model_label(
    settings: &UserSettings,
    use_local: bool,
    reported_model: Option<&str>,
) -> String {
    if use_local {
        model_manager::definition(&settings.local_model)
            .map(|def| def.label.to_string())
            .unwrap_or_else(|| settings.local_model.clone())
    } else if let Some(model) = reported_model {
        model.to_string()
    } else {
        "Cloud API".to_string()
    }
}

fn compute_audio_duration_seconds(saved: &RecordingSaved) -> f32 {
    if let Some(override_duration) = saved.duration_override_seconds {
        return override_duration;
    }
    let duration_ms = (saved.ended_at - saved.started_at).num_milliseconds();
    (duration_ms.max(0) as f32) / 1000.0
}

pub(crate) fn count_words(text: &str) -> u32 {
    text.split_whitespace()
        .filter(|word| !word.is_empty())
        .count() as u32
}

pub(crate) fn load_audio_for_transcription(path: &PathBuf) -> Result<(Vec<i16>, u32)> {
    use minimp3::{Decoder, Frame};
    use std::io::Read;

    let mut file = std::fs::File::open(path)
        .with_context(|| format!("Failed to open audio file at {}", path.display()))?;
    let mut mp3_data = Vec::new();
    file.read_to_end(&mut mp3_data)
        .context("Failed to read MP3 file")?;

    let mut decoder = Decoder::new(&mp3_data[..]);
    let mut samples = Vec::new();
    let mut sample_rate = 16000;

    loop {
        match decoder.next_frame() {
            Ok(Frame {
                data,
                sample_rate: sr,
                channels,
                ..
            }) => {
                sample_rate = sr as u32;

                if channels == 1 {
                    samples.extend_from_slice(&data);
                } else {
                    for chunk in data.chunks(channels) {
                        let mono_sample: i32 = chunk.iter().map(|&s| s as i32).sum();
                        samples.push((mono_sample / channels as i32) as i16);
                    }
                }
            }
            Err(minimp3::Error::Eof) => break,
            Err(e) => return Err(anyhow!("MP3 decoding error: {}", e)),
        }
    }

    if samples.is_empty() {
        return Err(anyhow!("No audio data decoded from MP3 file"));
    }

    Ok((samples, sample_rate))
}
