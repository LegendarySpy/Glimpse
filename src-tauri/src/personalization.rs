use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::settings::Personality;
use crate::{AppRuntime, AppState, EVENT_SETTINGS_CHANGED};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledApp {
    pub name: String,
    pub path: String,
}

fn sanitize_list(entries: &[String], limit: usize, max_len: usize, lower: bool) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();

    for raw in entries {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let capped: String = trimmed.chars().take(max_len).collect();
        let capped = capped.trim();
        let value = if lower {
            capped.to_lowercase()
        } else {
            capped.to_string()
        };
        let key = capped.to_lowercase();
        if seen.insert(key) {
            cleaned.push(value);
        }
        if cleaned.len() >= limit {
            break;
        }
    }

    cleaned
}

pub fn sanitize_personalities(entries: &[Personality]) -> Vec<Personality> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();

    for entry in entries {
        let name = entry.name.trim();
        if name.is_empty() {
            continue;
        }
        let mut id = entry.id.trim().to_string();
        if id.is_empty() {
            id = name.to_lowercase().replace(' ', "-");
        }
        if !seen.insert(id.to_lowercase()) {
            continue;
        }

        let capped_name: String = name.chars().take(60).collect();
        let apps = sanitize_list(&entry.apps, 64, 60, false);
        let websites = sanitize_list(&entry.websites, 64, 120, true);
        let instructions = sanitize_list(&entry.instructions, 64, 220, false);

        cleaned.push(Personality {
            id,
            name: capped_name.trim().to_string(),
            enabled: entry.enabled,
            apps,
            websites,
            instructions,
        });

        if cleaned.len() >= 32 {
            break;
        }
    }

    cleaned
}

#[tauri::command]
pub fn get_personalities(state: tauri::State<AppState>) -> Result<Vec<Personality>, String> {
    let mut settings = state.current_settings();
    let cleaned = sanitize_personalities(&settings.personalities);
    if cleaned != settings.personalities {
        settings.personalities = cleaned.clone();
        state
            .persist_settings(settings)
            .map_err(|err| err.to_string())?;
    }
    Ok(cleaned)
}

#[tauri::command]
pub fn set_personalities(
    personalities: Vec<Personality>,
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<Vec<Personality>, String> {
    let cleaned = sanitize_personalities(&personalities);
    let mut settings = state.current_settings();
    settings.personalities = cleaned.clone();
    let saved = state
        .persist_settings(settings)
        .map_err(|err| err.to_string())?;

    if let Err(err) = app.emit(EVENT_SETTINGS_CHANGED, &saved) {
        eprintln!("Failed to emit settings change: {err}");
    }

    Ok(cleaned)
}

#[cfg(target_os = "macos")]
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

    let substrings = ["helper", "installer", "uninstaller", "updater", "agent"];
    substrings.iter().any(|needle| lowered.contains(needle))
}

#[cfg(target_os = "macos")]
fn collect_apps(
    dir: &Path,
    depth: usize,
    apps: &mut Vec<InstalledApp>,
    seen: &mut HashSet<String>,
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

        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("app"))
            .unwrap_or(false)
        {
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
                apps.push(InstalledApp { name, path: key });
            }
            continue;
        }

        if path.is_dir() {
            collect_apps(&path, depth.saturating_sub(1), apps, seen);
        }
    }
}

#[tauri::command]
pub fn list_installed_apps() -> Result<Vec<InstalledApp>, String> {
    #[cfg(target_os = "macos")]
    {
        let mut apps = Vec::new();
        let mut seen = HashSet::new();
        let mut roots = vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/System/Applications"),
        ];
        if let Ok(home) = std::env::var("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }

        for root in roots {
            collect_apps(&root, 3, &mut apps, &mut seen);
        }

        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        return Ok(apps);
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
}
