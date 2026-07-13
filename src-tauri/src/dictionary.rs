use std::collections::HashSet;

use crate::{
    AppState,
    model_manager::{MODEL_CAPABILITY_DICTIONARY, ReadyModel, model_supports_capability},
    settings::{Replacement, UserSettings},
};

pub fn sanitize_dictionary_entries(entries: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();

    for raw in entries {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = trimmed.to_lowercase();
        if seen.insert(normalized) {
            let capped: String = trimmed.chars().take(160).collect();
            let capped = capped.trim_end().to_string();
            cleaned.push(capped);
        }
        if cleaned.len() >= 64 {
            break;
        }
    }

    cleaned
}

pub fn dictionary_entries_for_model(model: &ReadyModel, settings: &UserSettings) -> Vec<String> {
    let supports_dictionary = model_supports_capability(&model.key, MODEL_CAPABILITY_DICTIONARY);

    if !supports_dictionary {
        return Vec::new();
    }

    sanitize_dictionary_entries(&settings.dictionary)
}

pub fn sanitize_replacements(replacements: &[Replacement]) -> Vec<Replacement> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();

    for r in replacements {
        let from = r.from.trim();
        let to = r.to.trim();
        if from.is_empty() {
            continue;
        }
        let key = from.to_lowercase();
        if seen.insert(key) {
            let from_capped: String = from.chars().take(100).collect();
            let to_capped: String = to.chars().take(200).collect();
            cleaned.push(Replacement {
                from: from_capped.trim().to_string(),
                to: to_capped.trim().to_string(),
            });
        }
        if cleaned.len() >= 64 {
            break;
        }
    }

    cleaned
}

pub fn apply_replacements(text: &str, replacements: &[Replacement]) -> String {
    if replacements.is_empty() {
        return text.to_string();
    }

    let mut result = text.to_string();
    for r in replacements {
        if r.from.is_empty() {
            continue;
        }
        let pattern = format!(r"(?i)\b{}\b", regex::escape(&r.from));
        if let Ok(re) = regex::Regex::new(&pattern) {
            result = re
                .replace_all(&result, |caps: &regex::Captures| {
                    let matched = &caps[0];
                    apply_case_pattern(matched, &r.to)
                })
                .to_string();
        }
    }
    result
}

fn apply_case_pattern(matched: &str, replacement: &str) -> String {
    if replacement.is_empty() {
        return String::new();
    }

    let first_char = matched.chars().next();
    let is_first_upper = first_char.map(|c| c.is_uppercase()).unwrap_or(false);
    let is_all_upper = matched.len() > 1
        && matched
            .chars()
            .all(|c| !c.is_alphabetic() || c.is_uppercase());

    if is_all_upper {
        replacement.to_uppercase()
    } else if is_first_upper {
        let mut chars = replacement.chars();
        match chars.next() {
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            None => String::new(),
        }
    } else {
        replacement.to_string()
    }
}

#[tauri::command]
pub fn set_dictionary(
    entries: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<Vec<String>, String> {
    let cleaned = sanitize_dictionary_entries(&entries);
    let mut settings = state.current_settings();
    settings.dictionary = cleaned.clone();
    settings.auto_dictionary_ignored =
        crate::auto_dictionary::remove_dictionary_entries_from_ignored(
            settings.auto_dictionary_ignored,
            &cleaned,
        );
    state
        .persist_settings(settings)
        .map_err(|err| err.to_string())?;
    crate::auto_dictionary::sync_ignored_dictionary_entries(&cleaned);
    Ok(cleaned)
}

#[tauri::command]
pub fn get_replacements(state: tauri::State<AppState>) -> Result<Vec<Replacement>, String> {
    let mut settings = state.current_settings();
    let cleaned = sanitize_replacements(&settings.replacements);
    if cleaned != settings.replacements {
        settings.replacements = cleaned.clone();
        state
            .persist_settings(settings)
            .map_err(|err| err.to_string())?;
    }
    Ok(cleaned)
}

#[tauri::command]
pub fn set_replacements(
    replacements: Vec<Replacement>,
    state: tauri::State<AppState>,
) -> Result<Vec<Replacement>, String> {
    let cleaned = sanitize_replacements(&replacements);
    let mut settings = state.current_settings();
    settings.replacements = cleaned.clone();
    state
        .persist_settings(settings)
        .map_err(|err| err.to_string())?;
    Ok(cleaned)
}
