use crate::{
    emit_error, emit_event, hide_overlay, permissions, persist_recording_async, show_overlay,
    toast, AppRuntime, AppState, GlimpseResult, RecordingModePayload, RecordingStartPayload,
    RecordingStopPayload, EVENT_RECORDING_MODE_CHANGE, EVENT_RECORDING_START, EVENT_RECORDING_STOP,
};
use chrono;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const MIN_RECORDING_DURATION_MS: i64 = 300;
const SMART_MODE_TAP_THRESHOLD_MS: i64 = 200;

pub fn register_shortcuts(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    let state = app.state::<AppState>();
    let manager = app.global_shortcut();
    if let Err(err) = manager.unregister_all() {
        eprintln!("Failed to clear shortcuts: {err}");
    }

    let settings = state.current_settings();

    if settings.smart_enabled {
        let smart_shortcut = settings.smart_shortcut.clone();
        manager.on_shortcut(smart_shortcut.as_str(), move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Err(err) = handle_smart_shortcut_press(app) {
                    eprintln!("Smart shortcut press error: {err}");
                }
            } else if event.state == ShortcutState::Released {
                if let Err(err) = handle_smart_shortcut_release(app) {
                    eprintln!("Smart shortcut release error: {err}");
                }
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

    if settings.toggle_enabled {
        let toggle_shortcut = settings.toggle_shortcut.clone();
        manager.on_shortcut(toggle_shortcut.as_str(), move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Err(err) = handle_toggle_shortcut_press(app) {
                    eprintln!("Toggle shortcut press error: {err}");
                }
            }
        })?;
    }

    Ok(())
}

fn check_mic_blocking(app: &AppHandle<AppRuntime>) -> bool {
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
}

fn handle_hold_shortcut_press(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    if !check_mic_blocking(app) {
        return Ok(());
    }

    let state = app.state::<AppState>();

    if state.is_toggle_recording_active() || state.get_active_recording_mode().is_some() {
        return Ok(());
    }

    if state.mark_hold_shortcut_down() {
        return Ok(());
    }

    let settings = state.current_settings();
    match state.recorder().start(settings.microphone_device) {
        Ok(started) => {
            state.set_active_recording_mode(Some("hold"));
            show_overlay(app);
            emit_event(
                app,
                EVENT_RECORDING_MODE_CHANGE,
                RecordingModePayload {
                    mode: "hold".to_string(),
                },
            );
            emit_event(
                app,
                EVENT_RECORDING_START,
                RecordingStartPayload {
                    started_at: started.to_rfc3339(),
                },
            );
            check_accessibility_warning(app);
        }
        Err(err) => {
            state.clear_hold_shortcut_state();
            emit_error(app, format!("Unable to start recording: {err}"));
        }
    }

    Ok(())
}

fn handle_smart_shortcut_press(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    let state = app.state::<AppState>();

    if state.is_toggle_recording_active() {
        return handle_toggle_shortcut_press(app);
    }

    if state.get_active_recording_mode().as_deref() == Some("hold") {
        return Ok(());
    }

    state.set_smart_press_time(Some(chrono::Local::now()));
    handle_hold_shortcut_press(app)
}

fn handle_smart_shortcut_release(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    let state = app.state::<AppState>();

    let press_time = state.get_smart_press_time();
    state.set_smart_press_time(None);

    if let Some(start_time) = press_time {
        let now = chrono::Local::now();
        let held_duration_ms = (now - start_time).num_milliseconds();

        if held_duration_ms < SMART_MODE_TAP_THRESHOLD_MS {
            if state.get_active_recording_mode().as_deref() == Some("hold") {
                state.clear_hold_shortcut_state();
                state.set_toggle_recording_active(true);
                state.set_active_recording_mode(Some("toggle"));
                emit_event(
                    app,
                    EVENT_RECORDING_MODE_CHANGE,
                    RecordingModePayload {
                        mode: "toggle".to_string(),
                    },
                );
            }
            return Ok(());
        }

        handle_hold_shortcut_release(app)
    } else {
        Ok(())
    }
}

fn handle_hold_shortcut_release(app: &AppHandle<AppRuntime>) -> GlimpseResult<()> {
    let state = app.state::<AppState>();
    if !state.clear_hold_shortcut_state() {
        return Ok(());
    }

    if state.get_active_recording_mode().as_deref() != Some("hold") {
        return Ok(());
    }

    match state.recorder().stop() {
        Ok(Some(recording)) => {
            let duration_ms = (recording.ended_at - recording.started_at).num_milliseconds();

            if duration_ms < MIN_RECORDING_DURATION_MS {
                state.set_active_recording_mode(None);
                hide_overlay(app);
                return Ok(());
            }

            state.set_active_recording_mode(None);
            emit_event(
                app,
                EVENT_RECORDING_STOP,
                RecordingStopPayload {
                    ended_at: recording.ended_at.to_rfc3339(),
                },
            );
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

    if state.get_active_recording_mode().as_deref() == Some("hold") {
        return Ok(());
    }

    if state.is_toggle_recording_active() {
        state.set_toggle_recording_active(false);

        match state.recorder().stop() {
            Ok(Some(recording)) => {
                let duration_ms = (recording.ended_at - recording.started_at).num_milliseconds();

                if duration_ms < MIN_RECORDING_DURATION_MS {
                    state.set_active_recording_mode(None);
                    hide_overlay(app);
                    state.set_active_recording_mode(None);
                    return Ok(());
                }

                state.set_active_recording_mode(None);
                emit_event(
                    app,
                    EVENT_RECORDING_STOP,
                    RecordingStopPayload {
                        ended_at: recording.ended_at.to_rfc3339(),
                    },
                );
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
        if !check_mic_blocking(app) {
            return Ok(());
        }

        let settings = state.current_settings();
        match state.recorder().start(settings.microphone_device) {
            Ok(started) => {
                state.set_toggle_recording_active(true);
                state.set_active_recording_mode(Some("toggle"));
                show_overlay(app);
                emit_event(
                    app,
                    EVENT_RECORDING_MODE_CHANGE,
                    RecordingModePayload {
                        mode: "toggle".to_string(),
                    },
                );
                emit_event(
                    app,
                    EVENT_RECORDING_START,
                    RecordingStartPayload {
                        started_at: started.to_rfc3339(),
                    },
                );
                check_accessibility_warning(app);
            }
            Err(err) => {
                emit_error(app, format!("Unable to start recording: {err}"));
            }
        }
    }

    Ok(())
}
