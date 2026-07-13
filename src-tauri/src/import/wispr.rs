use std::path::{Path, PathBuf};

use crate::settings::Replacement;
use crate::storage::ImportedTranscription;

use super::shared::{
    ImportBundle, app_support_dir, open_sqlite_readonly, parse_datetime_millis, sqlite_table_exists,
};

pub const ID: &str = "wispr";
pub const DISPLAY_NAME: &str = "Wispr Flow";

fn db_path(home: &Path) -> PathBuf {
    app_support_dir(home, "Wispr Flow").join("flow.sqlite")
}

pub fn detect(home: &Path) -> bool {
    db_path(home).exists()
}

pub fn parse(home: &Path) -> Result<ImportBundle, String> {
    let (conn, _guard) = open_sqlite_readonly(&db_path(home))?;
    let mut bundle = ImportBundle::default();

    if sqlite_table_exists(&conn, "Dictionary")
        && let Ok(mut stmt) = conn.prepare(
            "SELECT phrase, replacement FROM Dictionary \
             WHERE COALESCE(isDeleted, 0) = 0 AND phrase IS NOT NULL AND TRIM(phrase) <> ''",
        )
        && let Ok(rows) = stmt.query_map([], |row| {
            let phrase: String = row.get(0)?;
            let replacement: Option<String> = row.get(1).ok();
            Ok((phrase, replacement))
        })
    {
        for (phrase, replacement) in rows.flatten() {
            match replacement {
                Some(to) if !to.trim().is_empty() => {
                    bundle.replacements.push(Replacement { from: phrase, to });
                }
                _ => bundle.dictionary.push(phrase),
            }
        }
    }

    if sqlite_table_exists(&conn, "History") {
        let text_expr = wispr_text_expr(&conn);
        let query = format!(
            "SELECT {text_expr} AS text, timestamp \
             FROM History \
             WHERE COALESCE(isArchived, 0) = 0 \
             ORDER BY timestamp DESC"
        );
        if let Ok(mut stmt) = conn.prepare(&query) {
            let rows = stmt
                .query_map([], |row| {
                    let text: Option<String> = row.get(0)?;
                    let timestamp: Option<String> = row.get(1)?;
                    Ok((text, timestamp))
                })
                .map_err(|e| e.to_string())?;

            for (text, timestamp) in rows.flatten() {
                let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
                    continue;
                };
                let timestamp_ms = timestamp
                    .as_deref()
                    .and_then(parse_datetime_millis)
                    .unwrap_or_else(|| chrono::Local::now().timestamp_millis());
                bundle
                    .transcripts
                    .push(ImportedTranscription { text, timestamp_ms });
            }
        }
        bundle.transcript_count = bundle.transcripts.len() as u32;
    }

    Ok(bundle)
}

fn wispr_text_expr(conn: &rusqlite::Connection) -> String {
    let columns = history_columns(conn);
    let candidates = [
        "editedText",
        "pastedText",
        "toneMatchedText",
        "formattedText",
        "defaultFormattedText",
        "fallbackFormattedText",
        "asrText",
    ];
    let parts: Vec<String> = candidates
        .iter()
        .filter(|column| columns.iter().any(|existing| existing == **column))
        .map(|column| format!("NULLIF(TRIM({column}), '')"))
        .collect();

    if parts.is_empty() {
        "NULL".to_string()
    } else {
        format!("COALESCE({})", parts.join(", "))
    }
}

fn history_columns(conn: &rusqlite::Connection) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare("PRAGMA table_info(History)") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return Vec::new();
    };
    rows.flatten().collect()
}
