use crate::AppRuntime;
use tauri::{AppHandle, WebviewWindow};

pub fn init(app: &AppHandle<AppRuntime>, overlay_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    {
        if let Err(err) = crate::platform::macos::overlay::init(app, overlay_window) {
            eprintln!("Failed to initialize macOS overlay panel: {err}");
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        crate::platform::default::overlay::init(overlay_window);
    }
}

pub fn show(app: &AppHandle<AppRuntime>, overlay_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    {
        if crate::platform::macos::overlay::show(app, overlay_window).is_ok() {
            return;
        }
    }

    let _ = app;
    crate::platform::default::overlay::show(overlay_window);
}

pub fn hide(app: &AppHandle<AppRuntime>, overlay_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    {
        if crate::platform::macos::overlay::hide(app, overlay_window).is_ok() {
            return;
        }
    }

    let _ = app;
    crate::platform::default::overlay::hide(overlay_window);
}
