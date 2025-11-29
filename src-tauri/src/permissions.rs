//! macOS permission checking for microphone and accessibility access.

use serde::Serialize;

/// Status of a permission request
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionStatus {
    /// Permission has been granted
    Granted,
    /// Permission has been denied by the user
    Denied,
    /// Permission has not been requested yet
    NotDetermined,
    /// Unable to determine permission status
    Unknown,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::PermissionStatus;
    use std::process::Command;

    /// Check microphone permission status on macOS.
    /// Returns Unknown since we can't reliably check without triggering the dialog.
    pub fn check_microphone_permission() -> PermissionStatus {
        // We can't reliably check microphone permission status without the TCC database
        // The safest approach is to return Unknown and let the UI handle it
        PermissionStatus::Unknown
    }

    /// Request microphone permission by triggering the system dialog.
    pub fn request_microphone_permission() -> PermissionStatus {
        // The actual permission request happens when the app tries to access the microphone
        // via cpal or getUserMedia. We return NotDetermined to indicate this.
        PermissionStatus::NotDetermined
    }

    /// Check if accessibility (AX) permission is granted.
    /// Uses AXIsProcessTrusted() from ApplicationServices framework.
    pub fn check_accessibility_permission() -> bool {
        // Try the native API first
        if let Some(result) = check_accessibility_native() {
            return result;
        }
        
        // Fallback: check via osascript (less reliable but works as backup)
        check_accessibility_osascript()
    }
    
    /// Native check using AXIsProcessTrusted
    fn check_accessibility_native() -> Option<bool> {
        // Link to the ApplicationServices framework
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn AXIsProcessTrusted() -> u8;
        }
        
        let result = unsafe { AXIsProcessTrusted() };
        eprintln!("[Glimpse] AXIsProcessTrusted() returned: {}", result);
        Some(result != 0)
    }
    
    /// Fallback check using osascript to test if we can send keystrokes
    fn check_accessibility_osascript() -> bool {
        // Try a simple AppleScript that requires accessibility
        let output = Command::new("osascript")
            .args(["-e", "tell application \"System Events\" to return 1"])
            .output();
        
        match output {
            Ok(result) => {
                let success = result.status.success();
                eprintln!("[Glimpse] Accessibility osascript check: {}", success);
                success
            }
            Err(_) => false,
        }
    }

    /// Open System Settings to the Accessibility privacy pane.
    pub fn open_accessibility_settings() -> Result<(), String> {
        // macOS 13+ uses the new System Settings app
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
}

#[cfg(not(target_os = "macos"))]
mod other {
    use super::PermissionStatus;

    pub fn check_microphone_permission() -> PermissionStatus {
        // On non-macOS platforms, assume granted (permissions handled differently)
        PermissionStatus::Granted
    }

    pub fn request_microphone_permission() -> PermissionStatus {
        PermissionStatus::Granted
    }

    pub fn check_accessibility_permission() -> bool {
        // Accessibility features may not be available on other platforms
        true
    }

    pub fn open_accessibility_settings() -> Result<(), String> {
        Err("Accessibility settings are only available on macOS".to_string())
    }

    pub fn open_microphone_settings() -> Result<(), String> {
        Err("Microphone settings are only available on macOS".to_string())
    }
}

// Re-export platform-specific implementations
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
pub use other::*;
