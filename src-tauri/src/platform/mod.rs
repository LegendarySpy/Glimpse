pub mod overlay;
pub mod settings_window;
pub mod toast;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub mod windows;

/// True when this install's updates are owned by an app store
/// (MSIX from the Microsoft Store); the built-in updater stays off.
pub fn is_store_build() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows::store::is_msix_packaged()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}
