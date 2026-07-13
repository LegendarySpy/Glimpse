use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::core::hotkeys;
use crate::dictionary::{sanitize_dictionary_entries, sanitize_replacements};
use crate::personalization::sanitize_personalities;
use crate::settings::ShortcutBinding;
use crate::{AppRuntime, AppState, model_manager};

use super::detect::parse_app;
use super::shared::resolve_glimpse_model;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSelections {
    #[serde(default = "default_true")]
    pub dictionary: bool,
    #[serde(default = "default_true")]
    pub replacements: bool,
    #[serde(default = "default_true")]
    pub personalities: bool,
    #[serde(default = "default_true")]
    pub shortcut: bool,
    #[serde(default = "default_true")]
    pub language: bool,
    #[serde(default = "default_true")]
    pub auto_launch: bool,
    #[serde(default = "default_true")]
    pub model: bool,
    #[serde(default = "default_true")]
    pub history: bool,
}

impl Default for ImportSelections {
    fn default() -> Self {
        Self {
            dictionary: true,
            replacements: true,
            personalities: true,
            shortcut: true,
            language: true,
            auto_launch: true,
            model: true,
            history: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub dictionary_added: usize,
    pub replacements_added: usize,
    pub personalities_added: usize,
    pub shortcut_applied: bool,
    pub shortcut: Option<String>,
    pub language_applied: bool,
    pub auto_launch_applied: bool,
    pub auto_launch: Option<bool>,
    pub model_key: Option<String>,
    pub model_unrecognized: bool,
    pub transcripts_added: usize,
}

pub fn apply_import(
    app: &AppHandle<AppRuntime>,
    state: &AppState,
    id: &str,
    home: &Path,
    selections: &ImportSelections,
) -> Result<ImportResult, String> {
    let bundle = parse_app(id, home)?;
    let mut settings = state.current_settings_unmasked();
    let previous_settings = settings.clone();
    let previous_auto_launch_enabled = settings.auto_launch_enabled;
    let mut result = ImportResult::default();

    if selections.dictionary && !bundle.dictionary.is_empty() {
        let before = settings.dictionary.len();
        let mut merged = settings.dictionary.clone();
        merged.extend(bundle.dictionary.clone());
        settings.dictionary = sanitize_dictionary_entries(&merged);
        result.dictionary_added = settings.dictionary.len().saturating_sub(before);
    }

    if selections.replacements && !bundle.replacements.is_empty() {
        let before = settings.replacements.len();
        let mut merged = settings.replacements.clone();
        merged.extend(bundle.replacements.clone());
        settings.replacements = sanitize_replacements(&merged);
        result.replacements_added = settings.replacements.len().saturating_sub(before);
    }

    if selections.personalities && !bundle.personalities.is_empty() {
        let before = settings.personalities.len();
        let mut merged = settings.personalities.clone();
        merged.extend(bundle.personalities.clone());
        settings.personalities = sanitize_personalities(&merged);
        result.personalities_added = settings.personalities.len().saturating_sub(before);
    }

    if selections.shortcut
        && let Some(raw) = bundle.smart_shortcut.as_deref()
        && let Ok(hotkey) = hotkeys::parse_shortcut(raw)
        && hotkeys::validate_recording_shortcut(&hotkey).is_ok()
    {
        let canonical = hotkey.to_string();
        settings.smart_shortcut = canonical.clone();
        settings.smart_enabled = true;
        result.shortcut = Some(canonical.clone());
        settings.shortcut_bindings.smart = vec![ShortcutBinding {
            shortcut: canonical,
            temporary: false,
            cleanup_enabled: settings
                .shortcut_bindings
                .smart
                .first()
                .map(|b| b.cleanup_enabled)
                .unwrap_or(false),
        }];
        result.shortcut_applied = true;
    }

    if selections.language
        && let Some(lang) = bundle.language.as_deref().filter(|s| !s.is_empty())
    {
        settings.language = lang.to_string();
        result.language_applied = true;
    }

    if selections.auto_launch
        && let Some(auto_launch) = bundle.auto_launch
    {
        settings.auto_launch_enabled = auto_launch;
        settings.start_in_background = auto_launch && settings.start_in_background;
        result.auto_launch_applied = true;
        result.auto_launch = Some(auto_launch);
    }

    if selections.model
        && let Some(hint) = bundle.model_hint.as_ref()
    {
        match hint.family {
            Some(family) => {
                let keys: Vec<String> = model_manager::list_models()
                    .into_iter()
                    .map(|m| m.key)
                    .collect();
                if let Some(key) = resolve_glimpse_model(family, &keys) {
                    settings.local_model = key.clone();
                    settings.transcription_mode = crate::settings::TranscriptionMode::Local;
                    result.model_key = Some(key);
                } else {
                    result.model_unrecognized = true;
                }
            }
            None => result.model_unrecognized = true,
        }
    }

    let next_auto_launch_enabled = settings.auto_launch_enabled;
    if previous_auto_launch_enabled != next_auto_launch_enabled {
        crate::sync_launch_at_login(app, next_auto_launch_enabled)?;
    }

    let next = match state.persist_settings(settings) {
        Ok(next) => next,
        Err(err) => {
            if previous_auto_launch_enabled != next_auto_launch_enabled {
                let _ = crate::sync_launch_at_login(app, previous_auto_launch_enabled);
            }
            return Err(err.to_string());
        }
    };
    crate::analytics::track_settings_changes(app, &previous_settings, &next);
    state.emit_settings_changed(app, &next);

    // Write transcripts last so a settings/launch failure can't leave them committed.
    if selections.history && !bundle.transcripts.is_empty() {
        result.transcripts_added = state
            .storage()
            .import_transcriptions(&bundle.transcripts)
            .map_err(|err| err.to_string())?;
    }

    Ok(result)
}
