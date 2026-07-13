use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::settings::{Personality, Replacement};
use crate::storage::ImportedTranscription;

use super::shared::{
    ImportBundle, app_support_dir, parse_datetime_millis, read_json, translate_accelerator,
};

pub const ID: &str = "aqua";
pub const DISPLAY_NAME: &str = "Aqua Voice";

fn settings_path(home: &Path) -> PathBuf {
    app_support_dir(home, "Aqua Voice").join("settings.json")
}

pub fn detect(home: &Path) -> bool {
    settings_path(home).exists()
}

pub fn parse(home: &Path) -> Result<ImportBundle, String> {
    let value = read_json(&settings_path(home))
        .ok_or_else(|| "Could not read Aqua Voice settings".to_string())?;

    let mut bundle = ImportBundle::default();

    if let Some(entries) = value.get("dictionary").and_then(|v| v.as_array()) {
        bundle.dictionary = entries
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
    }

    if let Some(entries) = value.get("replacements").and_then(|v| v.as_array()) {
        bundle.replacements = entries
            .iter()
            .filter_map(|entry| {
                let from = entry.get("from")?.as_str()?.to_string();
                let to = entry
                    .get("to")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                Some(Replacement { from, to })
            })
            .collect();
    }

    if let Some(hotkeys) = value.get("hotkeys").and_then(|v| v.as_array()) {
        bundle.smart_shortcut = hotkeys
            .iter()
            .find(|h| h.get("action").and_then(|a| a.as_str()) == Some("activate"))
            .and_then(|h| h.get("keys").and_then(|k| k.as_str()))
            .and_then(translate_accelerator);
    }

    if let Some(instructions) = value
        .get("customInstructions")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        bundle.personalities.push(Personality {
            id: Uuid::new_v4().to_string(),
            name: "Aqua Voice".to_string(),
            enabled: true,
            apps: Vec::new(),
            websites: Vec::new(),
            instructions: vec![instructions.to_string()],
        });
    }

    if let Some(lang) = value
        .get("language")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        bundle.language = Some(lang.to_string());
    }

    if let Some(start_on_startup) = value.get("startOnStartup").and_then(|v| v.as_bool()) {
        bundle.auto_launch = Some(start_on_startup);
    }

    if let Some(history) = value.get("history").and_then(|v| v.as_array()) {
        bundle.transcripts = history.iter().filter_map(history_entry).collect();
    }
    bundle.transcript_count = bundle.transcripts.len() as u32;

    Ok(bundle)
}

fn history_entry(entry: &serde_json::Value) -> Option<ImportedTranscription> {
    let text = ["text", "transcript", "result", "content"]
        .iter()
        .find_map(|key| entry.get(*key).and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();

    let timestamp_ms = ["timestamp", "createdAt", "date", "time"]
        .iter()
        .find_map(|key| entry.get(*key))
        .and_then(|v| match v {
            serde_json::Value::String(s) => parse_datetime_millis(s),
            serde_json::Value::Number(n) => n.as_i64().map(|raw| {
                if raw < 100_000_000_000 {
                    raw * 1000
                } else {
                    raw
                }
            }),
            _ => None,
        })
        .unwrap_or_else(|| chrono::Local::now().timestamp_millis());

    Some(ImportedTranscription { text, timestamp_ms })
}
