use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use chrono::{NaiveDateTime, TimeZone, Utc};

use crate::settings::{Personality, Replacement};
use crate::storage::ImportedTranscription;

pub fn app_support_dir(home: &Path, app_folder: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home.join("Library")
            .join("Application Support")
            .join(app_folder)
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join(app_folder)
    }
}

pub fn translate_accelerator(raw: &str) -> Option<String> {
    let mut parts = Vec::new();
    for token in raw.split('+') {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let mapped = match token.to_lowercase().as_str() {
            "meta" | "cmd" | "command" | "super" | "win" => "Super",
            "control" | "ctrl" => "Control",
            "alt" | "option" | "altgr" => "Alt",
            "shift" => "Shift",
            // `Cmd*` is Glimpse's internal meta-key token. The frontend displays it
            // as Command on macOS and Meta on Windows.
            "cmdleft" | "commandleft" | "metaleft" => "CmdLeft",
            "cmdright" | "commandright" | "metaright" => "CmdRight",
            "superleft" | "winleft" | "windowsleft" => "CmdLeft",
            "superright" | "winright" | "windowsright" => "CmdRight",
            "controlleft" | "ctrlleft" => "CtrlLeft",
            "controlright" | "ctrlright" => "CtrlRight",
            "altleft" | "optionleft" => "OptLeft",
            "altright" | "optionright" => "OptRight",
            "shiftleft" => "ShiftLeft",
            "shiftright" => "ShiftRight",
            other => {
                let cleaned = other
                    .strip_prefix("key")
                    .or_else(|| other.strip_prefix("digit"))
                    .or_else(|| other.strip_prefix("numpad"))
                    .unwrap_or(other);
                if cleaned == "fn" || cleaned == "function" {
                    parts.push("Fn".to_string());
                    continue;
                }
                parts.push(capitalize(cleaned));
                continue;
            }
        };
        parts.push(mapped.to_string());
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("+"))
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBundle {
    pub dictionary: Vec<String>,
    pub replacements: Vec<Replacement>,
    pub personalities: Vec<Personality>,
    pub smart_shortcut: Option<String>,
    pub language: Option<String>,
    pub auto_launch: Option<bool>,
    pub model_hint: Option<ModelHint>,
    pub transcripts: Vec<ImportedTranscription>,
    pub transcript_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHint {
    pub source_id: String,
    pub family: Option<ModelFamily>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelFamily {
    WhisperLarge,
    WhisperMedium,
    WhisperSmall,
    WhisperBase,
    WhisperTiny,
    Parakeet,
}

pub fn map_model_family(source_id: &str) -> Option<ModelFamily> {
    let id = source_id.to_lowercase();
    if id.contains("parakeet") {
        return Some(ModelFamily::Parakeet);
    }
    if id.contains("whisper") || id.contains("large") || id.contains("turbo") {
        if id.contains("large") || id.contains("turbo") || id.contains("v3") {
            return Some(ModelFamily::WhisperLarge);
        }
        if id.contains("medium") {
            return Some(ModelFamily::WhisperMedium);
        }
        if id.contains("small") {
            return Some(ModelFamily::WhisperSmall);
        }
        if id.contains("base") {
            return Some(ModelFamily::WhisperBase);
        }
        if id.contains("tiny") {
            return Some(ModelFamily::WhisperTiny);
        }
        return Some(ModelFamily::WhisperLarge);
    }
    None
}

pub fn resolve_glimpse_model(family: ModelFamily, available_keys: &[String]) -> Option<String> {
    let contains = |needle: &str| -> Option<String> {
        available_keys
            .iter()
            .find(|key| key.to_lowercase().contains(needle))
            .cloned()
    };

    match family {
        ModelFamily::Parakeet => contains("parakeet"),
        ModelFamily::WhisperLarge => contains("large").or_else(|| contains("turbo")),
        ModelFamily::WhisperMedium => contains("medium").or_else(|| contains("large")),
        ModelFamily::WhisperSmall => contains("small").or_else(|| contains("base")),
        ModelFamily::WhisperBase => contains("base").or_else(|| contains("small")),
        ModelFamily::WhisperTiny => contains("tiny").or_else(|| contains("small")),
    }
    .or_else(|| {
        if matches!(family, ModelFamily::Parakeet) {
            None
        } else {
            available_keys
                .iter()
                .find(|key| key.to_lowercase().contains("whisper"))
                .cloned()
        }
    })
}

pub fn parse_datetime_millis(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }

    for fmt in [
        "%Y-%m-%d %H:%M:%S%.f %:z",
        "%Y-%m-%dT%H:%M:%S%.f%:z",
        "%Y-%m-%dT%H:%M:%S%.fZ",
    ] {
        if let Ok(dt) = chrono::DateTime::parse_from_str(s, fmt) {
            return Some(dt.timestamp_millis());
        }
    }

    for fmt in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(Utc.from_utc_datetime(&naive).timestamp_millis());
        }
    }

    if let Ok(n) = s.parse::<i64>() {
        return Some(if n < 100_000_000_000 { n * 1000 } else { n });
    }

    None
}

pub fn read_json(path: &Path) -> Option<serde_json::Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(suffix);
    PathBuf::from(os)
}

pub fn open_sqlite_readonly(path: &Path) -> Result<(rusqlite::Connection, TempDbGuard), String> {
    if !path.exists() {
        return Err(format!("database not found: {}", path.display()));
    }
    let tmp = std::env::temp_dir().join(format!("glimpse-import-{}.sqlite", uuid::Uuid::new_v4()));
    std::fs::copy(path, &tmp).map_err(|err| format!("failed to copy database: {err}"))?;

    let guard = TempDbGuard(tmp.clone());

    for suffix in ["-wal", "-shm"] {
        let src = sidecar_path(path, suffix);
        if src.exists() {
            let _ = std::fs::copy(&src, sidecar_path(&tmp, suffix));
        }
    }

    let conn = rusqlite::Connection::open_with_flags(
        &tmp,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("failed to open database: {err}"))?;

    Ok((conn, guard))
}

pub struct TempDbGuard(PathBuf);

impl Drop for TempDbGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(sidecar_path(&self.0, "-wal"));
        let _ = std::fs::remove_file(sidecar_path(&self.0, "-shm"));
    }
}

pub fn sqlite_table_exists(conn: &rusqlite::Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |_| Ok(()),
    )
    .is_ok()
}

pub fn normalize_language(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return None;
    }

    let base = trimmed
        .split(['-', '_'])
        .next()
        .unwrap_or(trimmed)
        .to_lowercase();

    let langs = crate::model_language_table::whisper_supported_languages();
    if let Some(info) = langs.iter().find(|l| l.code == base) {
        return Some(info.code.clone());
    }
    langs
        .iter()
        .find(|l| l.name.eq_ignore_ascii_case(trimmed))
        .map(|info| info.code.clone())
}

pub fn dedup_transcripts(transcripts: &mut Vec<ImportedTranscription>) {
    let mut seen = std::collections::HashSet::new();
    transcripts.retain(|t| seen.insert((t.text.clone(), t.timestamp_ms)));
}
