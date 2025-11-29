mod assistive;
mod audio;
mod downloader;
mod llm_cleanup;
mod local_transcription;
mod model_manager;
mod permissions;
mod recorder;
mod settings;
mod storage;
mod transcription;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use recorder::{CompletedRecording, RecorderManager, RecordingRejectionReason, RecordingSaved, validate_recording};
use reqwest::Client;
use serde::Serialize;
use settings::{default_local_model, LlmProvider, TranscriptionMode, UserSettings};
use tauri::async_runtime;
use tauri::Emitter;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{ActivationPolicy, AppHandle, Manager, WebviewWindow, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const MAIN_WINDOW_LABEL: &str = "main";
const SETTINGS_WINDOW_LABEL: &str = "settings";
const TOAST_WINDOW_LABEL: &str = "toast";
const EVENT_RECORDING_START: &str = "recording:start";
const EVENT_RECORDING_STOP: &str = "recording:stop";
const EVENT_RECORDING_COMPLETE: &str = "recording:complete";
const EVENT_RECORDING_ERROR: &str = "recording:error";
const EVENT_RECORDING_MODE_CHANGE: &str = "recording:mode_change";
const EVENT_TRANSCRIPTION_START: &str = "transcription:start";
const EVENT_TRANSCRIPTION_COMPLETE: &str = "transcription:complete";
const EVENT_TRANSCRIPTION_ERROR: &str = "transcription:error";
const EVENT_TOAST_SHOW: &str = "toast:show";
const EVENT_TOAST_HIDE: &str = "toast:hide";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok();
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_macos_permissions::init())
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Accessory);

            let handle = app.handle();
            let mut settings = UserSettings::load(&handle).unwrap_or_default();
            if model_manager::definition(&settings.local_model).is_none() {
                settings.local_model = default_local_model();
                if let Err(err) = settings.save(&handle) {
                    eprintln!("Failed to persist default local model: {err}");
                }
            }
            let needs_onboarding = !settings.onboarding_completed;
            app.manage(AppState::new(settings, &handle));

            if let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
                position_overlay(&window);
                let _ = window.hide();
                
                // When main window loses focus (cmd+tab), hide toast too
                let app_handle = handle.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        // Hide toast when pill loses focus
                        if let Some(toast) = app_handle.get_webview_window(TOAST_WINDOW_LABEL) {
                            let _ = toast.hide();
                        }
                    }
                });
            }

            // Toast window starts hidden - will be positioned when shown
            if let Some(toast_window) = handle.get_webview_window(TOAST_WINDOW_LABEL) {
                let _ = toast_window.hide();
                
                // When toast loses focus, hide both windows
                let app_handle = handle.clone();
                toast_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        // Hide both windows when toast loses focus
                        if let Some(main) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) {
                            let _ = main.hide();
                        }
                        if let Some(toast) = app_handle.get_webview_window(TOAST_WINDOW_LABEL) {
                            let _ = toast.hide();
                        }
                        // Also stop any active recording
                        stop_active_recording(&app_handle);
                    }
                });
            }

            if let Ok(tray) = build_tray(&handle) {
                handle.state::<AppState>().store_tray(tray);
            }

            if let Err(err) = register_shortcuts(&handle) {
                eprintln!("Failed to register shortcuts: {err}");
            }

            // Auto-open settings window if onboarding hasn't been completed
            if needs_onboarding {
                if let Err(err) = toggle_settings_window(&handle) {
                    eprintln!("Failed to auto-open settings for onboarding: {err}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            get_app_info,
            get_transcriptions,
            delete_transcription,
            retry_transcription,
            retry_llm_cleanup,
            model_manager::list_models,
            model_manager::check_model_status,
            model_manager::download_model,
            model_manager::delete_model,
            audio::list_input_devices,
            toast_dismissed,
            // Onboarding & permissions
            check_microphone_permission,
            request_microphone_permission,
            check_accessibility_permission,
            open_accessibility_settings,
            open_microphone_settings,
            complete_onboarding,
            reset_onboarding
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

type AppRuntime = Wry;

type GlimpseResult<T> = Result<T>;

struct AppState {
    recorder: RecorderManager,
    http: Client,
    local_transcriber: Arc<local_transcription::LocalTranscriber>,
    storage: Arc<storage::StorageManager>,
    settings: parking_lot::Mutex<UserSettings>,
    tray: parking_lot::Mutex<Option<TrayIcon<AppRuntime>>>,
    hold_shortcut_down: AtomicBool,
    toggle_recording_active: AtomicBool,
    /// Tracks which mode started the current recording: "hold" or "toggle"
    active_recording_mode: parking_lot::Mutex<Option<String>>,
}

impl AppState {
    fn new(settings: UserSettings, app_handle: &AppHandle<AppRuntime>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("Failed to build HTTP client");
        
        let storage_path = app_handle
            .path()
            .app_data_dir()
            .expect("Failed to resolve app data directory")
            .join("transcriptions.json");
        
        let storage = storage::StorageManager::new(storage_path)
            .expect("Failed to initialize transcription storage");
        
        Self {
            recorder: RecorderManager::new(),
            http,
            local_transcriber: Arc::new(local_transcription::LocalTranscriber::new()),
            storage: Arc::new(storage),
            settings: parking_lot::Mutex::new(settings),
            tray: parking_lot::Mutex::new(None),
            hold_shortcut_down: AtomicBool::new(false),
            toggle_recording_active: AtomicBool::new(false),
            active_recording_mode: parking_lot::Mutex::new(None),
        }
    }

    fn current_settings(&self) -> UserSettings {
        self.settings.lock().clone()
    }

    fn set_settings(&self, next: UserSettings) {
        *self.settings.lock() = next;
    }

    fn recorder(&self) -> &RecorderManager {
        &self.recorder
    }

    fn http(&self) -> Client {
        self.http.clone()
    }

    fn local_transcriber(&self) -> Arc<local_transcription::LocalTranscriber> {
        Arc::clone(&self.local_transcriber)
    }

    fn storage(&self) -> Arc<storage::StorageManager> {
        Arc::clone(&self.storage)
    }

    fn store_tray(&self, tray: TrayIcon<AppRuntime>) {
        *self.tray.lock() = Some(tray);
    }

    fn mark_hold_shortcut_down(&self) -> bool {
        self.hold_shortcut_down.swap(true, Ordering::SeqCst)
    }

    fn clear_hold_shortcut_state(&self) -> bool {
        self.hold_shortcut_down.swap(false, Ordering::SeqCst)
    }

    fn is_toggle_recording_active(&self) -> bool {
        self.toggle_recording_active.load(Ordering::SeqCst)
    }

    fn set_toggle_recording_active(&self, active: bool) {
        self.toggle_recording_active.store(active, Ordering::SeqCst);
    }

    fn set_active_recording_mode(&self, mode: Option<&str>) {
        *self.active_recording_mode.lock() = mode.map(String::from);
    }

    fn get_active_recording_mode(&self) -> Option<String> {
        self.active_recording_mode.lock().clone()
    }
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Result<UserSettings, String> {
    Ok(state.current_settings())
}

// --- Onboarding & Permission Commands ---

#[tauri::command]
fn check_microphone_permission() -> permissions::PermissionStatus {
    permissions::check_microphone_permission()
}

#[tauri::command]
fn request_microphone_permission() -> permissions::PermissionStatus {
    permissions::request_microphone_permission()
}

#[tauri::command]
fn check_accessibility_permission() -> bool {
    permissions::check_accessibility_permission()
}

#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    permissions::open_accessibility_settings()
}

#[tauri::command]
fn open_microphone_settings() -> Result<(), String> {
    permissions::open_microphone_settings()
}

#[tauri::command]
fn complete_onboarding(
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut settings = state.current_settings();
    settings.onboarding_completed = true;
    settings.save(&app).map_err(|err| err.to_string())?;
    state.set_settings(settings);
    Ok(())
}

#[tauri::command]
fn reset_onboarding(
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut settings = state.current_settings();
    settings.onboarding_completed = false;
    settings.save(&app).map_err(|err| err.to_string())?;
    state.set_settings(settings);
    Ok(())
}

// --- End Onboarding Commands ---

#[tauri::command]
fn update_settings(
    holdShortcut: String,
    holdEnabled: bool,
    toggleShortcut: String,
    toggleEnabled: bool,
    transcriptionMode: TranscriptionMode,
    localModel: String,
    microphoneDevice: Option<String>,
    language: String,
    llmCleanupEnabled: bool,
    llmProvider: LlmProvider,
    llmEndpoint: String,
    llmApiKey: String,
    llmModel: String,
    userContext: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<UserSettings, String> {
    if holdEnabled && holdShortcut.trim().is_empty() {
        return Err("Hold shortcut cannot be empty when enabled".into());
    }

    if toggleEnabled && toggleShortcut.trim().is_empty() {
        return Err("Toggle shortcut cannot be empty when enabled".into());
    }

    if !holdEnabled && !toggleEnabled {
        return Err("At least one recording mode must be enabled".into());
    }

    // Prevent same keybind for both shortcuts
    if holdEnabled && toggleEnabled {
        let hold_normalized = holdShortcut.trim().to_lowercase();
        let toggle_normalized = toggleShortcut.trim().to_lowercase();
        if hold_normalized == toggle_normalized {
            return Err("Hold and Toggle shortcuts cannot be the same".into());
        }
    }

    if model_manager::definition(&localModel).is_none() {
        return Err("Unknown model selection".into());
    }

    // Validate LLM settings if enabled
    if llmCleanupEnabled && !matches!(llmProvider, LlmProvider::None) {
        if matches!(llmProvider, LlmProvider::Custom) && llmEndpoint.trim().is_empty() {
            return Err("Custom LLM endpoint cannot be empty".into());
        }
        if matches!(llmProvider, LlmProvider::OpenAI) && llmApiKey.trim().is_empty() {
            return Err("OpenAI API key is required".into());
        }
    }

    let mut next = state.current_settings();
    next.hold_shortcut = holdShortcut;
    next.hold_enabled = holdEnabled;
    next.toggle_shortcut = toggleShortcut;
    next.toggle_enabled = toggleEnabled;
    next.transcription_mode = transcriptionMode;
    next.local_model = localModel;
    next.microphone_device = microphoneDevice;
    next.language = language;
    next.llm_cleanup_enabled = llmCleanupEnabled;
    next.llm_provider = llmProvider;
    next.llm_endpoint = llmEndpoint;
    next.llm_api_key = llmApiKey;
    next.llm_model = llmModel;
    next.user_context = userContext;

    next.save(&app).map_err(|err| err.to_string())?;
    state.set_settings(next.clone());

    register_shortcuts(&app).map_err(|err| err.to_string())?;

    Ok(next)
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    data_dir_size_bytes: u64,
    data_dir_path: String,
}

#[tauri::command]
fn get_app_info(app: AppHandle<AppRuntime>) -> Result<AppInfo, String> {
    let version = env!("CARGO_PKG_VERSION").to_string();
    
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    
    let data_dir_path = data_dir.display().to_string();
    
    // Calculate directory size
    let data_dir_size_bytes = calculate_dir_size(&data_dir).unwrap_or(0);
    
    Ok(AppInfo {
        version,
        data_dir_size_bytes,
        data_dir_path,
    })
}

fn calculate_dir_size(path: &std::path::Path) -> Result<u64> {
    let mut total_size = 0u64;
    
    if !path.exists() {
        return Ok(0);
    }
    
    if path.is_file() {
        return Ok(path.metadata()?.len());
    }
    
    if path.is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            
            if metadata.is_file() {
                total_size += metadata.len();
            } else if metadata.is_dir() {
                total_size += calculate_dir_size(&entry.path())?;
            }
        }
    }
    
    Ok(total_size)
}


#[tauri::command]
fn get_transcriptions(state: tauri::State<AppState>) -> Result<Vec<storage::TranscriptionRecord>, String> {
    Ok(state.storage().get_all())
}

#[tauri::command]
fn delete_transcription(id: String, state: tauri::State<AppState>) -> Result<bool, String> {
    match state.storage().delete(&id) {
        Ok(Some(audio_path)) => {
            // Also delete the audio file
            let path = PathBuf::from(audio_path);
            if path.exists() {
                let _ = std::fs::remove_file(path);
            }
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(err) => Err(format!("Failed to delete transcription: {err}")),
    }
}

#[tauri::command]
async fn retry_transcription(
    id: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let record = state
        .storage()
        .get_by_id(&id)
        .ok_or_else(|| "Transcription not found".to_string())?;

    if record.status != storage::TranscriptionStatus::Error {
        return Err("Can only retry failed transcriptions".to_string());
    }

    let audio_path = PathBuf::from(&record.audio_path);
    if !audio_path.exists() {
        return Err("Audio file not found".to_string());
    }

    // Create a RecordingSaved struct from the record
    let saved = RecordingSaved {
        path: audio_path,
        started_at: record.timestamp,
        ended_at: record.timestamp,
    };

    // Delete the old failed record
    let _ = state.storage().delete(&id);

    // Queue transcription with current settings
    emit_transcription_start(&app, &saved);

    let http = state.http();
    let app_handle = app.clone();
    let saved_for_task = saved.clone();

    async_runtime::spawn(async move {
        let settings = app_handle.state::<AppState>().current_settings();
        let config = transcription::TranscriptionConfig::from_settings(&settings);
        let use_local = matches!(settings.transcription_mode, TranscriptionMode::Local);

        let result = if use_local {
            // For local transcription, we need to load the audio file
            match load_audio_for_transcription(&saved_for_task.path) {
                Ok((samples, sample_rate)) => {
                    let model_key = settings.local_model.clone();
                    match model_manager::ensure_model_ready(&app_handle, &model_key) {
                        Ok(ready_model) => {
                            let transcriber = app_handle.state::<AppState>().local_transcriber();
                            match async_runtime::spawn_blocking(move || {
                                transcriber.transcribe(&ready_model, &samples, sample_rate)
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
            transcription::request_transcription(&http, &saved_for_task, &config).await
        };

        match result {
            Ok(result) => {
                let raw_transcript = result.transcript.clone();
                let confidence = result.confidence;
                
                // Apply LLM cleanup if enabled (same as normal transcription flow)
                let (final_transcript, llm_cleaned) = if llm_cleanup::is_cleanup_available(&settings) {
                    match llm_cleanup::cleanup_transcription(&http, &raw_transcript, &settings).await {
                        Ok(cleaned) => (cleaned, true),
                        Err(err) => {
                            eprintln!("LLM cleanup failed during retry, using raw transcript: {err}");
                            (raw_transcript.clone(), false)
                        }
                    }
                } else {
                    (raw_transcript.clone(), false)
                };

                let mut pasted = false;
                if config.auto_paste && !final_transcript.trim().is_empty() {
                    let text = final_transcript.clone();
                    match async_runtime::spawn_blocking(move || assistive::paste_text(&text)).await
                    {
                        Ok(Ok(())) => pasted = true,
                        Ok(Err(err)) => {
                            emit_transcription_error(
                                &app_handle,
                                format!("Auto paste failed: {err}"),
                                "auto_paste",
                                saved_for_task.path.display().to_string(),
                            );
                        }
                        Err(err) => {
                            emit_transcription_error(
                                &app_handle,
                                format!("Auto paste task error: {err}"),
                                "auto_paste",
                                saved_for_task.path.display().to_string(),
                            );
                        }
                    }
                }

                emit_transcription_complete_with_cleanup(
                    &app_handle,
                    raw_transcript,
                    final_transcript,
                    confidence,
                    pasted,
                    saved_for_task.path.display().to_string(),
                    llm_cleaned,
                );

                hide_overlay(&app_handle);
            }
            Err(err) => {
                let stage = if use_local { "local" } else { "api" };
                emit_transcription_error(
                    &app_handle,
                    format!("Transcription failed: {err}"),
                    stage,
                    saved_for_task.path.display().to_string(),
                );
                // Don't auto-hide - overlay stays visible until toast is dismissed
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn retry_llm_cleanup(
    id: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let record = state
        .storage()
        .get_by_id(&id)
        .ok_or_else(|| "Transcription not found".to_string())?;

    if record.status != storage::TranscriptionStatus::Success {
        return Err("Can only apply LLM cleanup to successful transcriptions".to_string());
    }

    let settings = state.current_settings();
    if !llm_cleanup::is_cleanup_available(&settings) {
        return Err("LLM cleanup is not configured".to_string());
    }

    // Use raw text if available, otherwise use current text
    let text_to_clean = record.raw_text.unwrap_or(record.text);
    
    let http = state.http();
    let storage = state.storage();
    let record_id = id.clone();

    async_runtime::spawn(async move {
        match llm_cleanup::cleanup_transcription(&http, &text_to_clean, &settings).await {
            Ok(cleaned) => {
                if let Err(err) = storage.update_with_llm_cleanup(&record_id, cleaned) {
                    eprintln!("Failed to save LLM cleanup: {err}");
                }
                // Emit event to refresh UI
                let _ = app.emit(EVENT_TRANSCRIPTION_COMPLETE, TranscriptionCompletePayload {
                    transcript: String::new(),
                    confidence: None,
                    auto_paste: false,
                });
            }
            Err(err) => {
                eprintln!("LLM cleanup failed: {err}");
                let _ = app.emit(EVENT_TRANSCRIPTION_ERROR, TranscriptionErrorPayload {
                    message: format!("LLM cleanup failed: {err}"),
                    stage: "llm_cleanup".to_string(),
                });
            }
        }
    });

    Ok(())
}

fn register_shortcuts(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    let settings = app.state::<AppState>().current_settings();
    let manager = app.global_shortcut();

    if let Err(err) = manager.unregister_all() {
        eprintln!("Failed to clear shortcuts: {err}");
    }

    // Check if shortcuts overlap (one is a subset of the other)
    let hold_keys: std::collections::HashSet<&str> = settings.hold_shortcut.split('+').map(|s| s.trim()).collect();
    let toggle_keys: std::collections::HashSet<&str> = settings.toggle_shortcut.split('+').map(|s| s.trim()).collect();
    let hold_is_subset_of_toggle = settings.hold_enabled && settings.toggle_enabled && hold_keys.is_subset(&toggle_keys);
    let _toggle_is_subset_of_hold = settings.hold_enabled && settings.toggle_enabled && toggle_keys.is_subset(&hold_keys);

    // Register hold-to-record shortcut if enabled
    if settings.hold_enabled {
        let hold_shortcut = settings.hold_shortcut.clone();
        let check_toggle_overlap = hold_is_subset_of_toggle;
        let toggle_shortcut_clone = settings.toggle_shortcut.clone();
        manager.on_shortcut(hold_shortcut.as_str(), move |app, shortcut, event| {
            // If hold shortcut is a subset of toggle, check if toggle keys are also pressed
            // In that case, ignore this event and let the toggle handler deal with it
            if check_toggle_overlap {
                // The shortcut system should handle this, but we add extra safety
                let pressed_shortcut = shortcut.to_string();
                if pressed_shortcut.to_lowercase() == toggle_shortcut_clone.to_lowercase() {
                    return;
                }
            }
            
            if event.state == ShortcutState::Pressed {
                if let Err(err) = handle_hold_shortcut_press(app) {
                    eprintln!("Hold shortcut press error: {err}");
                }
            } else if event.state == ShortcutState::Released {
                if let Err(err) = handle_hold_shortcut_release(app) {
                    eprintln!("Hold shortcut release error: {err}");
                }
            }
        })?;
    }

    // Register toggle-to-record shortcut if enabled
    if settings.toggle_enabled {
        let toggle_shortcut = settings.toggle_shortcut.clone();
        manager.on_shortcut(toggle_shortcut.as_str(), move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Err(err) = handle_toggle_shortcut_press(app) {
                    eprintln!("Toggle shortcut press error: {err}");
                }
            }
            // Toggle mode doesn't use release event
        })?;
    }

    Ok(())
}

fn handle_hold_shortcut_press(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    let state = app.state::<AppState>();
    
    // If any recording is already active, ignore
    if state.is_toggle_recording_active() || state.get_active_recording_mode().is_some() {
        return Ok(());
    }
    
    // Prevent duplicate press events
    if state.mark_hold_shortcut_down() {
        return Ok(());
    }

    let settings = state.current_settings();
    match state.recorder().start(settings.microphone_device) {
        Ok(started) => {
            state.set_active_recording_mode(Some("hold"));
            show_overlay(app);
            emit_event(app, EVENT_RECORDING_MODE_CHANGE, RecordingModePayload {
                mode: "hold".to_string(),
            });
            emit_event(app, EVENT_RECORDING_START, RecordingStartPayload {
                started_at: started.to_rfc3339(),
            });
        }
        Err(err) => {
            state.clear_hold_shortcut_state();
            emit_error(app, format!("Unable to start recording: {err}"));
        }
    }

    Ok(())
}

/// Minimum recording duration in milliseconds to process (prevents accidental taps)
const MIN_RECORDING_DURATION_MS: i64 = 300;

fn handle_hold_shortcut_release(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    let state = app.state::<AppState>();
    if !state.clear_hold_shortcut_state() {
        return Ok(());
    }

    // Only stop if we're in hold mode
    if state.get_active_recording_mode().as_deref() != Some("hold") {
        return Ok(());
    }

    match state.recorder().stop() {
        Ok(Some(recording)) => {
            let duration_ms = (recording.ended_at - recording.started_at).num_milliseconds();
            
            // If recording is too short, discard it and hide overlay immediately
            if duration_ms < MIN_RECORDING_DURATION_MS {
                state.set_active_recording_mode(None);
                hide_overlay(app);
                return Ok(());
            }
            
            state.set_active_recording_mode(None);
            // Don't hide overlay yet - it should remain visible during saving/transcription
            emit_event(app, EVENT_RECORDING_STOP, RecordingStopPayload {
                ended_at: recording.ended_at.to_rfc3339(),
            });
            persist_recording_async(app.clone(), recording);
        }
        Ok(None) => {
            state.set_active_recording_mode(None);
            hide_overlay(app);
        }
        Err(err) => emit_error(app, format!("Unable to stop recording: {err}")),
    }

    Ok(())
}

fn handle_toggle_shortcut_press(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    let state = app.state::<AppState>();
    
    // If hold recording is active, ignore toggle shortcut
    if state.get_active_recording_mode().as_deref() == Some("hold") {
        return Ok(());
    }
    
    if state.is_toggle_recording_active() {
        // Stop toggle recording
        state.set_toggle_recording_active(false);
        
        match state.recorder().stop() {
            Ok(Some(recording)) => {
                let duration_ms = (recording.ended_at - recording.started_at).num_milliseconds();
                
                // If recording is too short, discard it and hide overlay immediately
                if duration_ms < MIN_RECORDING_DURATION_MS {
                    state.set_active_recording_mode(None);
                    hide_overlay(app);
                    return Ok(());
                }
                
                state.set_active_recording_mode(None);
                // Don't hide overlay yet - it should remain visible during saving/transcription
                emit_event(app, EVENT_RECORDING_STOP, RecordingStopPayload {
                    ended_at: recording.ended_at.to_rfc3339(),
                });
                persist_recording_async(app.clone(), recording);
            }
            Ok(None) => {
                state.set_active_recording_mode(None);
                hide_overlay(app);
            }
            Err(err) => {
                state.set_active_recording_mode(None);
                emit_error(app, format!("Unable to stop recording: {err}"));
            }
        }
    } else {
        // Start toggle recording
        let settings = state.current_settings();
        match state.recorder().start(settings.microphone_device) {
            Ok(started) => {
                state.set_toggle_recording_active(true);
                state.set_active_recording_mode(Some("toggle"));
                show_overlay(app);
                emit_event(app, EVENT_RECORDING_MODE_CHANGE, RecordingModePayload {
                    mode: "toggle".to_string(),
                });
                emit_event(app, EVENT_RECORDING_START, RecordingStartPayload {
                    started_at: started.to_rfc3339(),
                });
            }
            Err(err) => {
                emit_error(app, format!("Unable to start recording: {err}"));
            }
        }
    }

    Ok(())
}

fn show_overlay(app: &AppHandle<AppRuntime>) {
    // Hide toast if visible (user pressed keybind to start new recording)
    if let Some(toast) = app.get_webview_window(TOAST_WINDOW_LABEL) {
        let _ = toast.hide();
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
    }
}

fn hide_overlay(app: &AppHandle<AppRuntime>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

fn stop_active_recording(app: &AppHandle<AppRuntime>) {
    let state = app.state::<AppState>();
    if let Err(err) = state.recorder().stop() {
        eprintln!("Failed to stop recorder: {err}");
    }
    state.set_active_recording_mode(None);
    state.set_toggle_recording_active(false);
    state.clear_hold_shortcut_state();
}

#[tauri::command]
fn toast_dismissed(app: AppHandle<AppRuntime>) {
    // Stop any active recording (releases mic)
    stop_active_recording(&app);
    // Hide the pill overlay
    hide_overlay(&app);
    // Hide the toast window
    if let Some(toast_window) = app.get_webview_window(TOAST_WINDOW_LABEL) {
        let _ = toast_window.hide();
    }
}

fn emit_toast(app: &AppHandle<AppRuntime>, payload: ToastPayload) {
    if let Some(toast_window) = app.get_webview_window(TOAST_WINDOW_LABEL) {
        position_toast_window(app, &toast_window);
        let _ = toast_window.show();
    }

    emit_event(app, EVENT_TOAST_SHOW, payload);
}

fn show_toast(app: &AppHandle<AppRuntime>, toast_type: &str, title: Option<&str>, message: &str) {
    emit_toast(
        app,
        ToastPayload {
            toast_type: toast_type.to_string(),
            title: title.map(String::from),
            message: message.to_string(),
            auto_dismiss: None,
            duration: None,
            retry_id: None,
            mode: None,
        },
    );
}

fn show_toast_with_options(
    app: &AppHandle<AppRuntime>,
    toast_type: &str,
    title: Option<&str>,
    message: &str,
    auto_dismiss: Option<bool>,
    duration: Option<u64>,
) {
    emit_toast(
        app,
        ToastPayload {
            toast_type: toast_type.to_string(),
            title: title.map(String::from),
            message: message.to_string(),
            auto_dismiss,
            duration,
            retry_id: None,
            mode: None,
        },
    );
}

fn hide_toast(app: &AppHandle<AppRuntime>) {
    emit_event(app, EVENT_TOAST_HIDE, ());
}

fn position_toast_window(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) {
    // Toast window is same width as pill (185px), so same X position
    if let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Ok(main_pos) = main_window.outer_position() {
            let x = main_pos.x; // Same X - both windows are 185px wide
            let y = main_pos.y - 168; // 100px toast height + 8px gap
            let _ = toast_window.set_position(tauri::PhysicalPosition::new(x, y));
            return;
        }
    }

    // Fallback: center on screen at ~88% height
    if let Ok(Some(monitor)) = toast_window.current_monitor() {
        let screen = monitor.size();
        let x = (screen.width as i32 - 185) / 2;
        let y = ((screen.height as f64 * 0.88) as i32) - 108;
        let _ = toast_window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

fn persist_recording_async(app: AppHandle<AppRuntime>, recording: CompletedRecording) {
    let base_dir = match recordings_root(&app) {
        Ok(path) => path,
        Err(err) => {
            emit_error(&app, format!("Failed to resolve Desktop folder: {err}"));
            return;
        }
    };

    let recording_for_transcription = recording.clone();

    async_runtime::spawn(async move {
        let task = async_runtime::spawn_blocking(move || recorder::persist_recording(base_dir, recording));
        match task.await {
            Ok(Ok(saved)) => emit_complete(&app, saved, recording_for_transcription),
            Ok(Err(err)) => emit_error(&app, format!("Unable to save recording: {err}")),
            Err(err) => emit_error(&app, format!("Recording task failed: {err}")),
        }
    });
}

fn emit_complete(app: &AppHandle<AppRuntime>, saved: RecordingSaved, recording: CompletedRecording) {
    emit_event(app, EVENT_RECORDING_COMPLETE, RecordingCompletePayload {
        path: saved.path.display().to_string(),
        started_at: saved.started_at.to_rfc3339(),
        ended_at: saved.ended_at.to_rfc3339(),
        duration_ms: (saved.ended_at - saved.started_at).num_milliseconds(),
    });

    // Validate recording before transcription to avoid wasting API calls on empty/silent recordings
    if let Err(rejection) = validate_recording(&recording) {
        let reason = match rejection {
            RecordingRejectionReason::TooShort { duration_ms, min_ms } => {
                format!("Recording too short ({duration_ms}ms < {min_ms}ms minimum)")
            }
            RecordingRejectionReason::TooQuiet { rms, threshold } => {
                format!("Recording too quiet (energy {rms:.4} < {threshold} threshold)")
            }
            RecordingRejectionReason::NoSpeechDetected => {
                "No speech detected in recording".to_string()
            }
            RecordingRejectionReason::EmptyBuffer => {
                "Recording buffer is empty".to_string()
            }
        };
        eprintln!("Recording rejected: {reason}");
        
        // Clean up the audio file since we won't transcribe it
        if let Err(err) = std::fs::remove_file(&saved.path) {
            eprintln!("Failed to remove rejected recording file: {err}");
        }
        
        // Hide the overlay and show a brief toast (optional - can be silent rejection)
        hide_overlay(app);
        return;
    }

    queue_transcription(app, saved, recording);
}

fn emit_error(app: &AppHandle<AppRuntime>, message: String) {
    emit_event(app, EVENT_RECORDING_ERROR, RecordingErrorPayload { message: message.clone() });
    stop_active_recording(app);
    // Show simplified error toast
    let toast_message = simplify_recording_error(&message);
    show_toast(app, "error", None, &toast_message);
}

fn emit_event<T: Serialize + Clone>(app: &AppHandle<AppRuntime>, event: &str, payload: T) {
    if let Err(err) = app.emit(event, payload) {
        eprintln!("Failed to emit {event}: {err}");
    }
}

fn queue_transcription(app: &AppHandle<AppRuntime>, saved: RecordingSaved, recording: CompletedRecording) {
    emit_transcription_start(app, &saved);

    let http = app.state::<AppState>().http();
    let app_handle = app.clone();
    let saved_for_task = saved.clone();
    let recording_for_task = recording.clone();

    async_runtime::spawn(async move {
        let settings = app_handle.state::<AppState>().current_settings();
        let config = transcription::TranscriptionConfig::from_settings(&settings);
        let use_local = matches!(settings.transcription_mode, TranscriptionMode::Local);
        let result = if use_local {
            let model_key = settings.local_model.clone();
            match model_manager::ensure_model_ready(&app_handle, &model_key) {
                Ok(ready_model) => {
                    let transcriber = app_handle.state::<AppState>().local_transcriber();
                    let local_recording = recording_for_task.clone();
                    match async_runtime::spawn_blocking(move || {
                        transcriber.transcribe(
                            &ready_model,
                            &local_recording.samples,
                            local_recording.sample_rate,
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
            transcription::request_transcription(&http, &saved_for_task, &config).await
        };

        match result {
            Ok(result) => {
                let raw_transcript = result.transcript.clone();
                let confidence = result.confidence;
                
                // Apply LLM cleanup if enabled
                let (final_transcript, llm_cleaned) = if llm_cleanup::is_cleanup_available(&settings) {
                    match llm_cleanup::cleanup_transcription(&http, &raw_transcript, &settings).await {
                        Ok(cleaned) => (cleaned, true),
                        Err(err) => {
                            eprintln!("LLM cleanup failed, using raw transcript: {err}");
                            (raw_transcript.clone(), false)
                        }
                    }
                } else {
                    (raw_transcript.clone(), false)
                };

                let mut pasted = false;
                if config.auto_paste && !final_transcript.trim().is_empty() {
                    let text = final_transcript.clone();
                    match async_runtime::spawn_blocking(move || assistive::paste_text(&text)).await {
                        Ok(Ok(())) => pasted = true,
                        Ok(Err(err)) => {
                            emit_transcription_error(&app_handle, format!("Auto paste failed: {err}"), "auto_paste", saved_for_task.path.display().to_string());
                        }
                        Err(err) => {
                            emit_transcription_error(&app_handle, format!("Auto paste task error: {err}"), "auto_paste", saved_for_task.path.display().to_string());
                        }
                    }
                }

                emit_transcription_complete_with_cleanup(
                    &app_handle,
                    raw_transcript,
                    final_transcript,
                    confidence,
                    pasted,
                    saved_for_task.path.display().to_string(),
                    llm_cleaned,
                );
                
                // Hide overlay immediately on success
                hide_overlay(&app_handle);
            }
            Err(err) => {
                let stage = if use_local { "local" } else { "api" };
                emit_transcription_error(
                    &app_handle,
                    format!("Transcription failed: {err}"),
                    stage,
                    saved_for_task.path.display().to_string(),
                );
                // Don't auto-hide - overlay stays visible until toast is dismissed
            }
        }
    });
}

fn emit_transcription_start(app: &AppHandle<AppRuntime>, saved: &RecordingSaved) {
    emit_event(
        app,
        EVENT_TRANSCRIPTION_START,
        TranscriptionStartPayload {
            path: saved.path.display().to_string(),
        },
    );
}

fn emit_transcription_complete(
    app: &AppHandle<AppRuntime>,
    transcript: String,
    confidence: Option<f32>,
    auto_paste: bool,
    audio_path: String,
) {
    emit_event(
        app,
        EVENT_TRANSCRIPTION_COMPLETE,
        TranscriptionCompletePayload {
            transcript: transcript.clone(),
            confidence,
            auto_paste,
        },
    );
    
    // Save successful transcription to storage with the provided audio path
    let _ = app.state::<AppState>().storage().save_transcription(
        transcript,
        audio_path,
        storage::TranscriptionStatus::Success,
        None,
        confidence,
    );
}

fn emit_transcription_complete_with_cleanup(
    app: &AppHandle<AppRuntime>,
    raw_transcript: String,
    final_transcript: String,
    confidence: Option<f32>,
    auto_paste: bool,
    audio_path: String,
    llm_cleaned: bool,
) {
    emit_event(
        app,
        EVENT_TRANSCRIPTION_COMPLETE,
        TranscriptionCompletePayload {
            transcript: final_transcript.clone(),
            confidence,
            auto_paste,
        },
    );
    
    // Save transcription to storage with cleanup info
    if llm_cleaned {
        let _ = app.state::<AppState>().storage().save_transcription_with_cleanup(
            raw_transcript,
            final_transcript,
            audio_path,
            confidence,
        );
    } else {
        let _ = app.state::<AppState>().storage().save_transcription(
            final_transcript,
            audio_path,
            storage::TranscriptionStatus::Success,
            None,
            confidence,
        );
    }
}

fn emit_transcription_error(app: &AppHandle<AppRuntime>, message: String, stage: &str, audio_path: String) {
    emit_event(
        app,
        EVENT_TRANSCRIPTION_ERROR,
        TranscriptionErrorPayload {
            message: message.clone(),
            stage: stage.to_string(),
        },
    );
    
    stop_active_recording(app);
    
    // Get mode for context-aware message
    let settings = app.state::<AppState>().current_settings();
    let is_local = matches!(settings.transcription_mode, TranscriptionMode::Local);
    
    // Create user-friendly toast message
    let toast_message = format_transcription_error(&message, is_local);
    
    // Save failed transcription to storage with the clean error message
    let record_result = app.state::<AppState>().storage().save_transcription(
        String::new(),
        audio_path.clone(),
        storage::TranscriptionStatus::Error,
        Some(toast_message.clone()),
        None,
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
    
    emit_toast(
        app,
        ToastPayload {
            toast_type: "error".to_string(),
            title: None,
            message: toast_message,
            auto_dismiss: None,
            duration: None,
            retry_id,
            mode: Some(if is_local { "local".into() } else { "cloud".into() }),
        },
    );
}


/// Creates user-friendly error message based on transcription mode
fn format_transcription_error(message: &str, is_local: bool) -> String {
    let msg_lower = message.to_lowercase();
    
    if is_local {
        // Local mode errors - tell user what to fix
        if msg_lower.contains("not fully installed") || msg_lower.contains("missing:") {
            return "No transcription model installed".to_string();
        }
        if msg_lower.contains("model not found") || msg_lower.contains("no model") {
            return "No transcription model selected".to_string();
        }
    } else {
        // Cloud mode errors
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
    
    // Generic errors
    if msg_lower.contains("microphone") || msg_lower.contains("audio input") {
        return "Microphone error".to_string();
    }
    if msg_lower.contains("permission") {
        return "Permission denied".to_string();
    }
    if msg_lower.contains("auto paste") {
        return "Pasted to clipboard instead".to_string();
    }
    
    // Default
    if is_local {
        "Transcription failed".to_string()
    } else {
        "Transcription failed".to_string()
    }
}

/// Simplifies recording error messages
fn simplify_recording_error(message: &str) -> String {
    let msg_lower = message.to_lowercase();
    
    if msg_lower.contains("microphone") || msg_lower.contains("audio") {
        return "Microphone unavailable".to_string();
    }
    if msg_lower.contains("permission") {
        return "Microphone permission needed".to_string();
    }
    
    if message.len() <= 30 {
        return message.to_string();
    }
    
    "Recording failed".to_string()
}

fn load_audio_for_transcription(path: &PathBuf) -> Result<(Vec<i16>, u32)> {
    use std::io::Read;
    use minimp3::{Decoder, Frame};
    
    // Read the MP3 file
    let mut file = std::fs::File::open(path)
        .with_context(|| format!("Failed to open audio file at {}", path.display()))?;
    let mut mp3_data = Vec::new();
    file.read_to_end(&mut mp3_data)
        .context("Failed to read MP3 file")?;

    // Decode MP3 to raw samples
    let mut decoder = Decoder::new(&mp3_data[..]);
    let mut samples = Vec::new();
    let mut sample_rate = 16000; // Default, will be updated from first frame
    
    loop {
        match decoder.next_frame() {
            Ok(Frame { data, sample_rate: sr, channels, .. }) => {
                sample_rate = sr as u32;
                
                // Convert to mono if needed and collect samples
                if channels == 1 {
                    samples.extend_from_slice(&data);
                } else {
                    // Downmix stereo/multi-channel to mono
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

fn recordings_root(app: &AppHandle<AppRuntime>) -> GlimpseResult<PathBuf> {
    let mut desktop = app
        .path()
        .desktop_dir()
        .context("Desktop directory not found")?;
    desktop.push("Glimpse");
    Ok(desktop)
}

fn build_tray(app: &AppHandle<AppRuntime>) -> tauri::Result<TrayIcon<AppRuntime>> {
    let open_settings = MenuItem::with_id(app, "open_settings", "Open Glimpse", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit_glimpse", "Quit Glimpse", true, None::<&str>)?;

    let menu = MenuBuilder::new(app)
        .item(&open_settings)
        .item(&quit)
        .build()?;

    let icon_bytes = include_bytes!("../icons/32x32.png");
    let icon = tauri::image::Image::from_bytes(icon_bytes)?.to_owned();

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click { button, button_state, .. }
                if button == MouseButton::Left && button_state == MouseButtonState::Up =>
            {
                if let Err(err) = toggle_settings_window(tray.app_handle()) {
                    eprintln!("Failed to toggle settings window: {err}");
                }
            }
            _ => {}
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_settings" => {
                if let Err(err) = toggle_settings_window(app) {
                    eprintln!("Failed to open settings window: {err}");
                }
            }
            "quit_glimpse" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)
}

fn toggle_settings_window(app: &AppHandle<AppRuntime>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        // Show app in dock when settings window is open
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
        
        window.show()?;
        window.set_focus()?;
        
        // Listen for window close to hide from dock again
        let app_handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Hide from dock when settings is closed
                let _ = app_handle.set_activation_policy(ActivationPolicy::Accessory);
            }
        });
        
        Ok(())
    } else {
        Err(anyhow!("Settings window is not available")).map_err(Into::into)
    }
}

fn position_overlay(window: &WebviewWindow<AppRuntime>) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        if let Ok(size) = window.outer_size() {
            let screen = monitor.size();
            let x = (screen.width.saturating_sub(size.width) / 2) as i32;
            let y = ((screen.height as f64) * 0.88) as i32;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
}

#[derive(Serialize, Clone)]
struct RecordingModePayload {
    mode: String,
}

#[derive(Serialize, Clone)]
struct RecordingStartPayload {
    started_at: String,
}

#[derive(Serialize, Clone)]
struct RecordingStopPayload {
    ended_at: String,
}

#[derive(Serialize, Clone)]
struct RecordingCompletePayload {
    path: String,
    started_at: String,
    ended_at: String,
    duration_ms: i64,
}

#[derive(Serialize, Clone)]
struct RecordingErrorPayload {
    message: String,
}

#[derive(Serialize, Clone)]
struct TranscriptionStartPayload {
    path: String,
}

#[derive(Serialize, Clone)]
struct TranscriptionCompletePayload {
    transcript: String,
    confidence: Option<f32>,
    auto_paste: bool,
}

#[derive(Serialize, Clone)]
struct TranscriptionErrorPayload {
    message: String,
    stage: String,
}

#[derive(Serialize, Clone)]
struct ToastPayload {
    #[serde(rename = "type")]
    toast_type: String,
    title: Option<String>,
    message: String,
    #[serde(rename = "autoDismiss")]
    auto_dismiss: Option<bool>,
    duration: Option<u64>,
    #[serde(rename = "retryId")]
    retry_id: Option<String>,
    #[serde(rename = "mode")]
    mode: Option<String>,
}
