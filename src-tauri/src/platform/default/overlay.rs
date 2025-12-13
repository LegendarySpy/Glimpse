use crate::AppRuntime;
use tauri::WebviewWindow;

#[cfg(not(target_os = "macos"))]
pub fn init(_overlay_window: &WebviewWindow<AppRuntime>) {
    // No-op on non-macOS for now.
}

pub fn show(overlay_window: &WebviewWindow<AppRuntime>) {
    let _ = overlay_window.show();
}

pub fn hide(overlay_window: &WebviewWindow<AppRuntime>) {
    let _ = overlay_window.hide();
}
