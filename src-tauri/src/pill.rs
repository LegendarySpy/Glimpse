#[cfg(target_os = "macos")]
use crate::permissions;
use crate::{
    AppRuntime, AppState, AudioSpectrumPayload, EVENT_AUDIO_SPECTRUM, MAIN_WINDOW_LABEL, assistive,
    core::hotkeys::{self, HotkeyState},
    emit_event, model_manager, music, platform,
    recorder::RecorderManager,
    settings::{MediaAction, UserSettings},
    toast,
};
use chrono::{DateTime, Local};
use parking_lot::Mutex;
use rustfft::{FftPlanner, num_complex::Complex};
use serde::Serialize;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const MIN_RECORDING_DURATION_MS: i64 = 300;
const SMART_MODE_TAP_THRESHOLD_MS: i64 = 200;
const OVERLAY_HIDE_AFTER_IDLE_MS: u64 = 180;
const MAX_RECORDING_DURATION: Duration = Duration::from_secs(30 * 60);
const CAPTURE_ARM_DELAY: Duration = Duration::from_millis(280);
pub const EVENT_PILL_STATE: &str = "pill:state";
pub const EVENT_PILL_MODE: &str = "pill:mode";
pub const EVENT_PILL_HOVER: &str = "pill:hover";
pub(crate) const PILL_TONE_DEFAULT: &str = "default";
pub(crate) const PILL_TONE_CLEANUP: &str = "cleanup";

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

#[derive(Serialize, Clone)]
pub struct PillStatePayload {
    pub status: PillStatus,
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
                        let normalized = ((db - SPECTRUM_MIN_DB)
                            / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB))
                            .clamp(0.0, 1.0);
                        smoothed[idx] = smoothed[idx] * SPECTRUM_SMOOTHING
                            + normalized * (1.0 - SPECTRUM_SMOOTHING);
                        bins[idx] = (smoothed[idx] * 255.0).round().clamp(0.0, 255.0) as u8;
                    }

                    emit_event(
                        &app,
                        EVENT_AUDIO_SPECTRUM,
                        AudioSpectrumPayload { bins: bins.clone() },
                    );
                }
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
        if let Some(handle) = self.handle.take() {
            std::thread::spawn(move || {
                let _ = handle.join();
            });
        }
    }
}

#[derive(Serialize, Clone)]
pub struct PillHoverPayload {
    pub hovering: bool,
}

struct PillHoverEmitter {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl PillHoverEmitter {
    fn start(app: AppHandle<AppRuntime>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_signal = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let interval = Duration::from_millis(50);
            let mut last_emitted: Option<bool> = None;
            while !stop_signal.load(Ordering::Relaxed) {
                if let Some(hovering) = cursor_over_pill_window(&app)
                    && last_emitted != Some(hovering)
                {
                    last_emitted = Some(hovering);
                    emit_event(&app, EVENT_PILL_HOVER, PillHoverPayload { hovering });
                }
                std::thread::sleep(interval);
            }
            emit_event(&app, EVENT_PILL_HOVER, PillHoverPayload { hovering: false });
        });
        Self {
            stop,
            handle: Some(handle),
        }
    }

    fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            std::thread::spawn(move || {
                let _ = handle.join();
            });
        }
    }
}

fn cursor_over_pill_window(app: &AppHandle<AppRuntime>) -> Option<bool> {
    let window = app.get_webview_window(MAIN_WINDOW_LABEL)?;
    let cursor = window.cursor_position().ok()?;
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;

    let left = pos.x as f64;
    let top = pos.y as f64;
    let right = left + size.width as f64;
    let bottom = top + size.height as f64;

    Some(cursor.x >= left && cursor.x < right && cursor.y >= top && cursor.y < bottom)
}

pub struct PillController {
    status: Mutex<PillStatus>,
    recording_mode: Mutex<Option<RecordingMode>>,
    shortcut_origin: Mutex<Option<hotkeys::ShortcutAction>>,
    recording_options: Mutex<hotkeys::ShortcutOptions>,
    recording_settings: Mutex<Option<UserSettings>>,
    smart_press_time: Mutex<Option<DateTime<Local>>>,
    hold_key_down: Mutex<bool>,
    paused_media_session: Mutex<Option<music::MediaSession>>,
    recorder: Arc<RecorderManager>,
    audio_spectrum_emitter: Mutex<Option<AudioSpectrumEmitter>>,
    hover_emitter: Mutex<Option<PillHoverEmitter>>,
    recording_generation: AtomicU64,
    is_expanded: Mutex<bool>,
}

impl PillController {
    pub fn new(recorder: Arc<RecorderManager>) -> Self {
        Self {
            status: Mutex::new(PillStatus::Idle),
            recording_mode: Mutex::new(None),
            shortcut_origin: Mutex::new(None),
            recording_options: Mutex::new(hotkeys::ShortcutOptions::default()),
            recording_settings: Mutex::new(None),
            smart_press_time: Mutex::new(None),
            hold_key_down: Mutex::new(false),
            paused_media_session: Mutex::new(None),
            recorder,
            audio_spectrum_emitter: Mutex::new(None),
            hover_emitter: Mutex::new(None),
            recording_generation: AtomicU64::new(0),
            is_expanded: Mutex::new(false),
        }
    }

    pub fn status(&self) -> PillStatus {
        *self.status.lock()
    }

    pub fn set_expanded(&self, expanded: bool) {
        *self.is_expanded.lock() = expanded;
    }

    pub fn is_expanded(&self) -> bool {
        *self.is_expanded.lock()
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

    fn start_hover_emitter(&self, app: &AppHandle<AppRuntime>) {
        let mut emitter = self.hover_emitter.lock();
        if emitter.is_some() {
            return;
        }
        *emitter = Some(PillHoverEmitter::start(app.clone()));
    }

    fn stop_hover_emitter(&self) {
        if let Some(emitter) = self.hover_emitter.lock().take() {
            emitter.stop();
        }
    }

    fn start_streaming_session_if_supported(
        &self,
        app: &AppHandle<AppRuntime>,
        settings: &UserSettings,
    ) {
        let selected_model = crate::speech::selected_model(settings);
        if crate::remote_speech::is_remote_model(&selected_model)
            || !model_manager::is_streaming_model(&selected_model)
        {
            return;
        }

        if let Ok(ready) = model_manager::ensure_model_ready(app, &selected_model) {
            app.state::<AppState>().start_streaming_session(app, &ready);
        }
    }

    fn emit_state(&self, app: &AppHandle<AppRuntime>) {
        let status = *self.status.lock();

        if let Err(err) = app.emit(EVENT_PILL_STATE, PillStatePayload { status }) {
            tracing::error!("Failed to emit pill state: {err}");
        }
    }

    pub fn transition_to(&self, app: &AppHandle<AppRuntime>, new_status: PillStatus) {
        let previous = {
            let mut status = self.status.lock();
            if *status == new_status {
                return;
            }
            let previous = *status;
            *status = new_status;
            previous
        };

        self.update_overlay_visibility(app, previous, new_status);
        self.emit_state(app);
    }

    pub fn transition_to_error(&self, app: &AppHandle<AppRuntime>, message: &str) {
        let status = self.status();
        if matches!(status, PillStatus::Listening | PillStatus::Processing) {
            tracing::error!(
                "[Pill] Suppressing error during active recording ({status}): {message}"
            );
            return;
        }
        tracing::error!("[Pill] {message}");
        if let Err(err) = self.recorder.stop() {
            tracing::error!("[Pill] Failed to stop recorder during error transition: {err}");
        }
        self.resume_paused_media();
        self.reset_recording_state();
        self.set_hold_key_down(false);
        self.transition_to(app, PillStatus::Error);
        let simple_msg = simplify_recording_error(message);
        toast::show(app, "error", None, &simple_msg);
    }

    fn fail_recording_stop(&self, app: &AppHandle<AppRuntime>, message: &str) {
        tracing::error!("[Pill] {message}");
        let settings = app.state::<AppState>().current_settings();
        crate::analytics::track_recording_failed(
            app,
            "stop",
            crate::analytics::classify_failure_reason(message),
            microphone_input_kind(&settings),
        );
        self.resume_paused_media();
        self.reset_recording_state();
        self.set_hold_key_down(false);
        self.transition_to(app, PillStatus::Error);
        let simple_msg = simplify_recording_error(message);
        toast::show(app, "error", None, &simple_msg);
    }

    fn update_overlay_visibility(
        &self,
        app: &AppHandle<AppRuntime>,
        previous: PillStatus,
        next: PillStatus,
    ) {
        if next == PillStatus::Idle {
            let app_handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(OVERLAY_HIDE_AFTER_IDLE_MS));
                if app_handle.state::<AppState>().pill().status() == PillStatus::Idle {
                    app_handle.state::<AppState>().pill().stop_hover_emitter();
                    hide_overlay(&app_handle);
                }
            });
            return;
        }

        if previous == PillStatus::Idle {
            show_overlay(app);
            self.start_hover_emitter(app);
        }
    }

    pub fn reset(&self, app: &AppHandle<AppRuntime>) {
        self.reset_recording_state();
        self.set_hold_key_down(false);
        self.transition_to(app, PillStatus::Idle);
    }

    // Stop-processing cleanup should not invent a release event.
    // Reset/error paths clear this when the whole pill state is discarded.
    pub fn finish_processing(&self, app: &AppHandle<AppRuntime>) {
        let status = self.status();
        let recording = self.is_recording();
        let should_reset = match status {
            PillStatus::Processing => true,
            PillStatus::Listening => !recording,
            _ => false,
        };
        if should_reset {
            self.reset(app);
        }
    }

    fn pause_media_if_playing(&self, app: &AppHandle<AppRuntime>) {
        let settings = app.state::<AppState>().current_settings();
        let mode = match settings.media_action {
            MediaAction::Off => return,
            MediaAction::Pause => music::MediaMode::Pause,
            MediaAction::Duck10 => music::MediaMode::Duck(10),
            MediaAction::Duck25 => music::MediaMode::Duck(25),
            MediaAction::Duck50 => music::MediaMode::Duck(50),
            MediaAction::Duck75 => music::MediaMode::Duck(75),
        };
        let session = Some(music::engage(mode));
        *self.paused_media_session.lock() = session;
    }

    fn resume_paused_media(&self) {
        let session = self.paused_media_session.lock().take();
        music::disengage(session);
    }

    fn reset_recording_state(&self) {
        self.stop_audio_spectrum_emitter();
        *self.recording_mode.lock() = None;
        *self.shortcut_origin.lock() = None;
        *self.recording_options.lock() = hotkeys::ShortcutOptions::default();
        *self.recording_settings.lock() = None;
        *self.smart_press_time.lock() = None;
    }

    fn capture_selected_text_if_enabled(
        &self,
        app: &AppHandle<AppRuntime>,
        settings: &UserSettings,
    ) {
        let state = app.state::<AppState>();

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

    fn try_start_recording(
        &self,
        mode: RecordingMode,
        origin: hotkeys::ShortcutAction,
        options: hotkeys::ShortcutOptions,
    ) -> bool {
        let mut current_mode = self.recording_mode.lock();
        if current_mode.is_some() {
            return false;
        }
        *current_mode = Some(mode);
        *self.shortcut_origin.lock() = Some(origin);
        *self.recording_options.lock() = options;
        if mode == RecordingMode::Hold {
            self.set_hold_key_down(true);
        }
        true
    }

    fn set_hold_key_down(&self, is_down: bool) {
        *self.hold_key_down.lock() = is_down;
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

    fn prepare_shortcut_press(
        &self,
        app: &AppHandle<AppRuntime>,
        action: hotkeys::ShortcutAction,
    ) -> bool {
        if self.status() == PillStatus::Idle {
            let _ = self.recording_mode.lock().take();
            let _ = self.shortcut_origin.lock().take();
            *self.recording_options.lock() = hotkeys::ShortcutOptions::default();
            self.set_hold_key_down(false);
            let _ = self.smart_press_time.lock().take();
        }

        if self.status() == PillStatus::Processing {
            if *self.shortcut_origin.lock() == Some(action) {
                self.cancel_processing(app);
            }
            return false;
        }

        self.reset_stale_listening_state(app);

        if self.status() == PillStatus::Error {
            toast::hide(app);
            self.reset(app);
        }

        true
    }

    fn start_recording(
        &self,
        app: &AppHandle<AppRuntime>,
        mode: RecordingMode,
        origin: hotkeys::ShortcutAction,
        options: hotkeys::ShortcutOptions,
    ) -> bool {
        if !check_mic_permission(app) {
            return false;
        }

        if !self.try_start_recording(mode, origin, options) {
            return false;
        }

        let state = app.state::<AppState>();
        state.clear_cancellation();
        let mut settings = state.current_settings();
        settings.cleanup_enabled = options.cleanup_enabled;
        *self.recording_settings.lock() = Some(settings.clone());

        crate::speech::warm(app, &settings);

        let generation = self.recording_generation.fetch_add(1, Ordering::SeqCst) + 1;
        // Enter Listening before the device opens for fast visual feedback.
        self.transition_to(app, PillStatus::Listening);

        let pending_dir = crate::recordings_root(app)
            .ok()
            .map(|root| root.join(crate::recorder::PENDING_DIR_NAME));
        match self
            .recorder
            .start(settings.microphone_device.clone(), pending_dir)
        {
            Ok(started) => {
                // The gate above trusts a cached grant; re-check now that the
                // keypress is served, so a revoked grant is caught next press.
                #[cfg(target_os = "macos")]
                permissions::refresh_microphone_permission_detached();

                self.arm_capture_after_settle(app, generation);
                self.start_audio_spectrum_emitter(app);
                self.pause_media_if_playing(app);
                self.start_streaming_session_if_supported(app, &settings);
                self.spawn_recording_cap(app, generation);

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
                crate::analytics::track_recording_failed(
                    app,
                    "start",
                    crate::analytics::classify_failure_reason(&err.to_string()),
                    microphone_input_kind(&settings),
                );
                self.reset_recording_state();
                self.set_hold_key_down(false);
                // Drop out of Listening so transition_to_error isn't suppressed.
                self.transition_to(app, PillStatus::Idle);

                if handle_revoked_mic_permission(app) {
                    return false;
                }

                self.transition_to_error(app, &format!("Unable to start recording: {err}"));
                false
            }
        }
    }

    fn after_delay_if_recording(
        app: &AppHandle<AppRuntime>,
        generation: u64,
        delay: Duration,
        action: impl FnOnce(&Self, &AppHandle<AppRuntime>) + Send + 'static,
    ) {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            let state = app.state::<AppState>();
            let pill = state.pill();
            if pill.recording_generation.load(Ordering::SeqCst) == generation && pill.is_recording()
            {
                action(pill, &app);
            }
        });
    }

    fn spawn_recording_cap(&self, app: &AppHandle<AppRuntime>, generation: u64) {
        Self::after_delay_if_recording(app, generation, MAX_RECORDING_DURATION, |pill, app| {
            if pill.status() == PillStatus::Listening {
                pill.stop_and_process(app);
            }
        });
    }

    fn arm_capture_after_settle(&self, app: &AppHandle<AppRuntime>, generation: u64) {
        Self::after_delay_if_recording(app, generation, CAPTURE_ARM_DELAY, |pill, _| {
            pill.recorder().arm();
        });
    }

    fn reset_stale_listening_state(&self, app: &AppHandle<AppRuntime>) {
        if self.status() == PillStatus::Listening && !self.is_recording() {
            self.reset(app);
        }
    }

    fn handle_hold_press(
        &self,
        app: &AppHandle<AppRuntime>,
        origin: hotkeys::ShortcutAction,
        options: hotkeys::ShortcutOptions,
    ) -> bool {
        if !self.prepare_shortcut_press(app, origin) {
            return false;
        }

        self.start_recording(app, RecordingMode::Hold, origin, options)
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

    fn handle_toggle_press(&self, app: &AppHandle<AppRuntime>, options: hotkeys::ShortcutOptions) {
        let origin = hotkeys::ShortcutAction::Toggle;
        if !self.prepare_shortcut_press(app, origin) {
            return;
        }

        if self.active_mode() == Some(RecordingMode::Hold) {
            return;
        }

        if self.is_recording() {
            self.stop_and_process(app);
        } else {
            self.start_recording(app, RecordingMode::Toggle, origin, options);
        }
    }

    fn handle_smart_press(&self, app: &AppHandle<AppRuntime>, options: hotkeys::ShortcutOptions) {
        let press_time = Local::now();

        let origin = hotkeys::ShortcutAction::Smart;
        if !self.prepare_shortcut_press(app, origin) {
            return;
        }

        if self.is_recording() && self.active_mode() == Some(RecordingMode::Toggle) {
            self.handle_toggle_press(app, options);
            return;
        }

        if self.active_mode() == Some(RecordingMode::Hold) {
            return;
        }

        if self.handle_hold_press(app, origin, options) {
            *self.smart_press_time.lock() = Some(press_time);
        }
    }

    fn handle_smart_release(&self, app: &AppHandle<AppRuntime>) {
        let press_time = self.smart_press_time.lock().take();

        if let Some(start_time) = press_time {
            let held_duration_ms = (Local::now() - start_time).num_milliseconds();

            if held_duration_ms < SMART_MODE_TAP_THRESHOLD_MS {
                if self.active_mode() == Some(RecordingMode::Hold) {
                    self.set_hold_key_down(false);
                    *self.recording_mode.lock() = Some(RecordingMode::Toggle);
                }
                return;
            }

            self.handle_hold_release(app);
        }
    }

    fn stop_and_process(&self, app: &AppHandle<AppRuntime>) {
        self.stop_audio_spectrum_emitter();
        *self.recording_mode.lock() = None;
        let settings = self
            .recording_settings
            .lock()
            .take()
            .unwrap_or_else(|| app.state::<AppState>().current_settings());
        let recording_options = *self.recording_options.lock();
        self.capture_selected_text_if_enabled(app, &settings);

        let state = app.state::<AppState>();
        let has_streaming = state.has_streaming_session();
        // Create the cancellation token up front, before the worker spawns, so a
        // rapid cancel can't slip in before the token exists and leak a paste.
        let cancel_token = state.create_transcription_token();

        if has_streaming {
            self.transition_to(app, PillStatus::Processing);
            let recorder = Arc::clone(&self.recorder);
            let app_handle = app.clone();
            let resume_app = app_handle.clone();
            let settings_for_transcription = settings.clone();
            std::thread::spawn(move || {
                let streaming_transcript = app_handle
                    .state::<AppState>()
                    .stop_streaming_session(&app_handle)
                    .unwrap_or_default();
                match recorder.stop_after_capture(move || {
                    resume_app.state::<AppState>().pill().resume_paused_media();
                }) {
                    Ok(Some(recording)) => {
                        let duration_ms =
                            (recording.ended_at - recording.started_at).num_milliseconds();

                        if duration_ms < MIN_RECORDING_DURATION_MS {
                            crate::analytics::track_dictation_discarded(&app_handle, "too_short");
                            discard_pending_recording(&recording);
                            collapse_expanded_pill(&app_handle);
                            app_handle
                                .state::<AppState>()
                                .pill()
                                .finish_processing(&app_handle);
                            return;
                        }

                        // Streaming can miss very short utterances (model
                        // lookahead + final-chunk latency); fall back to
                        // batch transcription of the captured audio.
                        if streaming_transcript.trim().is_empty() {
                            collapse_expanded_pill(&app_handle);
                            crate::persist_recording_async(
                                app_handle,
                                recording,
                                settings_for_transcription,
                                recording_options.temporary,
                                cancel_token,
                            );
                            return;
                        }

                        let saved = match crate::recordings_root(&app_handle).and_then(|base_dir| {
                            crate::recorder::persist_recording(base_dir, &recording)
                        }) {
                            Ok(saved) => saved,
                            Err(err) => {
                                collapse_expanded_pill(&app_handle);
                                app_handle.state::<AppState>().pill().fail_recording_stop(
                                    &app_handle,
                                    &format!("Unable to save recording: {err}"),
                                );
                                return;
                            }
                        };
                        app_handle
                            .state::<AppState>()
                            .set_pending_path(Some(saved.path.clone()));

                        crate::transcribe::finalize_streaming_transcription(
                            &app_handle,
                            crate::transcribe::StreamingTranscriptionInput {
                                raw_transcript: streaming_transcript,
                                duration_seconds: (duration_ms.max(0) as f32) / 1000.0,
                                audio_path: saved.path,
                                pending_path: saved.pending_path,
                                settings: settings_for_transcription,
                                temporary: recording_options.temporary,
                                cancel_token,
                            },
                        );
                    }
                    Ok(None) => {
                        collapse_expanded_pill(&app_handle);
                        app_handle
                            .state::<AppState>()
                            .pill()
                            .finish_processing(&app_handle);
                    }
                    Err(err) => {
                        collapse_expanded_pill(&app_handle);
                        app_handle.state::<AppState>().pill().fail_recording_stop(
                            &app_handle,
                            &format!("Unable to stop recording: {err}"),
                        );
                    }
                }
            });
        } else {
            self.transition_to(app, PillStatus::Processing);
            let recorder = Arc::clone(&self.recorder);
            let app_handle = app.clone();
            let resume_app = app_handle.clone();
            let settings_for_transcription = settings.clone();
            std::thread::spawn(move || {
                match recorder.stop_after_capture(move || {
                    resume_app.state::<AppState>().pill().resume_paused_media();
                }) {
                    Ok(Some(recording)) => {
                        let duration_ms =
                            (recording.ended_at - recording.started_at).num_milliseconds();
                        if duration_ms < MIN_RECORDING_DURATION_MS {
                            crate::analytics::track_dictation_discarded(&app_handle, "too_short");
                            discard_pending_recording(&recording);
                            app_handle
                                .state::<AppState>()
                                .pill()
                                .finish_processing(&app_handle);
                            return;
                        }

                        crate::persist_recording_async(
                            app_handle,
                            recording,
                            settings_for_transcription,
                            recording_options.temporary,
                            cancel_token,
                        );
                    }
                    Ok(None) => {
                        app_handle
                            .state::<AppState>()
                            .pill()
                            .finish_processing(&app_handle);
                    }
                    Err(err) => {
                        app_handle.state::<AppState>().pill().fail_recording_stop(
                            &app_handle,
                            &format!("Unable to stop recording: {err}"),
                        );
                    }
                }
            });
        }
    }

    pub fn cancel(&self, app: &AppHandle<AppRuntime>) {
        self.stop_audio_spectrum_emitter();
        let _ = app.state::<AppState>().stop_streaming_session(app);
        collapse_expanded_pill(app);
        let app_handle = app.clone();
        if let Err(err) = self
            .recorder
            .stop_after_capture_and_discard_pending(move || {
                app_handle.state::<AppState>().pill().resume_paused_media();
            })
        {
            self.resume_paused_media();
            tracing::error!("Failed to stop recorder: {err}");
        }
        self.reset(app);
    }

    pub fn cancel_processing(&self, app: &AppHandle<AppRuntime>) {
        if self.status() != PillStatus::Processing {
            return;
        }

        self.stop_audio_spectrum_emitter();
        let state = app.state::<AppState>();
        let _ = state.stop_streaming_session(app);
        collapse_expanded_pill(app);
        state.request_cancellation();
        let app_handle = app.clone();
        if let Err(err) = self
            .recorder
            .stop_after_capture_and_discard_pending(move || {
                app_handle.state::<AppState>().pill().resume_paused_media();
            })
        {
            self.resume_paused_media();
            tracing::error!("Failed to stop recorder: {err}");
        }

        if let Some(path) = state.take_pending_path() {
            let _ = std::fs::remove_file(&path);
        }

        toast::show(app, "info", None, "Transcription cancelled");
        self.reset(app);
    }
}

pub(crate) fn emit_pill_mode(app: &AppHandle<AppRuntime>, expanded: bool, text: &str) {
    emit_pill_mode_with_tone(app, expanded, text, PILL_TONE_DEFAULT);
}

pub(crate) fn emit_pill_mode_with_tone(
    app: &AppHandle<AppRuntime>,
    expanded: bool,
    text: &str,
    tone: &str,
) {
    app.state::<AppState>().pill().set_expanded(expanded);

    if let Err(err) = app.emit(
        EVENT_PILL_MODE,
        serde_json::json!({ "expanded": expanded, "text": text, "tone": tone }),
    ) {
        tracing::error!("Failed to emit pill mode: {err}");
    }
}

pub(crate) fn collapse_expanded_pill(app: &AppHandle<AppRuntime>) {
    emit_pill_mode(app, false, "");
}

fn discard_pending_recording(recording: &crate::recorder::CompletedRecording) {
    if let Some(path) = recording.pending_path.as_deref() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(target_os = "macos")]
fn show_microphone_permission_toast(app: &AppHandle<AppRuntime>) {
    toast::show_with_action(
        app,
        "error",
        Some("Microphone"),
        "Allow microphone access, then try again.",
        "open_microphone_settings",
        "Open Settings",
    );
}

#[cfg(target_os = "macos")]
fn handle_revoked_mic_permission(app: &AppHandle<AppRuntime>) -> bool {
    if permissions::refresh_microphone_permission() {
        return false;
    }

    show_microphone_permission_toast(app);
    true
}

#[cfg(not(target_os = "macos"))]
fn handle_revoked_mic_permission(_app: &AppHandle<AppRuntime>) -> bool {
    false
}

fn check_mic_permission(app: &AppHandle<AppRuntime>) -> bool {
    #[cfg(target_os = "macos")]
    {
        if permissions::check_microphone_permission_cached() {
            return true;
        }

        if let Err(err) = permissions::request_microphone_permission() {
            tracing::error!("Failed to request microphone permission: {err}");
        }

        if !permissions::refresh_microphone_permission() {
            show_microphone_permission_toast(app);
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

fn shortcuts_paused(app: &AppHandle<AppRuntime>) -> bool {
    let state = app.state::<AppState>();
    state.is_shortcut_capture_active()
}

pub(crate) fn handle_registered_hotkey_event(
    app: &AppHandle<AppRuntime>,
    action: hotkeys::ShortcutAction,
    state: HotkeyState,
    options: hotkeys::ShortcutOptions,
) {
    if shortcuts_paused(app) {
        return;
    }

    let app_state = app.state::<AppState>();
    let pill = app_state.pill();

    match action {
        hotkeys::ShortcutAction::Smart => match state {
            HotkeyState::Pressed => pill.handle_smart_press(app, options),
            HotkeyState::Released => pill.handle_smart_release(app),
        },
        hotkeys::ShortcutAction::Hold => match state {
            HotkeyState::Pressed => {
                let _ = pill.handle_hold_press(app, action, options);
            }
            HotkeyState::Released => pill.handle_hold_release(app),
        },
        hotkeys::ShortcutAction::Toggle => {
            if state == HotkeyState::Pressed {
                pill.handle_toggle_press(app, options);
            }
        }
    }
}

pub fn register_shortcuts(app: &AppHandle<AppRuntime>) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    if state.is_shortcut_capture_active() {
        return Ok(());
    }

    let settings = state.current_settings();
    let mut parsed_shortcuts: Vec<(&'static str, hotkeys::Hotkey)> = Vec::new();
    let mut bindings = Vec::new();

    let mut add_binding = |label: &'static str,
                           enabled: bool,
                           raw_shortcut: &str,
                           action: hotkeys::ShortcutAction,
                           options: hotkeys::ShortcutOptions| {
        if !enabled {
            return;
        }

        let hotkey = match hotkeys::parse_shortcut(raw_shortcut) {
            Ok(hotkey) => hotkey,
            Err(err) => {
                tracing::error!("Skipping invalid {label} shortcut `{raw_shortcut}`: {err}");
                return;
            }
        };
        if let Err(err) = hotkeys::validate_recording_shortcut(&hotkey) {
            tracing::error!("Skipping unsupported {label} shortcut `{raw_shortcut}`: {err}");
            return;
        }

        if let Some((existing_label, existing_hotkey)) = parsed_shortcuts
            .iter()
            .find(|(_, existing_hotkey)| hotkeys::shortcuts_conflict(existing_hotkey, &hotkey))
        {
            let existing_shortcut = existing_hotkey.to_string();
            tracing::error!(
                "Skipping {label} shortcut `{raw_shortcut}` because it conflicts with {existing_label} shortcut `{existing_shortcut}`"
            );
            return;
        }

        parsed_shortcuts.push((label, hotkey));
        bindings.push(hotkeys::RegisteredHotkey {
            hotkey,
            action,
            options,
        });
    };

    for binding in &settings.shortcut_bindings.smart {
        add_binding(
            "Smart",
            settings.smart_enabled,
            &binding.shortcut,
            hotkeys::ShortcutAction::Smart,
            hotkeys::ShortcutOptions {
                temporary: binding.temporary,
                cleanup_enabled: binding.cleanup_enabled,
            },
        );
    }
    for binding in &settings.shortcut_bindings.hold {
        add_binding(
            "Hold",
            settings.hold_enabled,
            &binding.shortcut,
            hotkeys::ShortcutAction::Hold,
            hotkeys::ShortcutOptions {
                temporary: binding.temporary,
                cleanup_enabled: binding.cleanup_enabled,
            },
        );
    }
    for binding in &settings.shortcut_bindings.toggle {
        add_binding(
            "Toggle",
            settings.toggle_enabled,
            &binding.shortcut,
            hotkeys::ShortcutAction::Toggle,
            hotkeys::ShortcutOptions {
                temporary: binding.temporary,
                cleanup_enabled: binding.cleanup_enabled,
            },
        );
    }

    state.hotkeys.replace_registrations(app, bindings)
}

pub fn show_overlay(app: &AppHandle<AppRuntime>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        position_overlay_on_cursor_screen(&window);
        platform::overlay::show(app, &window);
        if !app.state::<AppState>().pill().is_expanded() {
            collapse_expanded_pill(app);
        }
    }
}

pub fn hide_overlay(app: &AppHandle<AppRuntime>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        platform::overlay::hide(app, &window);
    }
}

fn position_overlay(window: &WebviewWindow<AppRuntime>) {
    if let Ok(Some(monitor)) = window.current_monitor()
        && let Ok(size) = window.outer_size()
    {
        let scale_factor = monitor.scale_factor();
        let screen = monitor.size();
        let mon_pos = monitor.position();
        let x = mon_pos.x + (screen.width.saturating_sub(size.width) / 2) as i32;
        let bottom_padding_physical = (85.0 * scale_factor) as i32;
        let y = mon_pos.y + screen.height as i32 - size.height as i32 - bottom_padding_physical;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
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
        let scale_factor = monitor.scale_factor();
        let mon_pos = monitor.position();
        let mon_size = monitor.size();
        let x = mon_pos.x + ((mon_size.width.saturating_sub(size.width)) / 2) as i32;
        let bottom_padding_physical = (85.0 * scale_factor) as i32;
        let y = mon_pos.y + mon_size.height as i32 - size.height as i32 - bottom_padding_physical;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

fn microphone_input_kind(settings: &UserSettings) -> &'static str {
    if settings.microphone_device.is_some() {
        "selected"
    } else {
        "default"
    }
}

/// Simplifies recording error messages
fn simplify_recording_error(message: &str) -> String {
    let msg_lower = message.to_lowercase();

    if msg_lower.contains("permission")
        || msg_lower.contains("not allowed")
        || msg_lower.contains("access denied")
        || msg_lower.contains("coreaudio")
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
