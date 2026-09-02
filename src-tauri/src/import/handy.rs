use std::path::{Path, PathBuf};

use crate::storage::ImportedTranscription;

use super::shared::{
    ImportBundle, ModelHint, app_support_dir, epoch_to_millis, map_model_family,
    open_sqlite_readonly, read_json, sqlite_table_exists, translate_accelerator,
};

pub const ID: &str = "handy";
pub const DISPLAY_NAME: &str = "Handy";

fn base_dir(home: &Path) -> PathBuf {
    app_support_dir(home, "com.pais.handy")
}

fn settings_path(home: &Path) -> PathBuf {
    base_dir(home).join("settings_store.json")
}

fn db_path(home: &Path) -> PathBuf {
    base_dir(home).join("history.db")
}

pub fn detect(home: &Path) -> bool {
    settings_path(home).exists() || db_path(home).exists()
}

pub fn parse(home: &Path) -> Result<ImportBundle, String> {
    let mut bundle = ImportBundle::default();

    if let Some(root) = read_json(&settings_path(home)) {
        let settings = root.get("settings").unwrap_or(&root);

        if let Some(words) = settings.get("custom_words").and_then(|v| v.as_array()) {
            bundle.dictionary = words
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|w| !w.is_empty())
                .map(str::to_string)
                .collect();
        }

        if let Some(binding) = settings
            .get("bindings")
            .and_then(|b| b.get("transcribe"))
            .and_then(|t| t.get("current_binding"))
            .and_then(|v| v.as_str())
        {
            bundle.smart_shortcut = translate_accelerator(binding);
        }

        let language = settings
            .get("selected_language")
            .and_then(|v| v.as_str())
            .filter(|l| !l.is_empty() && *l != "auto")
            .or_else(|| settings.get("app_language").and_then(|v| v.as_str()))
            .filter(|l| !l.is_empty());
        if let Some(language) = language {
            bundle.language = Some(language.to_string());
        }

        if let Some(model) = settings
            .get("selected_model")
            .and_then(|v| v.as_str())
            .filter(|m| !m.is_empty())
        {
            bundle.model_hint = Some(ModelHint {
                source_id: model.to_string(),
                family: map_model_family(model),
            });
        }
    }

    let db = db_path(home);
    if db.exists()
        && let Ok((conn, _guard)) = open_sqlite_readonly(&db)
        && sqlite_table_exists(&conn, "transcription_history")
        && let Ok(mut stmt) = conn.prepare(
            "SELECT COALESCE(NULLIF(TRIM(post_processed_text), ''), transcription_text) \
                            AS text, timestamp \
                     FROM transcription_history ORDER BY timestamp DESC",
        )
        && let Ok(rows) = stmt.query_map([], |row| {
            let text: Option<String> = row.get(0)?;
            let timestamp: i64 = row.get(1)?;
            Ok((text, timestamp))
        })
    {
        for (text, timestamp) in rows.flatten() {
            let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
                continue;
            };
            let timestamp_ms = epoch_to_millis(timestamp);
            bundle
                .transcripts
                .push(ImportedTranscription { text, timestamp_ms });
        }
    }

    Ok(bundle)
}
