use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, anyhow};
use tauri::{AppHandle, Emitter, Manager, async_runtime};
use tokio_util::sync::CancellationToken;
use webrtc_vad::VadMode;

use crate::{
    AppRuntime, AppState, EVENT_TRANSCRIPTION_COMPLETE, EVENT_TRANSCRIPTION_ERROR,
    TranscriptionCompletePayload, TranscriptionErrorPayload, accessibility_context, analytics,
    assistive, auto_dictionary, dictionary, llm_cleanup, mode_context, model_manager,
    model_manager::{MODEL_CAPABILITY_DICTIONARY, model_supports_capability},
    recorder::{CompletedRecording, RecordingSaved, speech_percentage_i16_with_mode},
    remote_speech,
    settings::{Personality, UserSettings},
    speech, storage, toast, transcription_api, update_checker,
};

pub(crate) fn run_transcription_prune_for_settings(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
) -> Result<()> {
    let count = count_or_prune_transcriptions(
        app,
        crate::settings::auto_delete_transcription_policy(settings),
        chrono::Local::now(),
        true,
    )?;
    if count > 0 {
        app.emit(
            EVENT_TRANSCRIPTION_COMPLETE,
            TranscriptionCompletePayload {
                transcript: String::new(),
                auto_paste: false,
                record: None,
            },
        )?;
    }
    Ok(())
}

pub(crate) fn preview_transcription_prune_for_policy(
    app: &AppHandle<AppRuntime>,
    policy: crate::settings::RecordingPrunePolicy,
) -> Result<u32> {
    count_or_prune_transcriptions(app, policy, chrono::Local::now(), false)
}

fn count_or_prune_transcriptions(
    app: &AppHandle<AppRuntime>,
    policy: crate::settings::RecordingPrunePolicy,
    now: chrono::DateTime<chrono::Local>,
    delete: bool,
) -> Result<u32> {
    if matches!(policy, crate::settings::RecordingPrunePolicy::Never) {
        return Ok(0);
    }

    let cutoff = crate::settings::recording_prune_cutoff(policy, now);
    let cutoff_millis = match (policy, cutoff) {
        (crate::settings::RecordingPrunePolicy::Immediately, _) => now.timestamp_millis(),
        (_, Some(cutoff)) => cutoff.timestamp_millis(),
        _ => return Ok(0),
    };

    let storage = app.state::<AppState>().storage();
    if delete {
        storage
            .prune_before_and_remove_files(cutoff_millis)
            .context("Failed to prune transcriptions")
    } else {
        storage
            .count_prunable_before(cutoff_millis)
            .context("Failed to count prunable transcriptions")
    }
}

struct ProcessedTranscript {
    final_transcript: String,
    llm_cleaned: bool,
    pasted: bool,
}

enum ProcessTranscriptOutcome {
    Ready(ProcessedTranscript),
    Empty,
    Cancelled,
}

struct ProcessTranscriptInput<'a> {
    raw_transcript: String,
    pending_selected_text: Option<String>,
    settings: &'a UserSettings,
    active_mode: Option<&'a Personality>,
    auto_paste: bool,
    log_context: Option<&'a str>,
    cancel_token: Option<&'a CancellationToken>,
    keep_pill_expanded: bool,
    audio_duration_seconds: f32,
}

struct CompletionInput {
    raw_transcript: String,
    final_transcript: String,
    auto_paste: bool,
    audio_path: String,
    pending_path: Option<PathBuf>,
    llm_cleaned: bool,
    metadata: storage::TranscriptionMetadata,
    mode: &'static str,
    transcription_duration_seconds: f32,
    audio_source: &'static str,
    temporary: bool,
    timestamp_override: Option<chrono::DateTime<chrono::Local>>,
}

pub(crate) struct StreamingTranscriptionInput {
    pub(crate) raw_transcript: String,
    pub(crate) duration_seconds: f32,
    pub(crate) audio_path: PathBuf,
    pub(crate) pending_path: Option<PathBuf>,
    pub(crate) settings: UserSettings,
    pub(crate) temporary: bool,
    pub(crate) cancel_token: CancellationToken,
}

pub(crate) fn queue_transcription(
    app: &AppHandle<AppRuntime>,
    saved: RecordingSaved,
    recording: CompletedRecording,
    settings: UserSettings,
    temporary: bool,
    cancel_token: CancellationToken,
) {
    let state = app.state::<AppState>();
    state.set_pending_path(Some(saved.path.clone()));

    let pending_selected_text = state.take_pending_selected_text();

    let http = state.http();
    let app_handle = app.clone();
    let saved_for_task = saved;
    let recording_for_task = recording;

    async_runtime::spawn(async move {
        let transcription_started_at = Instant::now();
        let audio_duration_seconds = compute_audio_duration_seconds(&saved_for_task);
        let cancel_for_check = cancel_token.clone();
        let is_cancelled = move || cancel_for_check.is_cancelled();

        let auto_paste = transcription_api::auto_paste_enabled();

        tracing::info!("[transcription] mode={:?}", settings.transcription_mode,);
        accessibility_context::log_active_context();

        let active_mode = mode_context::resolve_active_personality(&settings);
        let model_id = speech::selected_model(&settings);
        let use_remote = remote_speech::is_remote_model(&model_id);
        let app_for_local = &app_handle;
        let settings_for_local = &settings;
        let cancel_for_local = cancel_token.clone();
        let result = speech::transcribe(
            &app_handle,
            &http,
            &settings,
            &model_id,
            &saved_for_task.path,
            &settings.local_model,
            false,
            &is_cancelled,
            |success| success,
            move || {
                transcribe_completed_recording_locally(
                    app_for_local,
                    settings_for_local,
                    recording_for_task,
                    Some(cancel_for_local),
                    use_remote,
                )
            },
        )
        .await;

        match result {
            Ok(result) => {
                if is_cancelled() {
                    abort_transcription(&app_handle, saved_for_task.pending_path.as_deref(), false);
                    return;
                }

                let raw_transcript = result.transcript.clone();

                if count_words(&raw_transcript) == 0 {
                    handle_empty_transcription(
                        &app_handle,
                        &saved_for_task.path,
                        saved_for_task.pending_path.as_deref(),
                    );
                    return;
                }

                if is_cancelled() {
                    abort_transcription(&app_handle, saved_for_task.pending_path.as_deref(), false);
                    return;
                }

                if pending_selected_text.is_some() && !llm_cleanup::is_llm_available(&settings) {
                    emit_transcription_error_inner(
                        &app_handle,
                        "Edit mode requires a selected language model. Choose one in Settings -> Models."
                            .to_string(),
                        None,
                        "edit_mode",
                        audio_duration_seconds,
                        "microphone",
                        saved_for_task.path.display().to_string(),
                        saved_for_task.pending_path.as_deref(),
                        true,
                        temporary,
                        true,
                    );
                    app_handle.state::<AppState>().set_pending_path(None);
                    return;
                }

                let processed = match process_transcript_text(
                    &app_handle,
                    &http,
                    ProcessTranscriptInput {
                        raw_transcript: raw_transcript.clone(),
                        pending_selected_text,
                        settings: &settings,
                        active_mode: active_mode.as_ref(),
                        auto_paste,
                        log_context: None,
                        cancel_token: Some(&cancel_token),
                        keep_pill_expanded: false,
                        audio_duration_seconds,
                    },
                )
                .await
                {
                    ProcessTranscriptOutcome::Ready(processed) => processed,
                    ProcessTranscriptOutcome::Empty => {
                        handle_empty_transcription(
                            &app_handle,
                            &saved_for_task.path,
                            saved_for_task.pending_path.as_deref(),
                        );
                        return;
                    }
                    ProcessTranscriptOutcome::Cancelled => {
                        abort_transcription(
                            &app_handle,
                            saved_for_task.pending_path.as_deref(),
                            false,
                        );
                        return;
                    }
                };

                if is_cancelled() {
                    abort_transcription(&app_handle, saved_for_task.pending_path.as_deref(), false);
                    return;
                }

                let metadata = build_transcription_metadata(TranscriptionMetadataInput {
                    saved: &saved_for_task,
                    settings: &settings,
                    final_text: &processed.final_transcript,
                    llm_cleaned: processed.llm_cleaned,
                    synced: false,
                    mode: active_mode.as_ref(),
                    speech_model: result.speech_model,
                });

                emit_transcription_complete_with_cleanup(
                    &app_handle,
                    CompletionInput {
                        raw_transcript,
                        final_transcript: processed.final_transcript,
                        auto_paste: processed.pasted,
                        audio_path: saved_for_task.path.display().to_string(),
                        pending_path: saved_for_task.pending_path.clone(),
                        llm_cleaned: processed.llm_cleaned,
                        metadata,
                        mode: transcription_mode_label(&settings),
                        transcription_duration_seconds: transcription_started_at
                            .elapsed()
                            .as_secs_f32(),
                        audio_source: "microphone",
                        temporary,
                        timestamp_override: None,
                    },
                );

                app_handle
                    .state::<AppState>()
                    .pill()
                    .finish_processing(&app_handle);
                app_handle.state::<AppState>().set_pending_path(None);
            }
            Err(err) => {
                if is_cancelled() {
                    discard_pending_recording(saved_for_task.pending_path.as_deref());
                    app_handle.state::<AppState>().set_pending_path(None);
                    return;
                }
                let show_toast = !is_remote_fallback_unavailable(&err);
                emit_transcription_error_inner(
                    &app_handle,
                    format!("Transcription failed: {err}"),
                    Some(analytics::classify_error(&err)),
                    "transcription",
                    audio_duration_seconds,
                    "microphone",
                    saved_for_task.path.display().to_string(),
                    saved_for_task.pending_path.as_deref(),
                    true,
                    temporary,
                    show_toast,
                );
                app_handle.state::<AppState>().set_pending_path(None);
            }
        }
    });
}

async fn transcribe_completed_recording_locally(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
    recording: CompletedRecording,
    cancel_token: Option<CancellationToken>,
    prefer_any_installed: bool,
) -> Result<transcription_api::TranscriptionSuccess> {
    let ready_model = if prefer_any_installed {
        model_manager::ensure_local_fallback_model(app, &settings.local_model)?
    } else {
        model_manager::ensure_model_ready(app, &settings.local_model)?
    };
    let dictionary_terms = dictionary::dictionary_entries_for_model(&ready_model, settings);
    let language = settings.language.clone();
    let transcriber = app.state::<AppState>().local_transcriber();
    let is_whisper = matches!(ready_model.engine, model_manager::LocalModelEngine::Whisper);

    match async_runtime::spawn_blocking(move || {
        let (chunk_seconds, overlap_seconds, leading_pad_seconds, strip_hallucinated_thank_you) =
            if is_whisper {
                (
                    speech::WHISPER_CHUNK_SECONDS,
                    speech::WHISPER_CHUNK_OVERLAP_SECONDS,
                    speech::WHISPER_LEADING_PAD_SECONDS,
                    true,
                )
            } else {
                (
                    speech::PARAKEET_CHUNK_SECONDS,
                    speech::PARAKEET_CHUNK_OVERLAP_SECONDS,
                    0.0,
                    false,
                )
            };
        transcribe_local_chunked(
            &transcriber,
            &ready_model,
            &recording.samples,
            recording.sample_rate,
            LocalChunkingConfig {
                dictionary: &dictionary_terms,
                language: Some(&language),
                chunk_seconds: chunk_seconds as f32,
                overlap_seconds: overlap_seconds as f32,
                leading_pad_seconds,
                cancel_token: cancel_token.as_ref(),
                strip_hallucinated_thank_you,
            },
        )
    })
    .await
    {
        Ok(inner) => inner,
        Err(err) => Err(anyhow!("Local transcription task failed: {err}")),
    }
}

pub(crate) fn recover_interrupted_recordings(app: &AppHandle<AppRuntime>) {
    let base_dir = match crate::recordings_root(app) {
        Ok(path) => path,
        Err(_) => return,
    };
    let app = app.clone();

    async_runtime::spawn(async move {
        let scan_dir = base_dir.clone();
        let recovered = match async_runtime::spawn_blocking(move || {
            crate::recorder::recover_pending_recordings(scan_dir)
        })
        .await
        {
            Ok(list) => list,
            Err(err) => {
                tracing::error!("Recovery scan failed: {err}");
                return;
            }
        };

        if recovered.is_empty() {
            return;
        }

        toast::emit_toast(
            &app,
            toast::Payload {
                toast_type: "info".to_string(),
                message: toast::native(&app, "native.toast.recovering"),
                auto_dismiss: Some(true),
                duration: Some(30000),
                ..Default::default()
            },
        );

        let settings = app.state::<AppState>().current_settings();
        let mut saved_count = 0usize;
        for (saved, recording) in recovered {
            match transcribe_recovered_recording(&app, &saved, recording, &settings).await {
                Ok(RecoveredTranscriptionOutcome::Saved) => {
                    saved_count += 1;
                }
                Ok(RecoveredTranscriptionOutcome::Empty) => {}
                Err(err) => tracing::error!("Failed to transcribe recovered recording: {err}"),
            }
        }

        if saved_count == 0 {
            return;
        }

        toast::emit_toast(
            &app,
            toast::Payload {
                toast_type: "success".to_string(),

                title: Some(toast::native(
                    &app,
                    if saved_count == 1 {
                        "native.toast.recovered_one"
                    } else {
                        "native.toast.recovered_many"
                    },
                )),
                message: toast::native(
                    &app,
                    if saved_count == 1 {
                        "native.toast.recovered_saved_one"
                    } else {
                        "native.toast.recovered_saved_many"
                    },
                ),
                auto_dismiss: Some(false),
                action: Some("view_recovered_transcriptions".to_string()),
                action_label: Some(toast::native(&app, "native.toast.view_history")),
                secondary_action: Some("copy_last_transcription".to_string()),
                secondary_action_label: Some("Copy".to_string()),
                ..Default::default()
            },
        );
    });
}

enum RecoveredTranscriptionOutcome {
    Saved,
    Empty,
}

async fn transcribe_recovered_recording(
    app: &AppHandle<AppRuntime>,
    saved: &RecordingSaved,
    recording: CompletedRecording,
    settings: &UserSettings,
) -> Result<RecoveredTranscriptionOutcome> {
    let transcription_started_at = Instant::now();
    let audio_duration_seconds = compute_audio_duration_seconds(saved);
    let http = app.state::<AppState>().http();
    let active_mode = mode_context::resolve_active_personality(settings);
    let model_id = speech::selected_model(settings);
    let use_remote = remote_speech::is_remote_model(&model_id);

    let result = match speech::transcribe(
        app,
        &http,
        settings,
        &model_id,
        &saved.path,
        &settings.local_model,
        false,
        || false,
        |success| success,
        move || transcribe_completed_recording_locally(app, settings, recording, None, use_remote),
    )
    .await
    {
        Ok(result) => result,
        Err(err) => {
            emit_transcription_error_inner(
                app,
                format!("Transcription failed: {err}"),
                Some(analytics::classify_error(&err)),
                "transcription",
                audio_duration_seconds,
                "microphone",
                saved.path.display().to_string(),
                saved.pending_path.as_deref(),
                false,
                false,
                true,
            );
            return Err(err);
        }
    };

    let raw_transcript = result.transcript.clone();
    if count_words(&raw_transcript) == 0 {
        handle_empty_transcription(app, &saved.path, saved.pending_path.as_deref());
        return Ok(RecoveredTranscriptionOutcome::Empty);
    }

    let processed = match process_transcript_text(
        app,
        &http,
        ProcessTranscriptInput {
            raw_transcript: raw_transcript.clone(),
            pending_selected_text: None,
            settings,
            active_mode: active_mode.as_ref(),
            auto_paste: false,
            log_context: Some("recovery"),
            cancel_token: None,
            keep_pill_expanded: false,
            audio_duration_seconds,
        },
    )
    .await
    {
        ProcessTranscriptOutcome::Ready(processed) => processed,
        ProcessTranscriptOutcome::Empty => {
            handle_empty_transcription(app, &saved.path, saved.pending_path.as_deref());
            return Ok(RecoveredTranscriptionOutcome::Empty);
        }
        ProcessTranscriptOutcome::Cancelled => return Err(anyhow!("Transcription cancelled")),
    };

    let metadata = build_transcription_metadata(TranscriptionMetadataInput {
        saved,
        settings,
        final_text: &processed.final_transcript,
        llm_cleaned: processed.llm_cleaned,
        synced: false,
        mode: active_mode.as_ref(),
        speech_model: result.speech_model,
    });

    let persisted = emit_transcription_complete_with_cleanup(
        app,
        CompletionInput {
            raw_transcript,
            final_transcript: processed.final_transcript,
            auto_paste: false,
            audio_path: saved.path.display().to_string(),
            pending_path: saved.pending_path.clone(),
            llm_cleaned: processed.llm_cleaned,
            metadata,
            mode: transcription_mode_label(settings),
            transcription_duration_seconds: transcription_started_at.elapsed().as_secs_f32(),
            audio_source: "microphone",
            temporary: false,
            timestamp_override: Some(saved.started_at),
        },
    );

    if !persisted {
        return Err(anyhow!("Failed to persist recovered transcription"));
    }

    Ok(RecoveredTranscriptionOutcome::Saved)
}

async fn transcribe_saved_recording_locally(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
    saved: &RecordingSaved,
    cancel_token: Option<CancellationToken>,
    prefer_any_installed: bool,
) -> Result<transcription_api::TranscriptionSuccess> {
    let (samples, sample_rate) = load_audio_for_transcription(&saved.path)?;
    transcribe_completed_recording_locally(
        app,
        settings,
        CompletedRecording {
            samples,
            sample_rate,
            channels: 1,
            started_at: saved.started_at,
            ended_at: saved.ended_at,
            pending_path: None,
            speech_percentage: None,
        },
        cancel_token,
        prefer_any_installed,
    )
    .await
}

async fn process_transcript_text(
    app: &AppHandle<AppRuntime>,
    http: &reqwest::Client,
    input: ProcessTranscriptInput<'_>,
) -> ProcessTranscriptOutcome {
    let ProcessTranscriptInput {
        raw_transcript,
        pending_selected_text,
        settings,
        active_mode,
        auto_paste,
        log_context,
        cancel_token,
        keep_pill_expanded,
        audio_duration_seconds,
    } = input;

    let is_edit_mode = pending_selected_text.is_some();
    let llm_available = llm_cleanup::is_llm_available(settings);
    let should_refine_transcript = llm_cleanup::should_refine_transcript(settings, active_mode);
    let llm_needed = is_edit_mode || should_refine_transcript;
    let preflight_unavailable =
        llm_needed && matches!(llm_cleanup::cached_preflight_available(), Some(false));
    let should_use_llm = if is_edit_mode {
        llm_available && !preflight_unavailable
    } else {
        should_refine_transcript && !preflight_unavailable
    };

    let (final_transcript, llm_cleaned) = if should_use_llm {
        if keep_pill_expanded {
            crate::pill::emit_pill_mode_with_tone(
                app,
                true,
                &raw_transcript,
                crate::pill::PILL_TONE_CLEANUP,
            );
        } else {
            crate::pill::emit_pill_mode_with_tone(app, false, "", crate::pill::PILL_TONE_CLEANUP);
        }
        if let Some(ref selected) = pending_selected_text {
            match llm_cleanup::edit_transcription(http, selected, &raw_transcript, settings).await {
                Ok(edited) => (edited, true),
                Err(err) => {
                    let message = llm_cleanup::llm_issue_message(&err);
                    if let Some(context) = log_context {
                        tracing::error!("LLM edit failed ({context}): {message}");
                    } else {
                        tracing::error!(
                            "LLM edit failed, keeping original selected text: {message}"
                        );
                    }
                    if !llm_cleanup::is_transient_llm_error(&err) {
                        llm_cleanup::note_preflight_failure();
                    }
                    maybe_warn_llm_issue(app, true, &message);
                    (selected.clone(), false)
                }
            }
        } else {
            match llm_cleanup::cleanup_transcription(http, &raw_transcript, settings, active_mode)
                .await
            {
                Ok(cleaned) => (cleaned, true),
                Err(err) => {
                    let message = llm_cleanup::llm_issue_message(&err);
                    if let Some(context) = log_context {
                        tracing::error!("Cleanup failed ({context}): {message}");
                    } else {
                        tracing::error!("Cleanup failed, using raw transcript: {message}");
                    }
                    if !llm_cleanup::is_transient_llm_error(&err) {
                        llm_cleanup::note_preflight_failure();
                    }
                    maybe_warn_llm_issue(app, false, &message);
                    (raw_transcript.clone(), false)
                }
            }
        }
    } else {
        if preflight_unavailable {
            maybe_warn_llm_unavailable(app, is_edit_mode);
        }
        (raw_transcript.clone(), false)
    };
    if should_use_llm {
        crate::pill::emit_pill_mode_with_tone(app, false, "", crate::pill::PILL_TONE_DEFAULT);
    }

    let final_transcript =
        dictionary::apply_replacements(&final_transcript, &settings.replacements);
    if count_words(&final_transcript) == 0 {
        return ProcessTranscriptOutcome::Empty;
    }

    let token_cancelled = cancel_token.map(|t| t.is_cancelled()).unwrap_or(false);
    if token_cancelled || app.state::<AppState>().is_cancelled() {
        return ProcessTranscriptOutcome::Cancelled;
    }

    let mut pasted = false;
    if auto_paste && !final_transcript.trim().is_empty() {
        let can_read_field = !is_edit_mode && cfg!(any(target_os = "macos", target_os = "windows"));
        let selected_model = speech::selected_model(settings);
        let selected_model_supports_dictionary = remote_speech::is_remote_model(&selected_model)
            || model_supports_capability(&selected_model, MODEL_CAPABILITY_DICTIONARY);
        let should_watch_auto_dictionary = can_read_field
            && settings.auto_dictionary_enabled
            && selected_model_supports_dictionary;
        let transcript_to_paste = final_transcript.clone();
        let token_for_paste = cancel_token.cloned();
        let app_for_paste = app.clone();
        let paste_result = async_runtime::spawn_blocking(move || {
            let cancelled = token_for_paste
                .as_ref()
                .map(|token| token.is_cancelled())
                .unwrap_or(false)
                || app_for_paste.state::<AppState>().is_cancelled();
            if cancelled {
                return None;
            }
            let pre_paste_snapshot = can_read_field
                .then(assistive::focused_text_snapshot)
                .flatten();
            let text = pre_paste_snapshot
                .as_ref()
                .map(|snapshot| {
                    match_insertion_capitalization(&transcript_to_paste, &snapshot.value)
                })
                .unwrap_or(transcript_to_paste);
            let result = assistive::paste_text(&text);
            Some((result, pre_paste_snapshot, text))
        })
        .await;
        match paste_result {
            Ok(None) => return ProcessTranscriptOutcome::Cancelled,
            Ok(Some((Ok(()), pre_paste_snapshot, pasted_text))) => {
                pasted = true;
                if let (true, Some(pre_paste_snapshot)) =
                    (should_watch_auto_dictionary, pre_paste_snapshot)
                {
                    auto_dictionary::start_after_paste(
                        app.clone(),
                        pre_paste_snapshot,
                        pasted_text,
                        settings.dictionary.clone(),
                        settings.auto_dictionary_ignored.clone(),
                    );
                }
            }
            Ok(Some((Err(err), _, _))) => emit_auto_paste_error(
                app,
                format!("Auto paste failed: {err}"),
                audio_duration_seconds,
            ),
            Err(err) => emit_auto_paste_error(
                app,
                format!("Auto paste task error: {err}"),
                audio_duration_seconds,
            ),
        }
    }

    ProcessTranscriptOutcome::Ready(ProcessedTranscript {
        final_transcript,
        llm_cleaned,
        pasted,
    })
}

pub(crate) fn retry_transcription_async(
    app: &AppHandle<AppRuntime>,
    saved: RecordingSaved,
    settings: UserSettings,
    original_id: String,
    saved_mode: (Option<String>, Option<String>),
    cancel_token: CancellationToken,
) {
    let http = app.state::<AppState>().http();
    let app_handle = app.clone();
    let saved_for_task = saved.clone();
    let retry_id = original_id.clone();
    let (saved_mode_id, saved_mode_name) = saved_mode;

    // Look up the saved personality (if it still exists and is enabled)
    let saved_personality = saved_mode_id.as_ref().and_then(|id| {
        settings
            .personalities
            .iter()
            .find(|p| &p.id == id && p.enabled)
            .cloned()
    });

    async_runtime::spawn(async move {
        let transcription_started_at = Instant::now();
        let audio_duration_seconds = compute_audio_duration_seconds(&saved_for_task);
        struct RetryTokenGuard {
            app: AppHandle<AppRuntime>,
            id: String,
        }

        impl Drop for RetryTokenGuard {
            fn drop(&mut self) {
                self.app
                    .state::<AppState>()
                    .clear_retry_transcription(&self.id);
            }
        }

        let _guard = RetryTokenGuard {
            app: app_handle.clone(),
            id: retry_id.clone(),
        };

        if cancel_token.is_cancelled() {
            return;
        }

        tracing::info!(
            "[retry_transcription] mode={:?}",
            settings.transcription_mode,
        );
        let model_id = speech::selected_model(&settings);
        let use_remote = remote_speech::is_remote_model(&model_id);
        let result = speech::transcribe(
            &app_handle,
            &http,
            &settings,
            &model_id,
            &saved_for_task.path,
            &settings.local_model,
            false,
            || cancel_token.is_cancelled(),
            |success| success,
            || {
                transcribe_saved_recording_locally(
                    &app_handle,
                    &settings,
                    &saved_for_task,
                    Some(cancel_token.clone()),
                    use_remote,
                )
            },
        )
        .await;

        match result {
            Ok(result) => {
                if cancel_token.is_cancelled() {
                    return;
                }
                let raw_transcript = result.transcript.clone();

                if count_words(&raw_transcript) == 0 {
                    handle_empty_transcription(&app_handle, &saved_for_task.path, None);
                    return;
                }

                let should_refine_transcript =
                    llm_cleanup::should_refine_transcript(&settings, saved_personality.as_ref());
                let preflight_unavailable = should_refine_transcript
                    && matches!(llm_cleanup::cached_preflight_available(), Some(false));
                let should_use_llm = should_refine_transcript && !preflight_unavailable;

                let (final_transcript, llm_cleaned) = if should_use_llm {
                    match llm_cleanup::cleanup_transcription(
                        &http,
                        &raw_transcript,
                        &settings,
                        saved_personality.as_ref(),
                    )
                    .await
                    {
                        Ok(cleaned) => (cleaned, true),
                        Err(err) => {
                            let message = llm_cleanup::llm_issue_message(&err);
                            tracing::error!(
                                "Cleanup failed during retry, using raw transcript: {message}"
                            );
                            llm_cleanup::note_preflight_failure();
                            maybe_warn_llm_unavailable(&app_handle, false);
                            (raw_transcript.clone(), false)
                        }
                    }
                } else {
                    if preflight_unavailable {
                        maybe_warn_llm_unavailable(&app_handle, false);
                    }
                    (raw_transcript.clone(), false)
                };

                let final_transcript =
                    dictionary::apply_replacements(&final_transcript, &settings.replacements);

                if count_words(&final_transcript) == 0 {
                    handle_empty_transcription(&app_handle, &saved_for_task.path, None);
                    return;
                }

                if cancel_token.is_cancelled() {
                    return;
                }

                let metadata = storage::TranscriptionMetadata {
                    speech_model: result
                        .speech_model
                        .filter(|label| !label.trim().is_empty())
                        .unwrap_or_else(|| resolve_speech_model_label(&settings)),
                    llm_model: if llm_cleaned {
                        llm_cleanup::resolved_model_label(&settings)
                    } else {
                        None
                    },
                    word_count: count_words(&final_transcript),
                    audio_duration_seconds: compute_audio_duration_seconds(&saved_for_task),
                    synced: false,
                    mode_id: saved_mode_id.clone(),
                    mode_name: saved_mode_name.clone(),
                };

                let raw_text = if llm_cleaned {
                    Some(raw_transcript.clone())
                } else {
                    None
                };

                tracing::info!(
                    "[retry_transcription] Updating local record {}: text_len={} llm_cleaned={}",
                    retry_id,
                    final_transcript.len(),
                    llm_cleaned
                );

                let updated_record = match app_handle
                    .state::<AppState>()
                    .storage()
                    .update_transcription_result(
                        &retry_id,
                        final_transcript.clone(),
                        raw_text,
                        storage::TranscriptionStatus::Success,
                        None,
                        metadata.clone(),
                    ) {
                    Ok(record) => record,
                    Err(err) => {
                        tracing::error!("Failed to save retry result: {err}");
                        return;
                    }
                };

                analytics::track_transcription_completed(
                    &app_handle,
                    transcription_mode_label(&settings),
                    Some(&metadata.speech_model),
                    llm_cleaned,
                    metadata.audio_duration_seconds,
                    transcription_started_at.elapsed().as_secs_f32(),
                    metadata.word_count,
                    "microphone",
                );
                app_handle
                    .state::<AppState>()
                    .record_transcription_completed();

                crate::emit_event(
                    &app_handle,
                    EVENT_TRANSCRIPTION_COMPLETE,
                    TranscriptionCompletePayload {
                        transcript: final_transcript,
                        auto_paste: false,
                        record: updated_record,
                    },
                );
            }
            Err(err) => {
                if cancel_token.is_cancelled() {
                    return;
                }
                let show_toast = !is_remote_fallback_unavailable(&err);
                emit_transcription_error_inner(
                    &app_handle,
                    format!("Transcription failed: {err}"),
                    Some(analytics::classify_error(&err)),
                    "transcription",
                    audio_duration_seconds,
                    "microphone",
                    saved_for_task.path.display().to_string(),
                    None,
                    true,
                    false,
                    show_toast,
                );
            }
        }
    });
}

fn emit_transcription_complete_with_cleanup(
    app: &AppHandle<AppRuntime>,
    input: CompletionInput,
) -> bool {
    let CompletionInput {
        raw_transcript,
        final_transcript,
        auto_paste,
        audio_path,
        pending_path,
        llm_cleaned,
        metadata,
        mode,
        transcription_duration_seconds,
        audio_source,
        temporary,
        timestamp_override,
    } = input;

    analytics::track_transcription_completed(
        app,
        mode,
        Some(&metadata.speech_model),
        llm_cleaned,
        metadata.audio_duration_seconds,
        transcription_duration_seconds,
        metadata.word_count,
        audio_source,
    );
    app.state::<AppState>().record_transcription_completed();

    let (record, persisted) = if temporary {
        (None, true)
    } else {
        let save_result = if llm_cleaned {
            app.state::<AppState>()
                .storage()
                .save_transcription_with_cleanup(
                    raw_transcript,
                    final_transcript.clone(),
                    audio_path.clone(),
                    metadata,
                    None,
                    timestamp_override,
                )
        } else {
            app.state::<AppState>().storage().save_transcription(
                final_transcript.clone(),
                audio_path.clone(),
                storage::TranscriptionStatus::Success,
                None,
                metadata,
                None,
                timestamp_override,
            )
        };

        match save_result {
            Ok(record) => {
                discard_pending_recording(pending_path.as_deref());
                (Some(record), true)
            }
            Err(err) => {
                tracing::error!("Failed to persist transcription: {err}");
                (None, false)
            }
        }
    };

    crate::emit_event(
        app,
        EVENT_TRANSCRIPTION_COMPLETE,
        TranscriptionCompletePayload {
            transcript: final_transcript,
            auto_paste,
            record,
        },
    );

    app.state::<AppState>().pill().finish_processing(app);

    if temporary {
        let _ = std::fs::remove_file(&audio_path);
        discard_pending_recording(pending_path.as_deref());
        return true;
    }

    let settings = app.state::<AppState>().current_settings();
    if let Err(err) = crate::tray::refresh_tray_menu(app, &settings) {
        tracing::error!("Failed to refresh tray menu: {err}");
    }
    #[cfg(target_os = "macos")]
    if let Err(err) = crate::set_app_menu(app, &settings) {
        tracing::error!("Failed to refresh app menu: {err}");
    }

    crate::schedule_recording_prune(app.clone(), settings.clone());
    crate::schedule_transcription_prune(app.clone(), settings);

    let update_state = app.state::<AppState>().update_state().clone();
    if !update_checker::maybe_show_update_toast(app, &update_state) {
        crate::notifications::evaluate_after_use(app);
    }
    crate::asks::evaluate_after_use(app);

    persisted
}

fn abort_transcription(
    app: &AppHandle<AppRuntime>,
    pending_path: Option<&Path>,
    collapse_pill: bool,
) {
    if collapse_pill {
        crate::pill::collapse_expanded_pill(app);
    }
    let state = app.state::<AppState>();
    state.pill().finish_processing(app);
    discard_pending_recording(pending_path);
    state.set_pending_path(None);
}

fn discard_pending_recording(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

fn handle_empty_transcription(
    app: &AppHandle<AppRuntime>,
    audio_path: &Path,
    pending_path: Option<&Path>,
) {
    analytics::track_dictation_discarded(app, "empty_transcript");

    crate::emit_event(
        app,
        EVENT_TRANSCRIPTION_COMPLETE,
        TranscriptionCompletePayload {
            transcript: String::new(),
            auto_paste: false,
            record: None,
        },
    );

    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "warning".to_string(),
            message: toast::native(app, "native.toast.no_words"),
            auto_dismiss: Some(true),
            duration: Some(3000),
            ..Default::default()
        },
    );

    if audio_path.exists()
        && let Err(err) = std::fs::remove_file(audio_path)
    {
        tracing::error!(
            "Failed to remove empty transcription audio {}: {err}",
            audio_path.display()
        );
    }
    discard_pending_recording(pending_path);

    let prune_settings = app.state::<AppState>().current_settings();
    crate::schedule_recording_prune(app.clone(), prune_settings.clone());
    crate::schedule_transcription_prune(app.clone(), prune_settings);

    app.state::<AppState>().pill().finish_processing(app);
    app.state::<AppState>().set_pending_path(None);
}

fn is_remote_fallback_unavailable(err: &anyhow::Error) -> bool {
    remote_speech::is_fallback_unavailable_message(&err.to_string())
}

fn emit_auto_paste_error(
    app: &AppHandle<AppRuntime>,
    message: String,
    audio_duration_seconds: f32,
) {
    let settings = app.state::<AppState>().current_settings();
    analytics::track_transcription_failed(
        app,
        "auto_paste",
        transcription_mode_label(&settings),
        &resolve_speech_model_label(&settings),
        "paste_error",
        Some(audio_duration_seconds),
        "microphone",
    );

    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "error".to_string(),
            message,
            auto_dismiss: Some(true),
            duration: Some(3000),
            mode: Some("local".into()),
            ..Default::default()
        },
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_transcription_error_inner(
    app: &AppHandle<AppRuntime>,
    message: String,
    reason: Option<&'static str>,
    stage: &str,
    audio_duration_seconds: f32,
    audio_source: &str,
    audio_path: String,
    pending_path: Option<&Path>,
    reset_state: bool,
    temporary: bool,
    show_toast: bool,
) {
    let reason = reason.unwrap_or_else(|| analytics::classify_failure_reason(&message));
    let state = app.state::<AppState>();
    let settings = state.current_settings();
    analytics::track_transcription_failed(
        app,
        stage,
        transcription_mode_label(&settings),
        &resolve_speech_model_label(&settings),
        reason,
        Some(audio_duration_seconds),
        audio_source,
    );

    crate::emit_event(
        app,
        EVENT_TRANSCRIPTION_ERROR,
        TranscriptionErrorPayload {
            message: message.clone(),
            stage: stage.to_string(),
        },
    );

    let toast_message = format_transcription_error(&message);
    let metadata = storage::TranscriptionMetadata {
        speech_model: resolve_speech_model_label(&settings),
        audio_duration_seconds,
        ..Default::default()
    };

    if temporary {
        let _ = std::fs::remove_file(&audio_path);
        discard_pending_recording(pending_path);
    } else {
        let record_result = state.storage().save_transcription(
            String::new(),
            audio_path.clone(),
            storage::TranscriptionStatus::Error,
            Some(toast_message.clone()),
            metadata,
            None,
            None,
        );

        match record_result {
            Ok(_) => discard_pending_recording(pending_path),
            Err(err) => tracing::error!("Failed to persist failed transcription: {err}"),
        }
    }

    if state.pill().status() == crate::pill::PillStatus::Listening {
        return;
    }

    if show_toast {
        toast::emit_toast(
            app,
            toast::Payload {
                toast_type: "error".to_string(),
                message: toast_message,
                mode: Some("local".into()),
                ..Default::default()
            },
        );
    }

    crate::schedule_recording_prune(app.clone(), settings.clone());
    crate::schedule_transcription_prune(app.clone(), settings);

    if reset_state {
        state.pill().reset(app);
    }
}

fn format_transcription_error(message: &str) -> String {
    let msg_lower = message.to_lowercase();

    if msg_lower.contains("not fully installed") || msg_lower.contains("missing:") {
        return "No transcription model installed".to_string();
    }
    if msg_lower.contains("model not found") || msg_lower.contains("no model") {
        return "No transcription model selected".to_string();
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

struct TranscriptionMetadataInput<'a> {
    saved: &'a RecordingSaved,
    settings: &'a UserSettings,
    final_text: &'a str,
    llm_cleaned: bool,
    synced: bool,
    mode: Option<&'a Personality>,
    speech_model: Option<String>,
}

fn build_transcription_metadata(
    input: TranscriptionMetadataInput<'_>,
) -> storage::TranscriptionMetadata {
    let TranscriptionMetadataInput {
        saved,
        settings,
        final_text,
        llm_cleaned,
        synced,
        mode,
        speech_model,
    } = input;

    storage::TranscriptionMetadata {
        speech_model: speech_model
            .filter(|label| !label.trim().is_empty())
            .unwrap_or_else(|| resolve_speech_model_label(settings)),
        llm_model: if llm_cleaned {
            llm_cleanup::resolved_model_label(settings)
        } else {
            None
        },
        word_count: count_words(final_text),
        audio_duration_seconds: compute_audio_duration_seconds(saved),
        synced,
        mode_id: mode.map(|m| m.id.clone()),
        mode_name: mode.map(|m| m.name.clone()),
    }
}

fn resolve_speech_model_label(settings: &UserSettings) -> String {
    if remote_speech::is_configured(settings) {
        remote_speech::speech_model_storage_label(settings, None)
    } else {
        model_manager::model_label(&settings.local_model)
    }
}

fn transcription_mode_label(settings: &UserSettings) -> &'static str {
    if remote_speech::is_configured(settings) {
        "remote"
    } else {
        "local"
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
    text.split_whitespace().count() as u32
}

fn match_insertion_capitalization(text: &str, field_value: &str) -> String {
    let field_tail = field_value.trim_end_matches([' ', '\t']);
    let Some(last_field_char) = field_tail.chars().last() else {
        return text.to_string();
    };
    if matches!(last_field_char, '.' | '!' | '?' | '…' | ':' | '\n' | '\r')
        || field_tail
            .lines()
            .next_back()
            .is_some_and(line_is_list_marker)
    {
        return text.to_string();
    }

    let Some((index, first_letter)) = text.char_indices().find(|(_, ch)| ch.is_alphabetic()) else {
        return text.to_string();
    };
    if preserves_leading_token_case(text, index) {
        return text.to_string();
    }

    let mut result = String::with_capacity(text.len());
    result.push_str(&text[..index]);
    result.extend(first_letter.to_lowercase());
    result.push_str(&text[index + first_letter.len_utf8()..]);
    result
}

fn preserves_leading_token_case(text: &str, start: usize) -> bool {
    let token: String = text[start..]
        .chars()
        .take_while(|ch| ch.is_alphabetic())
        .collect();
    if token.chars().count() <= 1 {
        return false;
    }

    token.chars().all(|ch| !ch.is_lowercase()) || token.chars().skip(1).any(|ch| ch.is_uppercase())
}

fn line_is_list_marker(line: &str) -> bool {
    let marker = line.trim();
    if matches!(marker, "-" | "*" | "+" | "•") {
        return true;
    }

    marker
        .strip_suffix(['.', ')'])
        .is_some_and(|prefix| !prefix.is_empty() && prefix.chars().all(|ch| ch.is_ascii_digit()))
}

pub(crate) fn load_audio_for_transcription(path: &Path) -> Result<(Vec<i16>, u32)> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if ext != "wav" {
        return Err(anyhow!("Unsupported audio format: {ext}"));
    }

    decode_wav(path)
}

fn decode_wav(path: &Path) -> Result<(Vec<i16>, u32)> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("Failed to open WAV file at {}", path.display()))?;
    let mut reader = hound::WavReader::new(file).map_err(|err| anyhow!("WAV read error: {err}"))?;
    let spec = reader.spec();
    if spec.sample_format != hound::SampleFormat::Int {
        return Err(anyhow!("Unsupported WAV sample format"));
    }
    if spec.bits_per_sample != 16 {
        return Err(anyhow!(
            "Unsupported WAV bits per sample: {}",
            spec.bits_per_sample
        ));
    }

    let mut samples = Vec::new();
    for sample in reader.samples::<i16>() {
        let sample = sample.map_err(|err| anyhow!("WAV read error: {err}"))?;
        samples.push(sample);
    }

    let samples = if spec.channels <= 1 {
        samples
    } else {
        crate::recorder::downmix_to_mono(&samples, spec.channels as usize)
    };

    if samples.is_empty() {
        return Err(anyhow!("No audio data decoded from WAV file"));
    }

    Ok((samples, spec.sample_rate))
}

struct LocalChunkingConfig<'a> {
    dictionary: &'a [String],
    language: Option<&'a str>,
    chunk_seconds: f32,
    overlap_seconds: f32,
    leading_pad_seconds: f32,
    cancel_token: Option<&'a CancellationToken>,
    strip_hallucinated_thank_you: bool,
}

fn transcribe_local_chunked(
    transcriber: &crate::local_transcription::LocalTranscriber,
    model: &model_manager::ReadyModel,
    samples: &[i16],
    sample_rate: u32,
    config: LocalChunkingConfig<'_>,
) -> Result<transcription_api::TranscriptionSuccess> {
    let LocalChunkingConfig {
        dictionary,
        language,
        chunk_seconds,
        overlap_seconds,
        leading_pad_seconds,
        cancel_token,
        strip_hallucinated_thank_you,
    } = config;

    if samples.is_empty() {
        return Err(anyhow!("No audio samples provided"));
    }

    let speech_percent =
        speech_percentage_i16_with_mode(samples, sample_rate, VadMode::VeryAggressive);
    if speech_percent < speech::VAD_MIN_SPEECH_PERCENT_FILE {
        return Ok(transcription_api::TranscriptionSuccess {
            transcript: String::new(),
            speech_model: None,
            segments: None,
            words: None,
        });
    }

    let pad_samples = ((sample_rate as f32) * leading_pad_seconds).round() as usize;
    let padded_storage: Vec<i16>;
    let samples: &[i16] = if pad_samples > 0 {
        let mut padded = Vec::with_capacity(pad_samples + samples.len());
        padded.resize(pad_samples, 0);
        padded.extend_from_slice(samples);
        padded_storage = padded;
        &padded_storage
    } else {
        samples
    };

    let chunk_samples = ((sample_rate.max(1) as f32) * chunk_seconds).round() as usize;
    let chunk_samples = chunk_samples.max(1);
    let overlap_samples = ((sample_rate.max(1) as f32) * overlap_seconds).round() as usize;
    let overlap_samples = overlap_samples.min(chunk_samples.saturating_sub(1));

    let mut full_text = String::new();
    let mut start = 0usize;
    let mut model_label = None;

    while start < samples.len() {
        if let Some(token) = cancel_token
            && token.is_cancelled()
        {
            return Err(anyhow!("Transcription cancelled"));
        }
        let nominal_end = (start + chunk_samples).min(samples.len());
        let end = if nominal_end == samples.len() {
            nominal_end
        } else {
            start + crate::recorder::quiet_cut_index(&samples[start..nominal_end], sample_rate)
        };
        let chunk = &samples[start..end];
        let chunk_speech_percent =
            speech_percentage_i16_with_mode(chunk, sample_rate, VadMode::VeryAggressive);
        let min_chunk_threshold = if end == samples.len() {
            speech::VAD_MIN_SPEECH_PERCENT_FILE
        } else {
            speech::VAD_MIN_SPEECH_PERCENT_CHUNK
        };
        if chunk_speech_percent >= min_chunk_threshold {
            let chunk_text = if strip_hallucinated_thank_you {
                let result = transcriber.transcribe_with_segments(
                    model,
                    chunk,
                    sample_rate,
                    dictionary,
                    language,
                )?;
                if model_label.is_none() {
                    model_label = result.speech_model.clone();
                }
                let regions = glimpse_speech::vad::speech_regions(chunk, sample_rate);
                transcription_api::keep_spoken_segments(
                    &result.transcript,
                    result.segments.as_deref(),
                    regions.as_deref(),
                )
            } else {
                let result =
                    transcriber.transcribe(model, chunk, sample_rate, dictionary, language)?;
                if model_label.is_none() {
                    model_label = result.speech_model.clone();
                }
                result.transcript
            };
            if !chunk_text.trim().is_empty() {
                let deduped = dedupe_overlap_text(&full_text, &chunk_text);
                if !deduped.trim().is_empty() {
                    append_deduped_chunk(&mut full_text, &deduped);
                }
            }
        }

        if end == samples.len() {
            break;
        }
        start = end
            .saturating_sub(overlap_samples)
            .max(start.saturating_add(1));
    }

    let transcript = full_text.trim().to_string();

    Ok(transcription_api::TranscriptionSuccess {
        transcript,
        speech_model: model_label,
        segments: None,
        words: None,
    })
}

const MIN_OVERLAP_TOKENS: usize = 3;
const MAX_OVERLAP_TOKENS: usize = 30;

#[derive(Debug, Clone)]
struct TokenOffset {
    norm: String,
    start: usize,
}

pub(crate) fn dedupe_overlap_text(existing: &str, next: &str) -> String {
    let existing_trim = existing.trim_end();
    let next_trim = next.trim();
    if existing_trim.is_empty() {
        return next_trim.to_string();
    }

    if let Some(drop_index) = find_overlap_drop_index(existing_trim, next) {
        if drop_index >= next.len() {
            return String::new();
        }
        return next[drop_index..].trim_start().to_string();
    }

    let existing_tail = last_chars(existing_trim, 120);
    if !existing_tail.is_empty() && next_trim.starts_with(&existing_tail) {
        return next_trim[existing_tail.len()..].trim_start().to_string();
    }

    next_trim.to_string()
}

pub(crate) fn append_deduped_chunk(existing: &mut String, next: &str) {
    let trimmed = next.trim();
    if trimmed.is_empty() {
        return;
    }

    if existing.is_empty() {
        existing.push_str(trimmed);
        return;
    }

    existing.push(' ');
    existing.push_str(trimmed);
}

fn maybe_warn_llm_unavailable(app: &AppHandle<AppRuntime>, is_edit_mode: bool) {
    maybe_warn_llm_issue(app, is_edit_mode, "Language model unreachable.");
}

/// Says what actually went wrong. A rate limit and a bad key are not the same
/// problem, and the user can only act on the difference if they are told it.
fn maybe_warn_llm_issue(app: &AppHandle<AppRuntime>, is_edit_mode: bool, reason: &str) {
    if !llm_cleanup::should_show_unavailable_notice() {
        return;
    }

    if is_edit_mode {
        toast::emit_toast(
            app,
            toast::Payload {
                toast_type: "error".to_string(),
                title: Some("Writing model".to_string()),
                message: format!("{reason} Your selected text was left alone."),
                auto_dismiss: Some(true),
                duration: Some(10_000),
                action: Some("open_llm_cleanup_settings".to_string()),
                action_label: Some("Open Settings".to_string()),
                ..Default::default()
            },
        );
    } else {
        toast::show_with_action(
            app,
            "warning",
            Some("Writing model"),
            &format!("{reason} Your words were left as dictated."),
            "open_llm_cleanup_settings",
            "Open Settings",
        );
    }
}

fn find_overlap_drop_index(existing: &str, next: &str) -> Option<usize> {
    let existing_tokens = tokenize_with_offsets(existing);
    let next_tokens = tokenize_with_offsets(next);
    if existing_tokens.is_empty() || next_tokens.is_empty() {
        return None;
    }

    let max_overlap = existing_tokens
        .len()
        .min(next_tokens.len())
        .min(MAX_OVERLAP_TOKENS);
    if max_overlap < MIN_OVERLAP_TOKENS {
        return None;
    }

    for overlap in (MIN_OVERLAP_TOKENS..=max_overlap).rev() {
        let start_existing = existing_tokens.len() - overlap;
        let mut matches = true;
        for idx in 0..overlap {
            if existing_tokens[start_existing + idx].norm != next_tokens[idx].norm {
                matches = false;
                break;
            }
        }
        if matches {
            if overlap >= next_tokens.len() {
                return Some(next.len());
            }
            return Some(next_tokens[overlap].start);
        }
    }

    None
}

fn tokenize_with_offsets(text: &str) -> Vec<TokenOffset> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut current_start = 0usize;
    let mut in_token = false;

    for (idx, ch) in text.char_indices() {
        if ch.is_alphanumeric() {
            if !in_token {
                in_token = true;
                current_start = idx;
                current.clear();
            }
            for lower in ch.to_lowercase() {
                current.push(lower);
            }
        } else if in_token {
            tokens.push(TokenOffset {
                norm: current.clone(),
                start: current_start,
            });
            in_token = false;
        }
    }

    if in_token {
        tokens.push(TokenOffset {
            norm: current,
            start: current_start,
        });
    }

    tokens
}

fn last_chars(value: &str, count: usize) -> String {
    let mut chars: Vec<char> = value.chars().collect();
    if chars.len() <= count {
        return value.to_string();
    }
    chars.drain(0..chars.len() - count);
    chars.into_iter().collect()
}

pub(crate) fn finalize_streaming_transcription(
    app: &AppHandle<AppRuntime>,
    input: StreamingTranscriptionInput,
) {
    let StreamingTranscriptionInput {
        raw_transcript,
        duration_seconds,
        audio_path,
        pending_path,
        settings,
        temporary,
        cancel_token,
    } = input;

    let state = app.state::<AppState>();
    let pending_selected_text = state.take_pending_selected_text();
    let http = state.http();
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        let transcription_started_at = Instant::now();
        let cancel_for_check = cancel_token.clone();
        let is_cancelled = move || cancel_for_check.is_cancelled();
        let auto_paste = transcription_api::auto_paste_enabled();
        let active_mode = mode_context::resolve_active_personality(&settings);
        let raw_transcript = transcription_api::normalize_transcript(&raw_transcript);

        if count_words(&raw_transcript) == 0 {
            crate::pill::collapse_expanded_pill(&app_handle);
            handle_empty_transcription(&app_handle, &audio_path, pending_path.as_deref());
            return;
        }

        if is_cancelled() {
            abort_transcription(&app_handle, pending_path.as_deref(), true);
            return;
        }

        let processed = match process_transcript_text(
            &app_handle,
            &http,
            ProcessTranscriptInput {
                raw_transcript: raw_transcript.clone(),
                pending_selected_text,
                settings: &settings,
                active_mode: active_mode.as_ref(),
                auto_paste,
                log_context: Some("streaming"),
                cancel_token: Some(&cancel_token),
                keep_pill_expanded: true,
                audio_duration_seconds: duration_seconds,
            },
        )
        .await
        {
            ProcessTranscriptOutcome::Ready(processed) => processed,
            ProcessTranscriptOutcome::Empty => {
                handle_empty_transcription(&app_handle, &audio_path, pending_path.as_deref());
                return;
            }
            ProcessTranscriptOutcome::Cancelled => {
                abort_transcription(&app_handle, pending_path.as_deref(), true);
                return;
            }
        };

        if is_cancelled() {
            abort_transcription(&app_handle, pending_path.as_deref(), true);
            return;
        }

        let metadata = storage::TranscriptionMetadata {
            speech_model: resolve_speech_model_label(&settings),
            llm_model: if processed.llm_cleaned {
                llm_cleanup::resolved_model_label(&settings)
            } else {
                None
            },
            word_count: count_words(&processed.final_transcript),
            audio_duration_seconds: duration_seconds,
            synced: false,
            mode_id: active_mode.as_ref().map(|m| m.id.clone()),
            mode_name: active_mode.as_ref().map(|m| m.name.clone()),
        };

        crate::pill::collapse_expanded_pill(&app_handle);
        emit_transcription_complete_with_cleanup(
            &app_handle,
            CompletionInput {
                raw_transcript,
                final_transcript: processed.final_transcript,
                auto_paste: processed.pasted,
                audio_path: audio_path.display().to_string(),
                pending_path,
                llm_cleaned: processed.llm_cleaned,
                metadata,
                mode: "local_streaming",
                transcription_duration_seconds: transcription_started_at.elapsed().as_secs_f32(),
                audio_source: "microphone",
                temporary,
                timestamp_override: None,
            },
        );
        app_handle.state::<AppState>().set_pending_path(None);
    });
}
