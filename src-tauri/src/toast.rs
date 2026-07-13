use crate::{AppRuntime, AppState, pill};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, WebviewWindow};

pub const WINDOW_LABEL: &str = "toast";
pub const EVENT_SHOW: &str = "toast:show";
pub const EVENT_HIDE: &str = "toast:hide";

#[derive(Serialize, Clone)]
pub struct Payload {
    #[serde(rename = "type")]
    pub toast_type: String,
    pub title: Option<String>,
    pub message: String,
    #[serde(rename = "autoDismiss")]
    pub auto_dismiss: Option<bool>,
    pub duration: Option<u64>,
    #[serde(rename = "retryId")]
    pub retry_id: Option<String>,
    #[serde(rename = "mode")]
    pub mode: Option<String>,
    pub action: Option<String>,
    #[serde(rename = "actionLabel")]
    pub action_label: Option<String>,
    #[serde(rename = "secondaryAction")]
    pub secondary_action: Option<String>,
    #[serde(rename = "secondaryActionLabel")]
    pub secondary_action_label: Option<String>,
}

pub fn emit_toast(app: &AppHandle<AppRuntime>, payload: Payload) {
    if let Some(toast_window) = app.get_webview_window(WINDOW_LABEL) {
        position_toast_window(app, &toast_window);
        crate::platform::toast::show(app, &toast_window);
    }
    let _ = app.emit(EVENT_SHOW, payload);
}

pub fn show(app: &AppHandle<AppRuntime>, toast_type: &str, title: Option<&str>, message: &str) {
    emit_toast(
        app,
        Payload {
            toast_type: toast_type.to_string(),
            title: title.map(String::from),
            message: message.to_string(),
            auto_dismiss: None,
            duration: None,
            retry_id: None,
            mode: None,
            action: None,
            action_label: None,
            secondary_action: None,
            secondary_action_label: None,
        },
    );
}

pub fn show_with_action(
    app: &AppHandle<AppRuntime>,
    toast_type: &str,
    title: Option<&str>,
    message: &str,
    action: &str,
    action_label: &str,
) {
    emit_toast(
        app,
        Payload {
            toast_type: toast_type.to_string(),
            title: title.map(String::from),
            message: message.to_string(),
            auto_dismiss: None,
            duration: None,
            retry_id: None,
            mode: None,
            action: Some(action.to_string()),
            action_label: Some(action_label.to_string()),
            secondary_action: None,
            secondary_action_label: None,
        },
    );
}

pub fn hide(app: &AppHandle<AppRuntime>) {
    let _ = app.emit(EVENT_HIDE, ());

    // Best-effort: also hide the toast surface at the platform level.
    if let Some(toast_window) = app.get_webview_window(WINDOW_LABEL) {
        crate::platform::toast::hide(app, &toast_window);
    }
}

fn position_toast_window(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) {
    let state = app.state::<AppState>();
    let is_expanded = state.pill().is_expanded();
    let pill_is_visible = state.pill().status() != pill::PillStatus::Idle;
    let base_margin = if is_expanded { 380.0 } else { 300.0 };

    let Some(monitor) = target_toast_monitor(app, toast_window, pill_is_visible) else {
        return;
    };

    let scale_factor = monitor.scale_factor();
    let toast_width = (420.0 * scale_factor) as i32;
    let bottom_margin = (base_margin * scale_factor) as i32;

    let screen = monitor.size();
    let mon_pos = monitor.position();
    let x = mon_pos.x + (screen.width as i32 - toast_width) / 2;
    let y = mon_pos.y + screen.height as i32 - bottom_margin;
    let _ = toast_window.set_position(tauri::PhysicalPosition::new(x, y));
}

fn target_toast_monitor(
    app: &AppHandle<AppRuntime>,
    toast_window: &WebviewWindow<AppRuntime>,
    pill_is_visible: bool,
) -> Option<Monitor> {
    if pill_is_visible {
        app.get_webview_window(crate::MAIN_WINDOW_LABEL)
            .and_then(|pill_window| pill_window.current_monitor().ok().flatten())
            .or_else(|| monitor_containing_cursor(toast_window))
            .or_else(|| toast_window.current_monitor().ok().flatten())
    } else {
        monitor_containing_cursor(toast_window)
            .or_else(|| toast_window.current_monitor().ok().flatten())
    }
}

fn monitor_containing_cursor(window: &WebviewWindow<AppRuntime>) -> Option<Monitor> {
    let cursor_pos = window.cursor_position().ok()?;
    window
        .available_monitors()
        .ok()?
        .into_iter()
        .find(|monitor| {
            let pos = monitor.position();
            let size = monitor.size();
            cursor_pos.x >= pos.x as f64
                && cursor_pos.x < (pos.x + size.width as i32) as f64
                && cursor_pos.y >= pos.y as f64
                && cursor_pos.y < (pos.y + size.height as i32) as f64
        })
}

#[tauri::command]
pub fn toast_dismissed(app: AppHandle<AppRuntime>) {
    crate::auto_dictionary::clear_pending_suggestion();

    let state = app.state::<AppState>();
    if state.pill().status() == pill::PillStatus::Error {
        state.pill().reset(&app);
    }
    hide(&app);
}

#[tauri::command]
pub fn debug_show_toast(
    toast_type: String,
    message: String,
    action: Option<String>,
    action_label: Option<String>,
    app: AppHandle<AppRuntime>,
) {
    emit_toast(
        &app,
        Payload {
            toast_type,
            title: None,
            message,
            auto_dismiss: Some(true),
            duration: Some(8000),
            retry_id: None,
            mode: None,
            action,
            action_label,
            secondary_action: None,
            secondary_action_label: None,
        },
    );
}

#[allow(dead_code)]
#[tauri::command]
pub fn show_celebration_toast(app: AppHandle<AppRuntime>) {
    emit_toast(
        &app,
        Payload {
            toast_type: "celebration".to_string(),
            title: Some("Upgrade Complete!".to_string()),
            message: "Welcome to Glimpse Cloud!".to_string(),
            auto_dismiss: Some(true),
            duration: Some(6000),
            retry_id: None,
            mode: None,
            action: None,
            action_label: None,
            secondary_action: None,
            secondary_action_label: None,
        },
    );
}
