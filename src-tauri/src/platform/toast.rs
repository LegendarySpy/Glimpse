use crate::AppRuntime;
use tauri::{AppHandle, WebviewWindow};

pub fn init(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    if let Err(err) = crate::platform::macos::toast::init(app, toast_window) {
        eprintln!("Failed to initialize macOS toast panel: {err}");
    }
}

pub fn show(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    if let Err(err) = crate::platform::macos::toast::show(app, toast_window) {
        eprintln!("Failed to show macOS toast panel: {err}");
    }
}

pub fn hide(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    if let Err(err) = crate::platform::macos::toast::hide(app, toast_window) {
        eprintln!("Failed to hide macOS toast panel: {err}");
    }
}
