pub(crate) mod icons;

use std::collections::HashSet;

use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::settings::Personality;
use crate::{AppRuntime, AppState, EVENT_SETTINGS_CHANGED};

const INSTRUCTION_CHAR_LIMIT: usize = 3000;

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

fn sanitize_instructions(entries: &[String]) -> Vec<String> {
    let mut cleaned = Vec::new();
    let mut remaining_chars = INSTRUCTION_CHAR_LIMIT;

    for raw in entries {
        if remaining_chars == 0 {
            break;
        }

        let newline_cost = usize::from(!cleaned.is_empty());
        if remaining_chars <= newline_cost {
            break;
        }

        let allowed_chars = remaining_chars - newline_cost;
        let capped: String = raw.chars().take(allowed_chars).collect();

        remaining_chars -= newline_cost;
        remaining_chars = remaining_chars.saturating_sub(capped.chars().count());
        cleaned.push(capped);
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
            id = Uuid::new_v4().to_string();
        }
        while !seen.insert(id.to_lowercase()) {
            id = Uuid::new_v4().to_string();
        }

        let capped_name: String = name.chars().take(60).collect();
        let apps = sanitize_list(&entry.apps, 64, 60, false);
        let websites = sanitize_list(&entry.websites, 64, 120, true);
        let instructions = sanitize_instructions(&entry.instructions);

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
        tracing::error!("Failed to emit settings change: {err}");
    }

    Ok(cleaned)
}
