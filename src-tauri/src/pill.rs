use crate::{
    assistive, cloud, emit_event, permissions, platform, recorder::RecorderManager, toast,
    AppRuntime, AppState, MAIN_WINDOW_LABEL,
};
use chrono::{DateTime, Local};
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const MIN_RECORDING_DURATION_MS: i64 = 300;
const SMART_MODE_TAP_THRESHOLD_MS: i64 = 200;

pub const EVENT_PILL_STATE: &str = "pill:state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PillStatus {
    Idle,
    Listening,
    Processing,
    Error,
}

impl std::fmt::Display for PillStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PillStatus::Idle => write!(f, "idle"),
            PillStatus::Listening => write!(f, "listening"),
            PillStatus::Processing => write!(f, "processing"),
            PillStatus::Error => write!(f, "error"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordingMode {
    Hold,
    Toggle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShortcutOrigin {
    Hold,
    Toggle,
    Smart,
}

#[derive(Serialize, Clone)]
pub struct PillStatePayload {
    pub status: PillStatus,
    pub mode: Option<String>,
}

pub struct PillController {
    status: Mutex<PillStatus>,
    recording_mode: Mutex<Option<RecordingMode>>,
    smart_press_time: Mutex<Option<DateTime<Local>>>,
    hold_key_down: Mutex<bool>,
    shortcut_origin: Mutex<Option<ShortcutOrigin>>,
    recorder: Arc<RecorderManager>,
}

impl PillController {
    pub fn new(recorder: Arc<RecorderManager>) -> Self {
        Self {
            status: Mutex::new(PillStatus::Idle),
            recording_mode: Mutex::new(None),
            smart_press_time: Mutex::new(None),
            hold_key_down: Mutex::new(false),
            shortcut_origin: Mutex::new(None),
            recorder,
        }
    }

    pub fn status(&self) -> PillStatus {
        *self.status.lock()
    }

    pub fn recorder(&self) -> &RecorderManager {
        &self.recorder
    }

    fn emit_state(&self, app: &AppHandle<AppRuntime>) {
        let status = *self.status.lock();
        let mode = self.recording_mode.lock().map(|m| match m {
            RecordingMode::Hold => "hold",
            RecordingMode::Toggle => "toggle",
        });

        if let Err(err) = app.emit(
            EVENT_PILL_STATE,
            PillStatePayload {
                status,
                mode: mode.map(String::from),
            },
        ) {
            eprintln!("Failed to emit pill state: {err}");
        }

        match status {
            PillStatus::Idle => hide_overlay(app),
            _ => show_overlay(app),
        }
    }

    pub fn transition_to(&self, app: &AppHandle<AppRuntime>, new_status: PillStatus) {
        {
            let mut status = self.status.lock();
            if *status == new_status {
                return;
            }
            *status = new_status;
        }
        self.emit_state(app);
    }

    pub fn transition_to_error(&self, app: &AppHandle<AppRuntime>, message: &str) {
        self.reset_recording_state();
        *self.hold_key_down.lock() = false;
        self.transition_to(app, PillStatus::Error);
        let simple_msg = simplify_recording_error(message);
        toast::show(app, "error", None, &simple_msg);
    }
    pub fn transition_to_error_silent(&self, app: &AppHandle<AppRuntime>) {
        self.reset_recording_state();
        *self.hold_key_down.lock() = false;
        self.transition_to(app, PillStatus::Error);
    }

    pub fn reset(&self, app: &AppHandle<AppRuntime>) {
        self.reset_recording_state();
        *self.hold_key_down.lock() = false;
        self.transition_to(app, PillStatus::Idle);
    }

    fn reset_recording_state(&self) {
        *self.recording_mode.lock() = None;
        *self.smart_press_time.lock() = None;
        // Note: hold_key_down is intentionally NOT cleared here.
        // It tracks physical key state and should only change via actual key events.
        *self.shortcut_origin.lock() = None;
    }

    fn capture_selected_text_if_enabled(&self, app: &AppHandle<AppRuntime>) {
        let state = app.state::<AppState>();
        let settings = state.current_settings();

        if !settings.edit_mode_enabled {
            state.set_pending_selected_text(None);
            return;
        }

        let selected_text = match assistive::get_selected_text_ax() {
            Some(text) if text.len() <= 10_000 => Some(text),
            _ => None,
        };
        state.set_pending_selected_text(selected_text);
    }

    fn is_recording(&self) -> bool {
        self.recording_mode.lock().is_some()
    }

    fn active_mode(&self) -> Option<RecordingMode> {
        *self.recording_mode.lock()
    }

    fn try_start_recording(&self, mode: RecordingMode) -> bool {
        let mut current_mode = self.recording_mode.lock();
        if current_mode.is_some() {
            return false;
        }
        *current_mode = Some(mode);
        if mode == RecordingMode::Hold {
            *self.hold_key_down.lock() = true;
        }
        true
    }

    fn clear_hold_state(&self) -> bool {
        let mut hold_down = self.hold_key_down.lock();
        if *hold_down {
            *hold_down = false;
            true
        } else {
            false
        }
    }

    /// Returns true if recording started successfully, false if blocked by a check
    fn handle_hold_press(&self, app: &AppHandle<AppRuntime>) -> bool {
        if self.status() == PillStatus::Processing {
            if *self.shortcut_origin.lock() == Some(ShortcutOrigin::Hold) {
                self.cancel_processing(app);
            }
            return false;
        }

        // Ignore if key is already held (prevents repeat-triggered recordings after errors)
        if *self.hold_key_down.lock() {
            return false;
        }

        if !check_mic_permission(app) {
            return false;
        }

        if let Err(e) = cloud::check_cloud_ready(app) {
            cloud::show_sign_in_required(app, &e);
            return false;
        }

        if !self.try_start_recording(RecordingMode::Hold) {
            return false;
        }

        {
            let mut origin = self.shortcut_origin.lock();
            if origin.is_none() {
                *origin = Some(ShortcutOrigin::Hold);
            }
        }

        let state = app.state::<AppState>();
        let settings = state.current_settings();

        match self.recorder.start(settings.microphone_device) {
            Ok(started) => {
                self.transition_to(app, PillStatus::Listening);
                emit_event(
                    app,
                    crate::EVENT_RECORDING_START,
                    crate::RecordingStartPayload {
                        started_at: started.to_rfc3339(),
                    },
                );
                check_accessibility_warning(app);
                true
            }
            Err(err) => {
                self.reset_recording_state();
                self.transition_to_error(app, &format!("Unable to start recording: {err}"));
                false
            }
        }
    }

    fn handle_hold_release(&self, app: &AppHandle<AppRuntime>) {
        if !self.clear_hold_state() {
            return;
        }

        if self.active_mode() != Some(RecordingMode::Hold) {
            return;
        }

        self.stop_and_process(app);
    }

    fn handle_toggle_press(&self, app: &AppHandle<AppRuntime>) {
        if self.status() == PillStatus::Processing {
            if *self.shortcut_origin.lock() == Some(ShortcutOrigin::Toggle) {
                self.cancel_processing(app);
            }
            return;
        }

        if self.active_mode() == Some(RecordingMode::Hold) {
            return;
        }

        if self.is_recording() {
            self.stop_and_process(app);
        } else {
            if !check_mic_permission(app) {
                return;
            }

            if let Err(e) = cloud::check_cloud_ready(app) {
                cloud::show_sign_in_required(app, &e);
                return;
            }

            if !self.try_start_recording(RecordingMode::Toggle) {
                return;
            }

            *self.shortcut_origin.lock() = Some(ShortcutOrigin::Toggle);

            let state = app.state::<AppState>();
            let settings = state.current_settings();

            match self.recorder.start(settings.microphone_device) {
                Ok(started) => {
                    self.transition_to(app, PillStatus::Listening);
                    emit_event(
                        app,
                        crate::EVENT_RECORDING_START,
                        crate::RecordingStartPayload {
                            started_at: started.to_rfc3339(),
                        },
                    );
                    check_accessibility_warning(app);
                }
                Err(err) => {
                    self.reset_recording_state();
                    self.transition_to_error(app, &format!("Unable to start recording: {err}"));
                }
            }
        }
    }

    fn handle_smart_press(&self, app: &AppHandle<AppRuntime>) {
        if self.status() == PillStatus::Processing {
            if *self.shortcut_origin.lock() == Some(ShortcutOrigin::Smart) {
                self.cancel_processing(app);
            }
            return;
        }

        if self.is_recording() && self.active_mode() == Some(RecordingMode::Toggle) {
            self.handle_toggle_press(app);
            return;
        }

        if self.active_mode() == Some(RecordingMode::Hold) {
            return;
        }

        // Only set state if recording actually starts (cloud check, permissions, etc. pass)
        if self.handle_hold_press(app) {
            *self.smart_press_time.lock() = Some(Local::now());
            *self.shortcut_origin.lock() = Some(ShortcutOrigin::Smart);
        }
    }

    fn handle_smart_release(&self, app: &AppHandle<AppRuntime>) {
        let press_time = self.smart_press_time.lock().take();

        if let Some(start_time) = press_time {
            let held_duration_ms = (Local::now() - start_time).num_milliseconds();

            if held_duration_ms < SMART_MODE_TAP_THRESHOLD_MS {
                if self.active_mode() == Some(RecordingMode::Hold) {
                    *self.hold_key_down.lock() = false;
                    *self.recording_mode.lock() = Some(RecordingMode::Toggle);
                }
                return;
            }

            self.handle_hold_release(app);
        }
    }

    fn stop_and_process(&self, app: &AppHandle<AppRuntime>) {
        match self.recorder.stop() {
            Ok(Some(recording)) => {
                let duration_ms = (recording.ended_at - recording.started_at).num_milliseconds();

                if duration_ms < MIN_RECORDING_DURATION_MS {
                    self.reset(app);
                    return;
                }

                *self.recording_mode.lock() = None;
                self.transition_to(app, PillStatus::Processing);

                emit_event(
                    app,
                    crate::EVENT_RECORDING_STOP,
                    crate::RecordingStopPayload {
                        ended_at: recording.ended_at.to_rfc3339(),
                    },
                );

                self.capture_selected_text_if_enabled(app);
                crate::persist_recording_async(app.clone(), recording);
            }
            Ok(None) => {
                self.reset(app);
            }
            Err(err) => {
                self.transition_to_error(app, &format!("Unable to stop recording: {err}"));
            }
        }
    }

    pub fn cancel(&self, app: &AppHandle<AppRuntime>) {
        if let Err(err) = self.recorder.stop() {
            eprintln!("Failed to stop recorder: {err}");
        }
        self.reset(app);
    }

    pub fn cancel_processing(&self, app: &AppHandle<AppRuntime>) {
        if self.status() != PillStatus::Processing {
            return;
        }

        let state = app.state::<AppState>();
        state.request_cancellation();
        let _ = self.recorder.stop();

        if let Some(path) = state.take_pending_path() {
            let _ = std::fs::remove_file(&path);
        }

        toast::show(app, "info", None, "Transcription cancelled");
        self.reset(app);
    }
}

fn check_mic_permission(app: &AppHandle<AppRuntime>) -> bool {
    #[cfg(target_os = "macos")]
    {
        let mic_granted = tauri::async_runtime::block_on(async {
            tauri_plugin_macos_permissions::check_microphone_permission().await
        });

        if !mic_granted {
            toast::show_with_action(
                app,
                "error",
                Some("Microphone"),
                "Microphone access required to record.",
                "open_microphone_settings",
                "Open Settings",
            );
            return false;
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = app;

    true
}

fn check_accessibility_warning(app: &AppHandle<AppRuntime>) {
    #[cfg(target_os = "macos")]
    {
        let is_trusted = permissions::check_accessibility_permission();
        if !is_trusted {
            toast::show_with_action(
                app,
                "warning",
                Some("Accessibility"),
                "Accessibility permissions missing.",
                "open_accessibility_settings",
                "Open Settings",
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn register_shortcuts(app: &AppHandle<AppRuntime>) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let manager = app.global_shortcut();

    if let Err(err) = manager.unregister_all() {
        eprintln!("Failed to clear shortcuts: {err}");
    }

    let settings = state.current_settings();

    if settings.smart_enabled {
        let smart_shortcut = settings.smart_shortcut.clone();
        manager.on_shortcut(smart_shortcut.as_str(), move |app, _shortcut, event| {
            let state = app.state::<AppState>();
            let pill = state.pill();
            match event.state {
                ShortcutState::Pressed => pill.handle_smart_press(app),
                ShortcutState::Released => pill.handle_smart_release(app),
            }
        })?;
    }

    let hold_keys: std::collections::HashSet<&str> = settings
        .hold_shortcut
        .split('+')
        .map(|s| s.trim())
        .collect();
    let toggle_keys: std::collections::HashSet<&str> = settings
        .toggle_shortcut
        .split('+')
        .map(|s| s.trim())
        .collect();
    let hold_is_subset_of_toggle =
        settings.hold_enabled && settings.toggle_enabled && hold_keys.is_subset(&toggle_keys);

    if settings.hold_enabled {
        let hold_shortcut = settings.hold_shortcut.clone();
        let check_toggle_overlap = hold_is_subset_of_toggle;
        let toggle_shortcut_clone = settings.toggle_shortcut.clone();

        manager.on_shortcut(hold_shortcut.as_str(), move |app, shortcut, event| {
            if check_toggle_overlap {
                let pressed_shortcut = shortcut.to_string();
                if pressed_shortcut.to_lowercase() == toggle_shortcut_clone.to_lowercase() {
                    return;
                }
            }

            let state = app.state::<AppState>();
            let pill = state.pill();
            match event.state {
                ShortcutState::Pressed => { let _ = pill.handle_hold_press(app); }
                ShortcutState::Released => pill.handle_hold_release(app),
            }
        })?;
    }

    if settings.toggle_enabled {
        let toggle_shortcut = settings.toggle_shortcut.clone();
        manager.on_shortcut(toggle_shortcut.as_str(), move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let state = app.state::<AppState>();
                let pill = state.pill();
                pill.handle_toggle_press(app);
            }
        })?;
    }

    Ok(())
}

pub fn show_overlay(app: &AppHandle<AppRuntime>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        position_overlay_on_cursor_screen(&window);
        platform::overlay::show(app, &window);
    }
}

pub fn hide_overlay(app: &AppHandle<AppRuntime>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        platform::overlay::hide(app, &window);
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
