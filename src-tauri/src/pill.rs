use crate::{
    assistive, cloud, emit_event, permissions, platform, recorder::RecorderManager, toast,
    AppRuntime, AppState, AudioSpectrumPayload, EVENT_AUDIO_SPECTRUM, MAIN_WINDOW_LABEL,
};
use chrono::{DateTime, Local};
use parking_lot::Mutex;
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::time::Duration;
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

const SPECTRUM_SIZE: usize = 512;
const SPECTRUM_BINS: usize = SPECTRUM_SIZE / 2;
const SPECTRUM_SMOOTHING: f32 = 0.8;
const SPECTRUM_MIN_DB: f32 = -100.0;
const SPECTRUM_MAX_DB: f32 = -30.0;

struct AudioSpectrumEmitter {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl AudioSpectrumEmitter {
    fn start(app: AppHandle<AppRuntime>, recorder: Arc<RecorderManager>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_signal = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let interval = Duration::from_millis(40);
            let mut planner = FftPlanner::<f32>::new();
            let fft = planner.plan_fft_forward(SPECTRUM_SIZE);
            let denom = (SPECTRUM_SIZE - 1) as f32;
            let window: Vec<f32> = (0..SPECTRUM_SIZE)
                .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / denom).cos())
                .collect();
            let mut buffer = vec![Complex { re: 0.0, im: 0.0 }; SPECTRUM_SIZE];
            let mut smoothed = vec![0.0f32; SPECTRUM_BINS];
            let mut bins = vec![0u8; SPECTRUM_BINS];

            while !stop_signal.load(Ordering::Relaxed) {
                if let Some(samples) = recorder.spectrum_snapshot() {
                    for (idx, sample) in samples.iter().enumerate() {
                        buffer[idx].re = sample * window[idx];
                        buffer[idx].im = 0.0;
                    }
                    fft.process(&mut buffer);

                    for idx in 0..SPECTRUM_BINS {
                        let magnitude = buffer[idx].norm() / SPECTRUM_SIZE as f32;
                        let db = 20.0 * magnitude.max(1e-10).log10();
                        let normalized =
                            ((db - SPECTRUM_MIN_DB) / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB))
                                .clamp(0.0, 1.0);
                        smoothed[idx] = smoothed[idx] * SPECTRUM_SMOOTHING
                            + normalized * (1.0 - SPECTRUM_SMOOTHING);
                        bins[idx] = (smoothed[idx] * 255.0).round().clamp(0.0, 255.0) as u8;
                    }
                } else {
                    for idx in 0..SPECTRUM_BINS {
                        smoothed[idx] *= SPECTRUM_SMOOTHING;
                        bins[idx] = (smoothed[idx] * 255.0).round().clamp(0.0, 255.0) as u8;
                    }
                }

                emit_event(
                    &app,
                    EVENT_AUDIO_SPECTRUM,
                    AudioSpectrumPayload { bins: bins.clone() },
                );
                std::thread::sleep(interval);
            }
        });
        Self {
            stop,
            handle: Some(handle),
        }
    }

    fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.handle.take();
    }
}

pub struct PillController {
    status: Mutex<PillStatus>,
    recording_mode: Mutex<Option<RecordingMode>>,
    smart_press_time: Mutex<Option<DateTime<Local>>>,
    hold_key_down: Mutex<bool>,
    shortcut_origin: Mutex<Option<ShortcutOrigin>>,
    recorder: Arc<RecorderManager>,
    audio_spectrum_emitter: Mutex<Option<AudioSpectrumEmitter>>,
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
            audio_spectrum_emitter: Mutex::new(None),
        }
    }

    pub fn status(&self) -> PillStatus {
        *self.status.lock()
    }

    pub fn recorder(&self) -> &RecorderManager {
        &self.recorder
    }

    fn start_audio_spectrum_emitter(&self, app: &AppHandle<AppRuntime>) {
        let mut emitter = self.audio_spectrum_emitter.lock();
        if emitter.is_some() {
            return;
        }
        *emitter = Some(AudioSpectrumEmitter::start(
            app.clone(),
            Arc::clone(&self.recorder),
        ));
    }

    fn stop_audio_spectrum_emitter(&self) {
        if let Some(emitter) = self.audio_spectrum_emitter.lock().take() {
            emitter.stop();
        }
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

    pub fn reset(&self, app: &AppHandle<AppRuntime>) {
        self.reset_recording_state();
        *self.hold_key_down.lock() = false;
        self.transition_to(app, PillStatus::Idle);
    }

    pub fn safe_reset(&self, app: &AppHandle<AppRuntime>) {
        if self.status() != PillStatus::Listening {
            self.reset(app);
        }
    }

    fn reset_recording_state(&self) {
        self.stop_audio_spectrum_emitter();
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

        if self.status() == PillStatus::Error {
            toast::hide(app);
            self.reset(app);
        }

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
                self.start_audio_spectrum_emitter(app);
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

        if self.status() == PillStatus::Error {
            toast::hide(app);
            self.reset(app);
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
                    self.start_audio_spectrum_emitter(app);
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

        // Smart mode delegates to `handle_hold_press` to start a hold-recording, but the origin
        // should still reflect the initiating shortcut (Smart). We pre-set the origin to prevent
        // `handle_hold_press` from assigning `Hold`, and roll back if recording doesn't start.
        let should_rollback_origin = {
            let mut origin = self.shortcut_origin.lock();
            if origin.is_none() {
                *origin = Some(ShortcutOrigin::Smart);
                true
            } else {
                false
            }
        };

        // Only set state if recording actually starts (cloud check, permissions, etc. pass)
        if self.handle_hold_press(app) {
            *self.smart_press_time.lock() = Some(Local::now());
            *self.shortcut_origin.lock() = Some(ShortcutOrigin::Smart);
        } else if should_rollback_origin {
            *self.shortcut_origin.lock() = None;
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
        self.stop_audio_spectrum_emitter();
        match self.recorder.stop() {
            Ok(Some(recording)) => {
                let duration_ms = (recording.ended_at - recording.started_at).num_milliseconds();

                if duration_ms < MIN_RECORDING_DURATION_MS {
                    self.reset(app);
                    return;
                }

                *self.recording_mode.lock() = None;
                self.transition_to(app, PillStatus::Processing);

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
        self.stop_audio_spectrum_emitter();
        if let Err(err) = self.recorder.stop() {
            eprintln!("Failed to stop recorder: {err}");
        }
        self.reset(app);
    }

    pub fn cancel_processing(&self, app: &AppHandle<AppRuntime>) {
        if self.status() != PillStatus::Processing {
            return;
        }

        self.stop_audio_spectrum_emitter();
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
                ShortcutState::Pressed => {
                    let _ = pill.handle_hold_press(app);
                }
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
