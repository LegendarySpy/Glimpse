use crate::AppRuntime;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

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
        },
    );
}

#[allow(dead_code)]
pub fn show_with_options(
    app: &AppHandle<AppRuntime>,
    toast_type: &str,
    title: Option<&str>,
    message: &str,
    auto_dismiss: Option<bool>,
    duration: Option<u64>,
) {
    emit_toast(
        app,
        Payload {
            toast_type: toast_type.to_string(),
            title: title.map(String::from),
            message: message.to_string(),
            auto_dismiss,
            duration,
            retry_id: None,
            mode: None,
            action: None,
            action_label: None,
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
        },
    );
}

#[allow(dead_code)]
pub fn hide(app: &AppHandle<AppRuntime>) {
    let _ = app.emit(EVENT_HIDE, ());

    // Best-effort: also hide the toast surface at the platform level.
    if let Some(toast_window) = app.get_webview_window(WINDOW_LABEL) {
        crate::platform::toast::hide(app, &toast_window);
    }
}

fn position_toast_window(_app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) {
    let scale_factor = toast_window.scale_factor().unwrap_or(1.0);
    let toast_width = (320.0 * scale_factor) as i32;
    let bottom_margin = (200.0 * scale_factor) as i32;

    if let Ok(Some(monitor)) = toast_window.current_monitor() {
        let screen = monitor.size();
        let x = (screen.width as i32 - toast_width) / 2;
        let y = screen.height as i32 - bottom_margin;
        let _ = toast_window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}
