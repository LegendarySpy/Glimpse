//! macOS permission checking for microphone, accessibility, and input monitoring access.

#[cfg(target_os = "macos")]
mod macos {
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    #[cfg(debug_assertions)]
    use tracing::debug;

    /// Check if accessibility (AX) permission is granted.
    /// Uses AXIsProcessTrusted() from ApplicationServices framework.
    pub fn check_accessibility_permission() -> bool {
        if let Some(result) = check_accessibility_native() {
            return result;
        }

        check_accessibility_osascript()
    }

    /// Native check using AXIsProcessTrusted
    fn check_accessibility_native() -> Option<bool> {
        #[link(name = "ApplicationServices", kind = "framework")]
        unsafe extern "C" {
            fn AXIsProcessTrusted() -> u8;
        }

        let result = unsafe { AXIsProcessTrusted() };
        Some(result != 0)
    }

    /// Fallback check using osascript to test if we can send keystrokes
    fn check_accessibility_osascript() -> bool {
        let output = Command::new("osascript")
            .args(["-e", "tell application \"System Events\" to return 1"])
            .output();

        match output {
            Ok(result) => {
                let success = result.status.success();
                #[cfg(debug_assertions)]
                debug!(success, "accessibility osascript permission check");
                success
            }
            Err(_) => false,
        }
    }

    /// Open System Settings to the Accessibility privacy pane.
    pub fn open_accessibility_settings() -> Result<(), String> {
        let result = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();

        match result {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("Failed to open System Settings: {}", e)),
        }
    }

    /// Open System Settings to the Microphone privacy pane.
    pub fn open_microphone_settings() -> Result<(), String> {
        let result = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn();

        match result {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("Failed to open System Settings: {}", e)),
        }
    }

    /// Check if microphone permission is granted. Preflights TCC over XPC, which can block.
    pub fn check_microphone_permission() -> bool {
        tauri::async_runtime::block_on(async {
            tauri_plugin_macos_permissions::check_microphone_permission().await
        })
    }

    static MICROPHONE_GRANTED: AtomicBool = AtomicBool::new(false);

    pub fn check_microphone_permission_cached() -> bool {
        if MICROPHONE_GRANTED.load(Ordering::Relaxed) {
            return true;
        }

        let granted = check_microphone_permission();
        if granted {
            MICROPHONE_GRANTED.store(true, Ordering::Relaxed);
        }
        granted
    }

    /// Re-queries TCC and updates the cache, so a revoked grant is picked up.
    pub fn refresh_microphone_permission() -> bool {
        let granted = check_microphone_permission();
        MICROPHONE_GRANTED.store(granted, Ordering::Relaxed);
        granted
    }

    /// Refreshes off the caller's thread, for hot paths that must not block.
    pub fn refresh_microphone_permission_detached() {
        std::thread::spawn(|| {
            let _ = refresh_microphone_permission();
        });
    }

    /// Request microphone permission from macOS.
    pub fn request_microphone_permission() -> Result<(), String> {
        tauri::async_runtime::block_on(async {
            tauri_plugin_macos_permissions::request_microphone_permission().await
        })
    }

    /// Open System Settings to the Input Monitoring privacy pane.
    pub fn open_input_monitoring_settings() -> Result<(), String> {
        let result = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            .spawn();

        match result {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("Failed to open System Settings: {}", e)),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod other {
    pub fn check_accessibility_permission() -> bool {
        true
    }

    pub fn open_accessibility_settings() -> Result<(), String> {
        Err("Accessibility settings are only available on macOS".to_string())
    }

    pub fn open_microphone_settings() -> Result<(), String> {
        Err("Microphone settings are only available on macOS".to_string())
    }

    pub fn check_microphone_permission() -> bool {
        true
    }

    pub fn request_microphone_permission() -> Result<(), String> {
        Ok(())
    }

    pub fn open_input_monitoring_settings() -> Result<(), String> {
        Err("Input Monitoring settings are only available on macOS".to_string())
    }
}

#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
pub use other::*;
