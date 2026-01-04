use crate::AppRuntime;
use tauri::{AppHandle, WebviewWindow};

pub fn init(app: &AppHandle<AppRuntime>, overlay_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    if let Err(err) = crate::platform::macos::overlay::init(app, overlay_window) {
        eprintln!("Failed to initialize macOS overlay panel: {err}");
    }
}

pub fn show(app: &AppHandle<AppRuntime>, overlay_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    if let Err(err) = crate::platform::macos::overlay::show(app, overlay_window) {
        eprintln!("Failed to show macOS overlay panel: {err}");
    }
}

pub fn hide(app: &AppHandle<AppRuntime>, overlay_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    if let Err(err) = crate::platform::macos::overlay::hide(app, overlay_window) {
        eprintln!("Failed to hide macOS overlay panel: {err}");
    }
}
