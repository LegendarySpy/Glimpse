use crate::AppRuntime;
use tauri::{AppHandle, WebviewWindow};

pub fn init(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    {
        if let Err(err) = crate::platform::macos::toast::init(app, toast_window) {
            eprintln!("Failed to initialize macOS toast panel: {err}");
        }
    }

    let _ = app;
    let _ = toast_window;
}

pub fn show(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    {
        if crate::platform::macos::toast::show(app, toast_window).is_ok() {
            return;
        }
    }

    crate::platform::default::toast::show(toast_window);
}

pub fn hide(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) {
    #[cfg(target_os = "macos")]
    {
        if crate::platform::macos::toast::hide(app, toast_window).is_ok() {
            return;
        }
    }

    let _ = app;
    crate::platform::default::toast::hide(toast_window);
}
