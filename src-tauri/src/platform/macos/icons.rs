use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::AppHandle;

use crate::AppRuntime;
use crate::personalization::icons::{
    InstalledApp, app_icon_cache_dir, icon_cache_file_path, should_refresh_icon,
};

fn is_blacklisted_app(name: &str) -> bool {
    let lowered = name.to_lowercase();
    let exact = [
        "activity monitor",
        "audio midi setup",
        "boot camp assistant",
        "console",
        "disk utility",
        "font book",
        "image capture",
        "keychain access",
        "migration assistant",
        "script editor",
        "system information",
        "system settings",
        "terminal",
        "time machine",
    ];
    if exact.contains(&lowered.as_str()) {
        return true;
    }

    let suffix_tokens = ["installer", "uninstaller", "updater", "agent"];
    lowered
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .rfind(|token| !token.is_empty())
        .is_some_and(|token| suffix_tokens.contains(&token))
}

fn collect_apps(
    dir: &Path,
    depth: usize,
    apps: &mut Vec<InstalledApp>,
    seen: &mut HashSet<String>,
    icon_cache_dir: Option<&Path>,
    pending_icon_warmup: &mut Vec<(PathBuf, String)>,
) {
    if depth == 0 {
        return;
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name();
        if file_name.to_string_lossy().starts_with('.') {
            continue;
        }

        let is_app_bundle = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("app"))
            .unwrap_or(false);
        if is_app_bundle {
            let name = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default()
                .to_string();
            if name.is_empty() || is_blacklisted_app(&name) {
                continue;
            }

            let key = path.to_string_lossy().to_string();
            if seen.insert(key.clone()) {
                let icon_path = icon_cache_dir.and_then(|cache_dir| {
                    let cached_path = icon_cache_file_path(&path, cache_dir);
                    if cached_path.exists() {
                        Some(cached_path.to_string_lossy().to_string())
                    } else {
                        pending_icon_warmup.push((path.clone(), name.clone()));
                        None
                    }
                });
                apps.push(InstalledApp {
                    name,
                    path: key,
                    icon_path,
                });
            }
            continue;
        }

        if path.is_dir() {
            collect_apps(
                &path,
                depth.saturating_sub(1),
                apps,
                seen,
                icon_cache_dir,
                pending_icon_warmup,
            );
        }
    }
}

fn declared_bundle_icon(app_bundle_path: &Path) -> Option<PathBuf> {
    let info_plist = app_bundle_path.join("Contents").join("Info.plist");
    let resources_dir = app_bundle_path.join("Contents").join("Resources");
    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleIconFile"])
        .arg(&info_plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let icon_name = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if icon_name.is_empty() {
        return None;
    }

    let icon_path = resources_dir.join(&icon_name);
    if icon_path.exists() {
        return Some(icon_path);
    }

    let icon_path = resources_dir.join(format!("{icon_name}.icns"));
    icon_path.exists().then_some(icon_path)
}

fn fallback_bundle_icon(app_bundle_path: &Path, app_name: &str) -> Option<PathBuf> {
    let resources_dir = app_bundle_path.join("Contents").join("Resources");
    let app_name = app_name.to_lowercase();

    for candidate in [
        format!("{app_name}.icns"),
        "AppIcon.icns".to_string(),
        "app.icns".to_string(),
    ] {
        let path = resources_dir.join(candidate);
        if path.exists() {
            return Some(path);
        }
    }

    std::fs::read_dir(resources_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("icns"))
                .unwrap_or(false)
        })
}

fn pick_bundle_icon(app_bundle_path: &Path, app_name: &str) -> Option<PathBuf> {
    declared_bundle_icon(app_bundle_path)
        .or_else(|| fallback_bundle_icon(app_bundle_path, app_name))
}

fn ensure_cached_icon(app_bundle_path: &Path, app_name: &str, cache_dir: &Path) -> Option<PathBuf> {
    let source_icon = pick_bundle_icon(app_bundle_path, app_name)?;
    let cached_icon = icon_cache_file_path(app_bundle_path, cache_dir);

    if should_refresh_icon(&source_icon, &cached_icon) {
        let status = Command::new("/usr/bin/sips")
            .arg("-s")
            .arg("format")
            .arg("png")
            .arg("-z")
            .arg("64")
            .arg("64")
            .arg(&source_icon)
            .arg("--out")
            .arg(&cached_icon)
            .status()
            .ok()?;

        if !status.success() || !cached_icon.exists() {
            return None;
        }
    }

    Some(cached_icon)
}

fn warm_icon_cache_in_background(pending: Vec<(PathBuf, String)>, cache_dir: PathBuf) {
    if pending.is_empty() {
        return;
    }

    std::thread::spawn(move || {
        for (app_bundle_path, app_name) in pending {
            let _ = ensure_cached_icon(&app_bundle_path, &app_name, &cache_dir);
        }
    });
}

pub fn list_installed_apps(app: &AppHandle<AppRuntime>) -> Result<Vec<InstalledApp>, String> {
    let mut apps = Vec::new();
    let mut seen = HashSet::new();
    let icon_cache_dir = app_icon_cache_dir(app);
    let mut pending_icon_warmup = Vec::new();
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }

    for root in roots {
        collect_apps(
            &root,
            3,
            &mut apps,
            &mut seen,
            icon_cache_dir.as_deref(),
            &mut pending_icon_warmup,
        );
    }

    apps.sort_by_key(|app| app.name.to_lowercase());
    if let Some(cache_dir) = icon_cache_dir {
        warm_icon_cache_in_background(pending_icon_warmup, cache_dir);
    }
    Ok(apps)
}
