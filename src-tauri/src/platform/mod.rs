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

/// Distribution channel for analytics. macOS currently ships through GitHub;
/// packaged Windows builds are distributed through the Microsoft Store.
pub fn install_type() -> &'static str {
    install_type_for_store_build(is_store_build())
}

fn install_type_for_store_build(store_build: bool) -> &'static str {
    if store_build {
        "windows_store"
    } else {
        "github"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_type_distinguishes_store_and_github_builds() {
        assert_eq!(install_type_for_store_build(true), "windows_store");
        assert_eq!(install_type_for_store_build(false), "github");
    }
}
