use crate::AppRuntime;
use tauri::WebviewWindow;

pub fn show(toast_window: &WebviewWindow<AppRuntime>) {
    let _ = toast_window.show();
}

pub fn hide(toast_window: &WebviewWindow<AppRuntime>) {
    let _ = toast_window.hide();
}
