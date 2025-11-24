mod assistive;
mod recorder;
mod settings;
mod transcription;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use recorder::{CompletedRecording, RecorderManager, RecordingSaved};
use reqwest::Client;
use serde::Serialize;
use settings::UserSettings;
use tauri::async_runtime;
use tauri::Emitter;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{ActivationPolicy, AppHandle, Manager, Runtime, WebviewWindow, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const MAIN_WINDOW_LABEL: &str = "main";
const SETTINGS_WINDOW_LABEL: &str = "settings";
const EVENT_RECORDING_START: &str = "recording:start";
const EVENT_RECORDING_STOP: &str = "recording:stop";
const EVENT_RECORDING_COMPLETE: &str = "recording:complete";
const EVENT_RECORDING_ERROR: &str = "recording:error";
const EVENT_TRANSCRIPTION_START: &str = "transcription:start";
const EVENT_TRANSCRIPTION_COMPLETE: &str = "transcription:complete";
const EVENT_TRANSCRIPTION_ERROR: &str = "transcription:error";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok();
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Accessory);

            let handle = app.handle();
            let settings = UserSettings::load(&handle).unwrap_or_default();
            app.manage(AppState::new(settings));

            if let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
                position_overlay(&window);
                let _ = window.hide();
            }

            if let Ok(tray) = build_tray(&handle) {
                handle.state::<AppState>().store_tray(tray);
            }

            if let Err(err) = register_shortcut(&handle) {
                eprintln!("Failed to register shortcut: {err}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_settings, update_shortcut])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

type AppRuntime = Wry;

type GlimpseResult<T> = Result<T>;

struct AppState {
    recorder: RecorderManager,
    http: Client,
    settings: parking_lot::Mutex<UserSettings>,
    tray: parking_lot::Mutex<Option<TrayIcon<AppRuntime>>>,
    shortcut_down: AtomicBool,
}

impl AppState {
    fn new(settings: UserSettings) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("Failed to build HTTP client");
        Self {
            recorder: RecorderManager::new(),
            http,
            settings: parking_lot::Mutex::new(settings),
            tray: parking_lot::Mutex::new(None),
            shortcut_down: AtomicBool::new(false),
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

    fn store_tray(&self, tray: TrayIcon<AppRuntime>) {
        *self.tray.lock() = Some(tray);
    }

    fn mark_shortcut_down(&self) -> bool {
        self.shortcut_down.swap(true, Ordering::SeqCst)
    }

    fn clear_shortcut_state(&self) -> bool {
        self.shortcut_down.swap(false, Ordering::SeqCst)
    }
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Result<UserSettings, String> {
    Ok(state.current_settings())
}

#[tauri::command]
fn update_shortcut(
    shortcut: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<UserSettings, String> {
    if shortcut.trim().is_empty() {
        return Err("Shortcut cannot be empty".into());
    }

    let mut next = state.current_settings();
    next.shortcut = shortcut.clone();

    next.save(&app).map_err(|err| err.to_string())?;
    state.set_settings(next.clone());

    register_shortcut(&app).map_err(|err| err.to_string())?;

    Ok(next)
}

fn register_shortcut(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    let shortcut_text = app.state::<AppState>().current_settings().shortcut;
    let manager = app.global_shortcut();

    if let Err(err) = manager.unregister_all() {
        eprintln!("Failed to clear shortcuts: {err}");
    }

    manager.on_shortcut(shortcut_text.as_str(), move |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            if let Err(err) = handle_shortcut_press(app) {
                eprintln!("Shortcut press error: {err}");
            }
        } else if event.state == ShortcutState::Released {
            if let Err(err) = handle_shortcut_release(app) {
                eprintln!("Shortcut release error: {err}");
            }
        }
    })?;

    Ok(())
}

fn handle_shortcut_press(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    let state = app.state::<AppState>();
    if state.mark_shortcut_down() {
        return Ok(());
    }

    match state.recorder().start() {
        Ok(started) => {
            show_overlay(app);
            emit_event(app, EVENT_RECORDING_START, RecordingStartPayload {
                started_at: started.to_rfc3339(),
            });
        }
        Err(err) => {
            state.clear_shortcut_state();
            emit_error(app, format!("Unable to start recording: {err}"));
        }
    }

    Ok(())
}

fn handle_shortcut_release(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    let state = app.state::<AppState>();
    if !state.clear_shortcut_state() {
        return Ok(());
    }

    match state.recorder().stop() {
        Ok(Some(recording)) => {
            hide_overlay(app);
            emit_event(app, EVENT_RECORDING_STOP, RecordingStopPayload {
                ended_at: recording.ended_at.to_rfc3339(),
            });
            persist_recording_async(app.clone(), recording);
        }
        Ok(None) => {
            hide_overlay(app);
        }
        Err(err) => emit_error(app, format!("Unable to stop recording: {err}")),
    }

    Ok(())
}

fn show_overlay(app: &AppHandle<AppRuntime>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
    }
}

fn hide_overlay(app: &AppHandle<AppRuntime>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.hide();
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

    async_runtime::spawn(async move {
        let task = async_runtime::spawn_blocking(move || recorder::persist_recording(base_dir, recording));
        match task.await {
            Ok(Ok(saved)) => emit_complete(&app, saved),
            Ok(Err(err)) => emit_error(&app, format!("Unable to save recording: {err}")),
            Err(err) => emit_error(&app, format!("Recording task failed: {err}")),
        }
    });
}

fn emit_complete(app: &AppHandle<AppRuntime>, saved: RecordingSaved) {
    emit_event(app, EVENT_RECORDING_COMPLETE, RecordingCompletePayload {
        path: saved.path.display().to_string(),
        started_at: saved.started_at.to_rfc3339(),
        ended_at: saved.ended_at.to_rfc3339(),
        duration_ms: (saved.ended_at - saved.started_at).num_milliseconds(),
    });

    queue_transcription(app, saved);
}

fn emit_error(app: &AppHandle<AppRuntime>, message: String) {
    emit_event(app, EVENT_RECORDING_ERROR, RecordingErrorPayload { message });
}

fn emit_event<T: Serialize + Clone>(app: &AppHandle<AppRuntime>, event: &str, payload: T) {
    if let Err(err) = app.emit(event, payload) {
        eprintln!("Failed to emit {event}: {err}");
    }
}

fn queue_transcription(app: &AppHandle<AppRuntime>, saved: RecordingSaved) {
    emit_transcription_start(app, &saved);

    let http = app.state::<AppState>().http();
    let app_handle = app.clone();
    let saved_for_task = saved.clone();

    async_runtime::spawn(async move {
        let config = transcription::TranscriptionConfig::from_env();
        match transcription::request_transcription(&http, &saved_for_task, &config).await {
            Ok(result) => {
                let mut pasted = false;
                if config.auto_paste && !result.transcript.trim().is_empty() {
                    let text = result.transcript.clone();
                    match async_runtime::spawn_blocking(move || assistive::paste_text(&text)).await {
                        Ok(Ok(())) => pasted = true,
                        Ok(Err(err)) => {
                            emit_transcription_error(&app_handle, format!("Auto paste failed: {err}"), "auto_paste");
                        }
                        Err(err) => {
                            emit_transcription_error(&app_handle, format!("Auto paste task error: {err}"), "auto_paste");
                        }
                    }
                }

                emit_transcription_complete(&app_handle, result.transcript, result.confidence, pasted);
            }
            Err(err) => emit_transcription_error(&app_handle, format!("Transcription failed: {err}"), "api"),
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
) {
    emit_event(
        app,
        EVENT_TRANSCRIPTION_COMPLETE,
        TranscriptionCompletePayload {
            transcript,
            confidence,
            auto_paste,
        },
    );
}

fn emit_transcription_error(app: &AppHandle<AppRuntime>, message: String, stage: &str) {
    emit_event(
        app,
        EVENT_TRANSCRIPTION_ERROR,
        TranscriptionErrorPayload {
            message,
            stage: stage.to_string(),
        },
    );
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
    let open_settings = MenuItem::with_id(app, "open_settings", "Open Settings", true, None::<&str>)?;
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

fn toggle_settings_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        window.show()?;
        window.set_focus()?;
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
