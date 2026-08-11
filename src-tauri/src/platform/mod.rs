use std::fs;
use std::io;
use std::path::Path;

pub mod overlay;
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

/// `std::fs::remove_dir_all` deletes through handle-based NT calls that the
/// MSIX file system filter can reject, so Store builds fail to remove
/// directories. `remove_file` and `remove_dir` use the ordinary Win32 calls.
pub fn remove_dir_all_compat(dir: &Path) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };

    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            remove_dir_all_compat(&path)?;
        } else {
            remove_file_compat(&path)?;
        }
    }

    fs::remove_dir(dir)
}

fn remove_file_compat(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        // Windows won't delete a read-only file.
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => {
            let mut permissions = fs::metadata(path)?.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            fs::set_permissions(path, permissions)?;
            fs::remove_file(path)
        }
        result => result,
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
