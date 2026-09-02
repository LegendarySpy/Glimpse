use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::settings::{Personality, Replacement};
use crate::storage::ImportedTranscription;

use super::shared::{
    ImportBundle, ModelHint, app_support_dir, dedup_transcripts, json_text, json_timestamp_ms,
    map_model_family, open_sqlite_readonly, parse_datetime_millis, read_json, sqlite_table_exists,
};

pub const ID: &str = "superwhisper";
pub const DISPLAY_NAME: &str = "superwhisper";

#[cfg(target_os = "windows")]
fn root_dir(home: &Path) -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Local"))
        .join("com.superwhisper.app")
}

#[cfg(not(target_os = "windows"))]
fn root_dir(home: &Path) -> PathBuf {
    home.join("Documents").join("superwhisper")
}

#[cfg(target_os = "windows")]
fn settings_path(root: &Path) -> PathBuf {
    root.join("settings.json")
}

#[cfg(not(target_os = "windows"))]
fn settings_path(root: &Path) -> PathBuf {
    root.join("settings").join("settings.json")
}

fn current_db_path(home: &Path) -> PathBuf {
    app_support_dir(home, "superwhisper")
        .join("database")
        .join("superwhisper.sqlite")
}

pub fn detect(home: &Path) -> bool {
    let root = root_dir(home);
    settings_path(&root).exists()
        || root.join("modes").is_dir()
        || root.join("recordings").is_dir()
        || current_db_path(home).exists()
}

pub fn parse(home: &Path) -> Result<ImportBundle, String> {
    let root = root_dir(home);
    let mut bundle = ImportBundle::default();

    if let Some(settings) = read_json(&settings_path(&root)) {
        if let Some(vocab) = settings.get("vocabulary").and_then(|v| v.as_array()) {
            bundle.dictionary = vocab
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
        }

        if let Some(reps) = settings.get("replacements").and_then(|v| v.as_array()) {
            bundle.replacements = reps.iter().filter_map(parse_replacement).collect();
        }

        if let Some(model) = settings
            .get("favoriteModelIDs")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
        {
            bundle.model_hint = Some(ModelHint {
                source_id: model.to_string(),
                family: map_model_family(model),
            });
        }
    }

    if let Ok(entries) = std::fs::read_dir(root.join("modes")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(mode) = read_json(&path) else {
                continue;
            };
            let Some(personality) = mode_to_personality(&mode) else {
                continue;
            };
            bundle.personalities.push(personality);

            if bundle.language.is_none()
                && let Some(lang) = mode.get("language").and_then(|v| v.as_str())
                && !lang.is_empty()
            {
                bundle.language = Some(lang.to_string());
            }
            if bundle.model_hint.is_none()
                && let Some(model) = mode.get("voiceModelID").and_then(|v| v.as_str())
                && !model.is_empty()
            {
                bundle.model_hint = Some(ModelHint {
                    source_id: model.to_string(),
                    family: map_model_family(model),
                });
            }
        }
    }

    if let Ok(recordings) = std::fs::read_dir(root.join("recordings")) {
        for entry in recordings.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(transcript) = recording_transcript(&path.join("meta.json")) {
                bundle.transcripts.push(transcript);
            }
        }
    }

    bundle.transcripts.extend(current_db_transcripts(home));
    dedup_transcripts(&mut bundle.transcripts);

    Ok(bundle)
}

fn recording_transcript(meta_path: &Path) -> Option<ImportedTranscription> {
    let meta = read_json(meta_path)?;
    let text = json_text(&meta, &["result", "text", "llmResult", "processedResult"])?;
    let timestamp_ms = json_timestamp_ms(&meta, &["datetime", "timestamp", "date"]);
    Some(ImportedTranscription { text, timestamp_ms })
}

fn current_db_transcripts(home: &Path) -> Vec<ImportedTranscription> {
    let db = current_db_path(home);
    if !db.exists() {
        return Vec::new();
    }

    let Ok((conn, _guard)) = open_sqlite_readonly(&db) else {
        return Vec::new();
    };
    if !sqlite_table_exists(&conn, "recording") || !sqlite_table_exists(&conn, "recording_fts") {
        return Vec::new();
    }

    let Ok(mut stmt) = conn.prepare(
        "SELECT COALESCE(
                    NULLIF(TRIM(fts.result), ''),
                    NULLIF(TRIM(fts.llmResult), ''),
                    NULLIF(TRIM(fts.rawResult), '')
                ) AS text,
                recording.datetime
         FROM recording
         LEFT JOIN recording_fts fts ON fts.recordingId = recording.id
         WHERE text IS NOT NULL
         ORDER BY recording.datetime DESC",
    ) else {
        return Vec::new();
    };

    let Ok(rows) = stmt.query_map([], |row| {
        let text: Option<String> = row.get(0)?;
        let created: Option<String> = row.get(1)?;
        Ok((text, created))
    }) else {
        return Vec::new();
    };

    rows.flatten()
        .filter_map(|(text, created)| {
            let text = text?.trim().to_string();
            if text.is_empty() {
                return None;
            }
            let timestamp_ms = created
                .as_deref()
                .and_then(parse_datetime_millis)
                .unwrap_or_else(|| chrono::Local::now().timestamp_millis());
            Some(ImportedTranscription { text, timestamp_ms })
        })
        .collect()
}

fn parse_replacement(entry: &serde_json::Value) -> Option<Replacement> {
    let from = entry
        .get("from")
        .or_else(|| entry.get("original"))?
        .as_str()?
        .to_string();
    let to = entry
        .get("to")
        .or_else(|| entry.get("replacement"))
        .or_else(|| entry.get("with"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(Replacement { from, to })
}

fn mode_to_personality(mode: &serde_json::Value) -> Option<Personality> {
    let name = mode
        .get("name")
        .and_then(|v| v.as_str())?
        .trim()
        .to_string();
    if name.is_empty() {
        return None;
    }
    let prompt = mode
        .get("prompt")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let apps = string_array(mode.get("activationApps"));
    let websites = string_array(mode.get("activationSites"));

    if prompt.is_none() && apps.is_empty() && websites.is_empty() {
        return None;
    }

    Some(Personality {
        id: Uuid::new_v4().to_string(),
        name,
        enabled: true,
        apps,
        websites,
        instructions: prompt.map(|p| vec![p.to_string()]).unwrap_or_default(),
    })
}

fn string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}
