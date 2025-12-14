mod analytics;
mod assistive;
mod audio;
mod crypto;
mod downloader;
mod llm_cleanup;
mod local_transcription;
mod model_manager;
mod permissions;
mod platform;
mod recorder;
mod settings;
mod shortcuts;
mod storage;
mod toast;
mod transcription;
mod tray;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use recorder::{
    validate_recording, CompletedRecording, RecorderManager, RecordingRejectionReason,
    RecordingSaved,
};
use reqwest::Client;
use serde::Serialize;
use settings::{
    default_local_model, LlmProvider, Replacement, SettingsStore, TranscriptionMode, UserSettings,
};
use tauri::async_runtime;
use tauri::tray::TrayIcon;
use tauri::Emitter;
use tauri::{AppHandle, Manager, WebviewWindow, Wry};

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri_plugin_aptabase::EventTracker;
use tauri_plugin_opener::OpenerExt;

pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
pub(crate) const SETTINGS_WINDOW_LABEL: &str = "settings";
pub(crate) const EVENT_RECORDING_START: &str = "recording:start";
pub(crate) const EVENT_RECORDING_STOP: &str = "recording:stop";
pub(crate) const EVENT_RECORDING_COMPLETE: &str = "recording:complete";
pub(crate) const EVENT_RECORDING_ERROR: &str = "recording:error";
pub(crate) const EVENT_RECORDING_MODE_CHANGE: &str = "recording:mode_change";
pub(crate) const EVENT_TRANSCRIPTION_START: &str = "transcription:start";
pub(crate) const EVENT_TRANSCRIPTION_COMPLETE: &str = "transcription:complete";
pub(crate) const EVENT_TRANSCRIPTION_ERROR: &str = "transcription:error";
pub(crate) const EVENT_SETTINGS_CHANGED: &str = "settings:changed";
pub(crate) const FEEDBACK_URL: &str = "https://github.com/LegendarySpy/Glimpse/issues";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
    let _guard = rt.enter();
    tauri::async_runtime::set(rt.handle().clone());

    let aptabase_key = option_env!("APTABASE_KEY").unwrap_or("A-DEV-0000000000");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_aptabase::Builder::new(&aptabase_key).build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_permissions::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);

            let handle = app.handle();
            let settings_store = Arc::new(SettingsStore::new(&handle)?);
            let mut settings = settings_store.load().unwrap_or_default();
            if model_manager::definition(&settings.local_model).is_none() {
                settings.local_model = default_local_model();
                if let Err(err) = settings_store.save(&settings) {
                    eprintln!("Failed to persist default local model: {err}");
                }
            }
            app.manage(AppState::new(
                Arc::clone(&settings_store),
                settings,
                &handle,
            ));

            if let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
                position_overlay(&window);
                let _ = window.hide();

                // On macOS, convert the overlay window to a non-activating NSPanel so showing it
                // doesn't steal focus from the user's active text field.
                platform::overlay::init(&handle, &window);
            }

            if let Some(toast_window) = handle.get_webview_window(toast::WINDOW_LABEL) {
                let _ = toast_window.hide();

                // Toast dismissal is handled via timer/click/Escape in the toast UI.
                // Platform-specific toast window/panel initialization lives in `platform::toast`.
                platform::toast::init(&handle, &toast_window);
            }

            if let Ok(tray) = tray::build_tray(&handle) {
                handle.state::<AppState>().store_tray(tray);
            }

            if let Err(err) = shortcuts::register_shortcuts(&handle) {
                eprintln!("Failed to register shortcuts: {err}");
            }

            if let Err(err) = tray::toggle_settings_window(&handle) {
                eprintln!("Failed to open settings window on launch: {err}");
            }

            let _ = app.track_event("app_started", None);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            get_dictionary,
            set_dictionary,
            get_replacements,
            set_replacements,
            get_app_info,
            open_data_dir,
            get_transcriptions,
            delete_transcription,
            delete_all_transcriptions,
            retry_transcription,
            retry_llm_cleanup,
            undo_llm_cleanup,
            model_manager::list_models,
            model_manager::check_model_status,
            model_manager::download_model,
            model_manager::delete_model,
            audio::list_input_devices,
            toast_dismissed,
            check_microphone_permission,
            request_microphone_permission,
            check_accessibility_permission,
            open_accessibility_settings,
            open_microphone_settings,
            complete_onboarding,
            cancel_recording,
            reset_onboarding,
            import_transcription_from_cloud,
            mark_transcription_synced
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handler, event| match event {
            tauri::RunEvent::Exit { .. } => {
                let _ = handler.track_event("app_exited", None);
                handler.flush_events_blocking();
            }
            _ => {}
        });
}

pub(crate) type AppRuntime = Wry;

type GlimpseResult<T> = Result<T>;

pub struct AppState {
    pub(crate) recorder: RecorderManager,
    http: Client,
    local_transcriber: Arc<local_transcription::LocalTranscriber>,
    storage: Arc<storage::StorageManager>,
    settings_store: Arc<SettingsStore>,
    settings: parking_lot::Mutex<UserSettings>,
    pub(crate) tray: parking_lot::Mutex<Option<TrayIcon<AppRuntime>>>,
    pub(crate) settings_close_handler_registered: AtomicBool,
    pub(crate) hold_shortcut_down: AtomicBool,
    pub(crate) toggle_recording_active: AtomicBool,
    /// Tracks which mode started the current recording: "hold", "toggle", or "smart"
    pub(crate) active_recording_mode: parking_lot::Mutex<Option<String>>,
    /// Smart mode state
    pub(crate) smart_toggle_active: AtomicBool,
    pub(crate) smart_press_time: parking_lot::Mutex<Option<chrono::DateTime<chrono::Local>>>,
}

impl AppState {
    pub fn new(
        settings_store: Arc<SettingsStore>,
        settings: UserSettings,
        app_handle: &AppHandle<AppRuntime>,
    ) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("Failed to build HTTP client");

        let storage_path = app_handle
            .path()
            .app_data_dir()
            .expect("Failed to resolve app data directory")
            .join("transcriptions.db");

        let storage = storage::StorageManager::new(storage_path)
            .expect("Failed to initialize transcription storage");

        Self {
            recorder: RecorderManager::new(),
            http,
            local_transcriber: Arc::new(local_transcription::LocalTranscriber::new()),
            storage: Arc::new(storage),
            settings_store,
            settings: parking_lot::Mutex::new(settings),
            tray: parking_lot::Mutex::new(None),
            settings_close_handler_registered: AtomicBool::new(false),
            hold_shortcut_down: AtomicBool::new(false),
            toggle_recording_active: AtomicBool::new(false),
            active_recording_mode: parking_lot::Mutex::new(None),
            smart_toggle_active: AtomicBool::new(false),
            smart_press_time: parking_lot::Mutex::new(None),
        }
    }

    pub fn current_settings(&self) -> UserSettings {
        match self.settings_store.load() {
            Ok(latest) => {
                *self.settings.lock() = latest.clone();
                latest
            }
            Err(err) => {
                eprintln!("Failed to load settings from DB, using cache: {err}");
                self.settings.lock().clone()
            }
        }
    }

    pub fn persist_settings(&self, next: UserSettings) -> GlimpseResult<UserSettings> {
        self.settings_store.save(&next)?;
        *self.settings.lock() = next.clone();
        Ok(next)
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

    pub fn store_tray(&self, tray: TrayIcon<AppRuntime>) {
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

    fn set_smart_toggle_active(&self, active: bool) {
        self.smart_toggle_active.store(active, Ordering::SeqCst);
    }

    fn set_smart_press_time(&self, time: Option<chrono::DateTime<chrono::Local>>) {
        *self.smart_press_time.lock() = time;
    }

    fn get_smart_press_time(&self) -> Option<chrono::DateTime<chrono::Local>> {
        *self.smart_press_time.lock()
    }
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Result<UserSettings, String> {
    Ok(state.current_settings())
}

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
    let model = settings.local_model.clone();
    settings.onboarding_completed = true;
    state
        .persist_settings(settings)
        .map_err(|err| err.to_string())?;
    analytics::track_onboarding_completed(&app, &model);
    Ok(())
}

#[tauri::command]
fn reset_onboarding(
    _app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut settings = state.current_settings();
    settings.onboarding_completed = false;
    state
        .persist_settings(settings)
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
fn update_settings(
    smartShortcut: String,
    smartEnabled: bool,
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
    if smartEnabled && smartShortcut.trim().is_empty() {
        return Err("Smart shortcut cannot be empty when enabled".into());
    }

    if holdEnabled && holdShortcut.trim().is_empty() {
        return Err("Hold shortcut cannot be empty when enabled".into());
    }

    if toggleEnabled && toggleShortcut.trim().is_empty() {
        return Err("Toggle shortcut cannot be empty when enabled".into());
    }

    if !smartEnabled && !holdEnabled && !toggleEnabled {
        return Err("At least one recording mode must be enabled".into());
    }

    let mut enabled_shortcuts: Vec<(&str, &str)> = vec![];
    if smartEnabled {
        enabled_shortcuts.push(("Smart", smartShortcut.trim()));
    }
    if holdEnabled {
        enabled_shortcuts.push(("Hold", holdShortcut.trim()));
    }
    if toggleEnabled {
        enabled_shortcuts.push(("Toggle", toggleShortcut.trim()));
    }

    for i in 0..enabled_shortcuts.len() {
        for j in (i + 1)..enabled_shortcuts.len() {
            let (name1, shortcut1) = enabled_shortcuts[i];
            let (name2, shortcut2) = enabled_shortcuts[j];
            if shortcut1.to_lowercase() == shortcut2.to_lowercase() {
                return Err(format!(
                    "{} and {} shortcuts cannot be the same",
                    name1, name2
                ));
            }
        }
    }

    if model_manager::definition(&localModel).is_none() {
        return Err("Unknown model selection".into());
    }

    if llmCleanupEnabled && !matches!(llmProvider, LlmProvider::None) {
        if matches!(llmProvider, LlmProvider::Custom) && llmEndpoint.trim().is_empty() {
            return Err("Custom LLM endpoint cannot be empty".into());
        }
        if matches!(llmProvider, LlmProvider::OpenAI) && llmApiKey.trim().is_empty() {
            return Err("OpenAI API key is required".into());
        }
    }

    let mut next = state.current_settings();
    let prev = next.clone();
    next.smart_shortcut = smartShortcut;
    next.smart_enabled = smartEnabled;
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

    let next = state
        .persist_settings(next)
        .map_err(|err| err.to_string())?;

    shortcuts::register_shortcuts(&app).map_err(|err| err.to_string())?;

    if prev.transcription_mode != next.transcription_mode
        || prev.local_model != next.local_model
        || prev.microphone_device != next.microphone_device
    {
        if let Err(err) = tray::refresh_tray_menu(&app, &next) {
            eprintln!("Failed to refresh tray menu: {err}");
        }
    }

    if let Err(err) = app.emit(EVENT_SETTINGS_CHANGED, &next) {
        eprintln!("Failed to emit settings change: {err}");
    }

    Ok(next)
}

fn sanitize_dictionary_entries(entries: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();

    for raw in entries {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = trimmed.to_lowercase();
        if seen.insert(normalized) {
            // Cap using char boundaries to avoid UTF-8 slicing panics
            let capped: String = trimmed.chars().take(160).collect();
            let capped = capped.trim_end().to_string();
            cleaned.push(capped);
        }
        if cleaned.len() >= 64 {
            break;
        }
    }

    cleaned
}

fn build_dictionary_prompt(entries: &[String]) -> Option<String> {
    let cleaned = sanitize_dictionary_entries(entries);
    if cleaned.is_empty() {
        return None;
    }

    let mut prompt =
        String::from("Use the following preferred terms verbatim when transcribing:\n");
    for term in cleaned {
        prompt.push_str("- ");
        prompt.push_str(&term);
        prompt.push('\n');
    }

    Some(prompt)
}

fn dictionary_prompt_for_model(
    model: &model_manager::ReadyModel,
    settings: &settings::UserSettings,
) -> Option<String> {
    if !matches!(model.engine, model_manager::LocalModelEngine::Whisper) {
        return None;
    }

    build_dictionary_prompt(&settings.dictionary)
}

#[tauri::command]
fn get_dictionary(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    let mut settings = state.current_settings();
    let cleaned = sanitize_dictionary_entries(&settings.dictionary);
    if cleaned != settings.dictionary {
        settings.dictionary = cleaned.clone();
        state
            .persist_settings(settings)
            .map_err(|err| err.to_string())?;
    }
    Ok(cleaned)
}

#[tauri::command]
fn set_dictionary(
    entries: Vec<String>,
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<Vec<String>, String> {
    let cleaned = sanitize_dictionary_entries(&entries);
    let mut settings = state.current_settings();
    settings.dictionary = cleaned.clone();
    let _ = app;
    state
        .persist_settings(settings)
        .map_err(|err| err.to_string())?;
    Ok(cleaned)
}

fn sanitize_replacements(replacements: &[Replacement]) -> Vec<Replacement> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();

    for r in replacements {
        let from = r.from.trim();
        let to = r.to.trim();
        if from.is_empty() {
            continue;
        }
        let key = from.to_lowercase();
        if seen.insert(key) {
            let from_capped: String = from.chars().take(100).collect();
            let to_capped: String = to.chars().take(200).collect();
            cleaned.push(Replacement {
                from: from_capped.trim().to_string(),
                to: to_capped.trim().to_string(),
            });
        }
        if cleaned.len() >= 64 {
            break;
        }
    }

    cleaned
}

pub fn apply_replacements(text: &str, replacements: &[Replacement]) -> String {
    if replacements.is_empty() {
        return text.to_string();
    }

    let mut result = text.to_string();
    for r in replacements {
        if r.from.is_empty() {
            continue;
        }
        let pattern = format!(r"(?i)\b{}\b", regex::escape(&r.from));
        if let Ok(re) = regex::Regex::new(&pattern) {
            result = re
                .replace_all(&result, |caps: &regex::Captures| {
                    let matched = &caps[0];
                    apply_case_pattern(matched, &r.to)
                })
                .to_string();
        }
    }
    result
}

fn apply_case_pattern(matched: &str, replacement: &str) -> String {
    if replacement.is_empty() {
        return String::new();
    }

    let first_char = matched.chars().next();
    let is_first_upper = first_char.map(|c| c.is_uppercase()).unwrap_or(false);
    let is_all_upper = matched.len() > 1
        && matched
            .chars()
            .all(|c| !c.is_alphabetic() || c.is_uppercase());

    if is_all_upper {
        replacement.to_uppercase()
    } else if is_first_upper {
        let mut chars = replacement.chars();
        match chars.next() {
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            None => String::new(),
        }
    } else {
        replacement.to_string()
    }
}

#[tauri::command]
fn get_replacements(state: tauri::State<AppState>) -> Result<Vec<Replacement>, String> {
    let mut settings = state.current_settings();
    let cleaned = sanitize_replacements(&settings.replacements);
    if cleaned != settings.replacements {
        settings.replacements = cleaned.clone();
        state
            .persist_settings(settings)
            .map_err(|err| err.to_string())?;
    }
    Ok(cleaned)
}

#[tauri::command]
fn set_replacements(
    replacements: Vec<Replacement>,
    state: tauri::State<AppState>,
) -> Result<Vec<Replacement>, String> {
    let cleaned = sanitize_replacements(&replacements);
    let mut settings = state.current_settings();
    settings.replacements = cleaned.clone();
    state
        .persist_settings(settings)
        .map_err(|err| err.to_string())?;
    Ok(cleaned)
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

    let data_dir_size_bytes = calculate_dir_size(&data_dir).unwrap_or(0);

    Ok(AppInfo {
        version,
        data_dir_size_bytes,
        data_dir_path,
    })
}

#[tauri::command]
fn open_data_dir(path: Option<String>, app: AppHandle<AppRuntime>) -> Result<(), String> {
    let path = path.ok_or_else(|| "Path is empty".to_string())?;
    let path = PathBuf::from(path);

    if !path.exists() {
        return Err("Path does not exist".to_string());
    }

    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|err| format!("Failed to open path: {err}"))
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
fn get_transcriptions(
    state: tauri::State<AppState>,
) -> Result<Vec<storage::TranscriptionRecord>, String> {
    Ok(state.storage().get_all())
}

#[tauri::command]
fn import_transcription_from_cloud(
    record: storage::TranscriptionRecord,
    state: tauri::State<AppState>,
) -> Result<bool, String> {
    state
        .storage()
        .import_transcription(record)
        .map_err(|err| format!("Failed to import transcription: {err}"))
}

#[tauri::command]
fn mark_transcription_synced(id: String, state: tauri::State<AppState>) -> Result<(), String> {
    state
        .storage()
        .mark_as_synced(&id)
        .map_err(|err| format!("Failed to mark transcription as synced: {err}"))
}

#[tauri::command]
fn delete_transcription(id: String, state: tauri::State<AppState>) -> Result<bool, String> {
    match state.storage().delete(&id) {
        Ok(Some(audio_path)) => {
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
fn delete_all_transcriptions(state: tauri::State<AppState>) -> Result<u32, String> {
    let audio_paths = state
        .storage()
        .delete_all()
        .map_err(|err| format!("Failed to delete all transcriptions: {err}"))?;

    let deleted_count = audio_paths.len() as u32;
    for audio_path in audio_paths {
        let _ = std::fs::remove_file(audio_path);
    }

    Ok(deleted_count)
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

    // Removed status check to allow retrying any transcription
    // if record.status != storage::TranscriptionStatus::Error {
    //     return Err("Can only retry failed transcriptions".to_string());
    // }

    let audio_path = PathBuf::from(&record.audio_path);
    if !audio_path.exists() {
        return Err("Audio file not found".to_string());
    }

    let saved = RecordingSaved {
        path: audio_path,
        started_at: record.timestamp,
        ended_at: record.timestamp,
    };

    let _ = state.storage().delete(&id);

    emit_transcription_start(&app, &saved);

    let http = state.http();
    let app_handle = app.clone();
    let saved_for_task = saved.clone();

    async_runtime::spawn(async move {
        let settings = app_handle.state::<AppState>().current_settings();
        let config = transcription::TranscriptionConfig::from_settings(&settings);
        let use_local = matches!(settings.transcription_mode, TranscriptionMode::Local);

        let result = if use_local {
            match load_audio_for_transcription(&saved_for_task.path) {
                Ok((samples, sample_rate)) => {
                    let model_key = settings.local_model.clone();
                    match model_manager::ensure_model_ready(&app_handle, &model_key) {
                        Ok(ready_model) => {
                            let dictionary_prompt =
                                dictionary_prompt_for_model(&ready_model, &settings);
                            let transcriber = app_handle.state::<AppState>().local_transcriber();
                            match async_runtime::spawn_blocking(move || {
                                transcriber.transcribe(
                                    &ready_model,
                                    &samples,
                                    sample_rate,
                                    dictionary_prompt.as_deref(),
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
            transcription::request_transcription(&http, &saved_for_task, &config).await
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
                    apply_replacements(&final_transcript, &settings.replacements);

                if count_words(&final_transcript) == 0 {
                    handle_empty_transcription(&app_handle, &saved_for_task.path);
                    return;
                }

                let mut pasted = false;
                if config.auto_paste && !final_transcript.trim().is_empty() {
                    let text = final_transcript.clone();
                    match async_runtime::spawn_blocking(move || assistive::paste_text(&text)).await
                    {
                        Ok(Ok(())) => pasted = true,
                        Ok(Err(err)) => {
                            let err_str = err.to_string();
                            let is_accessibility_issue =
                                err_str.to_lowercase().contains("accessibility")
                                    || err_str.to_lowercase().contains("permission")
                                    || err_str.to_lowercase().contains("not allowed")
                                    || err_str.to_lowercase().contains("assistive");

                            if is_accessibility_issue {
                                toast::show(
                                    &app_handle,
                                    "warning",
                                    Some("Accessibility Required"),
                                    "Enable accessibility access in System Settings to auto-paste transcriptions.",
                                );
                            } else {
                                toast::show(
                                    &app_handle,
                                    "error",
                                    None,
                                    &format!("Auto paste failed: {err}"),
                                );
                            }
                            eprintln!("Auto paste failed: {err}");
                        }
                        Err(err) => {
                            toast::show(&app_handle, "error", None, "Auto paste failed");
                            eprintln!("Auto paste task error: {err}");
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
    let llm_model = llm_cleanup::resolved_model_name(&settings);

    let text_to_clean = record.raw_text.unwrap_or(record.text);

    let http = state.http();
    let storage = state.storage();
    let record_id = id.clone();

    async_runtime::spawn(async move {
        match llm_cleanup::cleanup_transcription(&http, &text_to_clean, &settings).await {
            Ok(cleaned) => {
                if let Err(err) =
                    storage.update_with_llm_cleanup(&record_id, cleaned, llm_model.clone())
                {
                    eprintln!("Failed to save LLM cleanup: {err}");
                }
                let _ = app.emit(
                    EVENT_TRANSCRIPTION_COMPLETE,
                    TranscriptionCompletePayload {
                        transcript: String::new(),
                        auto_paste: false,
                    },
                );
            }
            Err(err) => {
                eprintln!("LLM cleanup failed: {err}");
                let _ = app.emit(
                    EVENT_TRANSCRIPTION_ERROR,
                    TranscriptionErrorPayload {
                        message: format!("LLM cleanup failed: {err}"),
                        stage: "llm_cleanup".to_string(),
                    },
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn undo_llm_cleanup(
    id: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let storage = state.storage();

    match storage.revert_to_raw(&id) {
        Ok(Some(_)) => {
            let _ = app.emit(
                EVENT_TRANSCRIPTION_COMPLETE,
                TranscriptionCompletePayload {
                    transcript: String::new(),
                    auto_paste: false,
                },
            );
            Ok(())
        }
        Ok(None) => Err("No raw text available to revert to".to_string()),
        Err(err) => Err(format!("Failed to undo LLM cleanup: {err}")),
    }
}

pub(crate) fn show_overlay(app: &AppHandle<AppRuntime>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        position_overlay_on_cursor_screen(&window);
        platform::overlay::show(app, &window);
    }
}

pub(crate) fn hide_overlay(app: &AppHandle<AppRuntime>) {
    emit_event(
        app,
        EVENT_RECORDING_STOP,
        RecordingStopPayload {
            ended_at: chrono::Local::now().to_rfc3339(),
        },
    );
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        platform::overlay::hide(app, &window);
    }
}

pub(crate) fn stop_active_recording(app: &AppHandle<AppRuntime>) {
    let state = app.state::<AppState>();
    if let Err(err) = state.recorder().stop() {
        eprintln!("Failed to stop recorder: {err}");
    }
    state.set_active_recording_mode(None);
    state.set_toggle_recording_active(false);
    state.clear_hold_shortcut_state();
    state.set_smart_toggle_active(false);
    state.set_smart_press_time(None);
}

#[tauri::command]
fn toast_dismissed(app: AppHandle<AppRuntime>) {
    stop_active_recording(&app);
    hide_overlay(&app);
    toast::hide(&app);
}

#[tauri::command]
fn cancel_recording(app: AppHandle<AppRuntime>) {
    stop_active_recording(&app);
    hide_overlay(&app);
}

pub(crate) fn persist_recording_async(app: AppHandle<AppRuntime>, recording: CompletedRecording) {
    let base_dir = match recordings_root(&app) {
        Ok(path) => path,
        Err(err) => {
            emit_error(
                &app,
                format!("Failed to resolve recordings directory: {err}"),
            );
            return;
        }
    };

    let recording_for_transcription = recording.clone();

    async_runtime::spawn(async move {
        let task =
            async_runtime::spawn_blocking(move || recorder::persist_recording(base_dir, recording));
        match task.await {
            Ok(Ok(saved)) => emit_complete(&app, saved, recording_for_transcription),
            Ok(Err(err)) => emit_error(&app, format!("Unable to save recording: {err}")),
            Err(err) => emit_error(&app, format!("Recording task failed: {err}")),
        }
    });
}

fn emit_complete(
    app: &AppHandle<AppRuntime>,
    saved: RecordingSaved,
    recording: CompletedRecording,
) {
    emit_event(
        app,
        EVENT_RECORDING_COMPLETE,
        RecordingCompletePayload {
            path: saved.path.display().to_string(),
            started_at: saved.started_at.to_rfc3339(),
            ended_at: saved.ended_at.to_rfc3339(),
            duration_ms: (saved.ended_at - saved.started_at).num_milliseconds(),
        },
    );

    if let Err(rejection) = validate_recording(&recording) {
        let reason = match rejection {
            RecordingRejectionReason::TooShort {
                duration_ms,
                min_ms,
            } => {
                format!("Recording too short ({duration_ms}ms < {min_ms}ms minimum)")
            }
            RecordingRejectionReason::TooQuiet { rms, threshold } => {
                format!("Recording too quiet (energy {rms:.4} < {threshold} threshold)")
            }
            RecordingRejectionReason::NoSpeechDetected => {
                "No speech detected in recording".to_string()
            }
            RecordingRejectionReason::EmptyBuffer => "Recording buffer is empty".to_string(),
        };
        eprintln!("Recording rejected: {reason}");

        if let Err(err) = std::fs::remove_file(&saved.path) {
            eprintln!("Failed to remove rejected recording file: {err}");
        }

        hide_overlay(app);
        return;
    }

    queue_transcription(app, saved, recording);
}

pub(crate) fn emit_error(app: &AppHandle<AppRuntime>, message: String) {
    emit_event(
        app,
        EVENT_RECORDING_ERROR,
        RecordingErrorPayload {
            message: message.clone(),
        },
    );
    stop_active_recording(app);
    let toast_message = simplify_recording_error(&message);
    toast::show(app, "error", None, &toast_message);
}

pub(crate) fn emit_event<T: Serialize + Clone>(
    app: &AppHandle<AppRuntime>,
    event: &str,
    payload: T,
) {
    if let Err(err) = app.emit(event, payload) {
        eprintln!("Failed to emit {event}: {err}");
    }
}

fn queue_transcription(
    app: &AppHandle<AppRuntime>,
    saved: RecordingSaved,
    recording: CompletedRecording,
) {
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
                    let dictionary_prompt = dictionary_prompt_for_model(&ready_model, &settings);
                    let transcriber = app_handle.state::<AppState>().local_transcriber();
                    let local_recording = recording_for_task.clone();
                    match async_runtime::spawn_blocking(move || {
                        transcriber.transcribe(
                            &ready_model,
                            &local_recording.samples,
                            local_recording.sample_rate,
                            dictionary_prompt.as_deref(),
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
                                eprintln!("LLM cleanup failed, using raw transcript: {err}");
                                (raw_transcript.clone(), false)
                            }
                        }
                    } else {
                        (raw_transcript.clone(), false)
                    };

                let final_transcript =
                    apply_replacements(&final_transcript, &settings.replacements);

                if count_words(&final_transcript) == 0 {
                    handle_empty_transcription(&app_handle, &saved_for_task.path);
                    return;
                }

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

                let metadata = build_transcription_metadata(
                    &saved_for_task,
                    &settings,
                    use_local,
                    reported_model.as_deref(),
                    &final_transcript,
                    llm_cleaned,
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

#[allow(dead_code)]
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

    emit_event(
        app,
        EVENT_TRANSCRIPTION_COMPLETE,
        TranscriptionCompletePayload {
            transcript: final_transcript.clone(),
            auto_paste,
        },
    );

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
    emit_event(
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

    hide_overlay(app);
}

fn emit_transcription_error(
    app: &AppHandle<AppRuntime>,
    message: String,
    stage: &str,
    audio_path: String,
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

    emit_event(
        app,
        EVENT_TRANSCRIPTION_ERROR,
        TranscriptionErrorPayload {
            message: message.clone(),
            stage: stage.to_string(),
        },
    );

    stop_active_recording(app);

    let settings = app.state::<AppState>().current_settings();
    let is_local = matches!(settings.transcription_mode, TranscriptionMode::Local);

    let toast_message = format_transcription_error(&message, is_local);
    let metadata = storage::TranscriptionMetadata {
        speech_model: resolve_speech_model_label(&settings, is_local, None),
        ..Default::default()
    };

    let record_result = app.state::<AppState>().storage().save_transcription(
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
}

/// Creates user-friendly error message based on transcription mode
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

    if is_local {
        "Transcription failed".to_string()
    } else {
        "Transcription failed".to_string()
    }
}

fn build_transcription_metadata(
    saved: &RecordingSaved,
    settings: &UserSettings,
    use_local: bool,
    reported_model: Option<&str>,
    final_text: &str,
    llm_cleaned: bool,
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
    let duration_ms = (saved.ended_at - saved.started_at).num_milliseconds();
    (duration_ms.max(0) as f32) / 1000.0
}

fn count_words(text: &str) -> u32 {
    text.split_whitespace()
        .filter(|word| !word.is_empty())
        .count() as u32
}

/// Simplifies recording error messages
fn simplify_recording_error(message: &str) -> String {
    let msg_lower = message.to_lowercase();

    // Check for permission-related errors first
    if msg_lower.contains("permission")
        || msg_lower.contains("not allowed")
        || msg_lower.contains("access denied")
        || msg_lower.contains("coreaudio")
    // macOS specific permission error
    {
        return "Microphone permission needed. Check System Settings.".to_string();
    }

    if msg_lower.contains("microphone")
        || msg_lower.contains("audio")
        || msg_lower.contains("input device")
    {
        return "Microphone unavailable".to_string();
    }

    if message.len() <= 30 {
        return message.to_string();
    }

    "Recording failed".to_string()
}

fn load_audio_for_transcription(path: &PathBuf) -> Result<(Vec<i16>, u32)> {
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

fn recordings_root(app: &AppHandle<AppRuntime>) -> GlimpseResult<PathBuf> {
    let mut data_dir = app
        .path()
        .app_data_dir()
        .context("App data directory not found")?;
    data_dir.push("recordings");
    Ok(data_dir)
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

fn position_overlay_on_cursor_screen(window: &WebviewWindow<AppRuntime>) {
    let cursor_pos = match window.cursor_position() {
        Ok(pos) => pos,
        Err(_) => {
            position_overlay(window);
            return;
        }
    };

    let monitors = match window.available_monitors() {
        Ok(m) => m,
        Err(_) => {
            position_overlay(window);
            return;
        }
    };

    let target_monitor = monitors.into_iter().find(|m| {
        let pos = m.position();
        let size = m.size();
        cursor_pos.x >= pos.x as f64
            && cursor_pos.x < (pos.x + size.width as i32) as f64
            && cursor_pos.y >= pos.y as f64
            && cursor_pos.y < (pos.y + size.height as i32) as f64
    });

    let monitor = match target_monitor {
        Some(m) => m,
        None => {
            position_overlay(window);
            return;
        }
    };

    if let Ok(size) = window.outer_size() {
        let mon_pos = monitor.position();
        let mon_size = monitor.size();
        let x = mon_pos.x + ((mon_size.width.saturating_sub(size.width)) / 2) as i32;
        let y = mon_pos.y + ((mon_size.height as f64) * 0.88) as i32;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

#[derive(Serialize, Clone)]
pub(crate) struct RecordingModePayload {
    mode: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct RecordingStartPayload {
    started_at: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct RecordingStopPayload {
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
    auto_paste: bool,
}

#[derive(Serialize, Clone)]
struct TranscriptionErrorPayload {
    message: String,
    stage: String,
}
