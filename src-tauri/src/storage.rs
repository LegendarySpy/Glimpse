use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Local, TimeZone};
use parking_lot::Mutex;
use rusqlite::{
    Connection, OptionalExtension, Row, params, params_from_iter,
    types::{Type, Value},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::library::{LibraryFilter, LibraryItem, LibraryItemPatch};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionRecord {
    pub id: String,
    pub timestamp: DateTime<Local>,
    /// The final text (cleaned if LLM was used, otherwise raw)
    pub text: String,
    /// The raw transcription before LLM cleanup (if applicable)
    #[serde(default)]
    pub raw_text: Option<String>,
    pub audio_path: String,
    #[serde(default)]
    pub audio_available: bool,
    pub status: TranscriptionStatus,
    pub error_message: Option<String>,
    /// Whether LLM cleanup was applied
    #[serde(default)]
    pub llm_cleaned: bool,
    #[serde(default)]
    pub speech_model: String,
    #[serde(default)]
    pub llm_model: Option<String>,
    #[serde(default)]
    pub word_count: u32,
    #[serde(default)]
    pub audio_duration_seconds: f32,
    #[serde(default)]
    pub synced: bool,
    #[serde(default)]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub mode_name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct LifetimeStats {
    pub words: u64,
    pub duration_ms: u64,
    pub dictations: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayDictationStats {
    pub count: u64,
    pub words: u64,
    pub audio_seconds: f64,
    pub longest_words: u64,
    pub longest_audio_seconds: f64,
    pub llm_cleaned_count: u64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionSort {
    Recent,
    Oldest,
    Longest,
    Shortest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionPage {
    pub items: Vec<TranscriptionRecord>,
    pub total_count: Option<usize>,
    pub previous_timestamp: Option<DateTime<Local>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionStatus {
    Success,
    Error,
}

impl TranscriptionStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Error => "error",
        }
    }

    fn from_str(value: &str) -> std::result::Result<Self, &'static str> {
        match value.to_ascii_lowercase().as_str() {
            "success" => Ok(Self::Success),
            "error" => Ok(Self::Error),
            _ => Err("Unknown transcription status"),
        }
    }
}

pub struct StorageManager {
    connection: Arc<Mutex<Connection>>,
    library_root: PathBuf,
}

#[derive(Debug, Clone)]
pub struct TranscriptionMetadata {
    pub speech_model: String,
    pub llm_model: Option<String>,
    pub word_count: u32,
    pub audio_duration_seconds: f32,
    pub synced: bool,
    pub mode_id: Option<String>,
    pub mode_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedTranscription {
    pub text: String,
    pub timestamp_ms: i64,
}

impl Default for TranscriptionMetadata {
    fn default() -> Self {
        Self {
            speech_model: String::new(),
            llm_model: None,
            word_count: 0,
            audio_duration_seconds: 0.0,
            synced: false,
            mode_id: None,
            mode_name: None,
        }
    }
}

impl StorageManager {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("Failed to create storage directory at {}", parent.display())
            })?;
        }

        let connection = Connection::open(&db_path).with_context(|| {
            format!(
                "Failed to open transcription database at {}",
                db_path.display()
            )
        })?;

        Self::configure_connection(&connection)?;
        Self::apply_migrations(&connection)?;

        let library_root = db_path
            .parent()
            .map(|parent| parent.join("library"))
            .unwrap_or_else(|| PathBuf::from("library"));

        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            library_root,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_transcription(
        &self,
        text: String,
        audio_path: String,
        status: TranscriptionStatus,
        error_message: Option<String>,
        metadata: TranscriptionMetadata,
        id_override: Option<String>,
        timestamp_override: Option<DateTime<Local>>,
    ) -> Result<TranscriptionRecord> {
        let record = TranscriptionRecord {
            id: id_override.unwrap_or_else(|| Uuid::new_v4().to_string()),
            timestamp: timestamp_override.unwrap_or_else(Local::now),
            text,
            raw_text: None,
            audio_available: !audio_path.is_empty(),
            audio_path,
            status,
            error_message,
            llm_cleaned: false,
            speech_model: metadata.speech_model,
            llm_model: metadata.llm_model,
            word_count: metadata.word_count,
            audio_duration_seconds: metadata.audio_duration_seconds,
            synced: metadata.synced,
            mode_id: metadata.mode_id,
            mode_name: metadata.mode_name,
        };

        let conn = self.connection.lock();
        Self::insert_record(&conn, &record)?;
        if matches!(record.status, TranscriptionStatus::Success) {
            Self::record_dictation(&conn, record.word_count, record.audio_duration_seconds)?;
        }
        Ok(record)
    }

    pub fn save_transcription_with_cleanup(
        &self,
        raw_text: String,
        cleaned_text: String,
        audio_path: String,
        metadata: TranscriptionMetadata,
        id_override: Option<String>,
        timestamp_override: Option<DateTime<Local>>,
    ) -> Result<TranscriptionRecord> {
        let record = TranscriptionRecord {
            id: id_override.unwrap_or_else(|| Uuid::new_v4().to_string()),
            timestamp: timestamp_override.unwrap_or_else(Local::now),
            text: cleaned_text,
            raw_text: Some(raw_text),
            audio_available: !audio_path.is_empty(),
            audio_path,
            status: TranscriptionStatus::Success,
            error_message: None,
            llm_cleaned: true,
            speech_model: metadata.speech_model,
            llm_model: metadata.llm_model,
            word_count: metadata.word_count,
            audio_duration_seconds: metadata.audio_duration_seconds,
            synced: metadata.synced,
            mode_id: metadata.mode_id,
            mode_name: metadata.mode_name,
        };

        let conn = self.connection.lock();
        Self::insert_record(&conn, &record)?;
        Self::record_dictation(&conn, record.word_count, record.audio_duration_seconds)?;
        Ok(record)
    }

    pub fn import_transcriptions(&self, items: &[ImportedTranscription]) -> Result<usize> {
        let mut conn = self.connection.lock();
        let tx = conn.transaction()?;

        let mut added = 0usize;
        let mut existing_at = tx.prepare("SELECT text FROM transcriptions WHERE timestamp = ?1")?;
        let mut seen: HashSet<(i64, String)> = HashSet::new();
        for item in items {
            let text = item.text.trim();
            if text.is_empty() {
                continue;
            }
            let timestamp = Local
                .timestamp_millis_opt(item.timestamp_ms)
                .single()
                .unwrap_or_else(Local::now);
            let ts_ms = timestamp.timestamp_millis();
            if !seen.insert((ts_ms, text.to_string())) {
                continue;
            }
            let mut rows = existing_at.query(params![ts_ms])?;
            let mut duplicate = false;
            while let Some(row) = rows.next()? {
                if row.get::<_, String>(0)?.trim() == text {
                    duplicate = true;
                    break;
                }
            }
            if duplicate {
                continue;
            }
            let record = TranscriptionRecord {
                id: Uuid::new_v4().to_string(),
                timestamp,
                text: text.to_string(),
                raw_text: None,
                audio_path: String::new(),
                audio_available: false,
                status: TranscriptionStatus::Success,
                error_message: None,
                llm_cleaned: false,
                speech_model: String::new(),
                llm_model: None,
                word_count: count_words(text),
                audio_duration_seconds: 0.0,
                synced: false,
                mode_id: None,
                mode_name: None,
            };
            Self::insert_record(&tx, &record)?;
            added += 1;
        }
        drop(existing_at);
        tx.commit()?;
        Ok(added)
    }

    pub fn update_with_llm_cleanup(
        &self,
        id: &str,
        cleaned_text: String,
        llm_model: Option<String>,
    ) -> Result<Option<TranscriptionRecord>> {
        let conn = self.connection.lock();
        Self::apply_llm_cleanup(&conn, id, &cleaned_text, llm_model.as_deref())
    }

    pub fn revert_to_raw(&self, id: &str) -> Result<Option<TranscriptionRecord>> {
        let conn = self.connection.lock();
        Self::revert_to_raw_internal(&conn, id)
    }

    pub fn update_transcription_result(
        &self,
        id: &str,
        text: String,
        raw_text: Option<String>,
        status: TranscriptionStatus,
        error_message: Option<String>,
        metadata: TranscriptionMetadata,
    ) -> Result<Option<TranscriptionRecord>> {
        let conn = self.connection.lock();
        let Some(existing) = Self::get_record(&conn, id)? else {
            return Ok(None);
        };
        let was_success = matches!(existing.status, TranscriptionStatus::Success);
        let new_word_count = metadata.word_count;
        let new_duration = metadata.audio_duration_seconds;

        conn.execute(
            "UPDATE transcriptions SET
                text = ?1,
                raw_text = ?2,
                status = ?3,
                error_message = ?4,
                llm_cleaned = ?5,
                speech_model = ?6,
                llm_model = ?7,
                word_count = ?8,
                audio_duration_seconds = ?9,
                synced = ?10,
                mode_id = ?11,
                mode_name = ?12
             WHERE id = ?13",
            params![
                text,
                raw_text,
                status.as_str(),
                error_message,
                raw_text.is_some(),
                metadata.speech_model,
                metadata.llm_model,
                metadata.word_count,
                metadata.audio_duration_seconds,
                metadata.synced,
                metadata.mode_id,
                metadata.mode_name,
                id,
            ],
        )?;

        if !was_success && matches!(status, TranscriptionStatus::Success) {
            Self::record_dictation(&conn, new_word_count, new_duration)?;
        }

        Self::get_record(&conn, id)
    }

    pub fn get_transcriptions_page(
        &self,
        search: Option<&str>,
        after_ms: Option<i64>,
        before_ms: Option<i64>,
        sort: TranscriptionSort,
        limit: usize,
        offset: usize,
    ) -> Result<TranscriptionPage> {
        let search = search.map(str::trim).filter(|value| !value.is_empty());
        let mut conditions = Vec::new();
        let mut values = Vec::new();

        if let Some(search) = search {
            let escaped = search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            conditions.push("(text LIKE ? ESCAPE '\\' OR raw_text LIKE ? ESCAPE '\\')");
            let pattern = Value::Text(format!("%{escaped}%"));
            values.push(pattern.clone());
            values.push(pattern);
        }
        if let Some(after_ms) = after_ms {
            conditions.push("timestamp >= ?");
            values.push(Value::Integer(after_ms));
        }
        if let Some(before_ms) = before_ms {
            conditions.push("timestamp < ?");
            values.push(Value::Integer(before_ms));
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conditions.join(" AND "))
        };
        let order_clause = match sort {
            TranscriptionSort::Recent => "timestamp DESC, id DESC",
            TranscriptionSort::Oldest => "timestamp ASC, id ASC",
            TranscriptionSort::Longest => "word_count DESC, timestamp DESC, id DESC",
            TranscriptionSort::Shortest => "word_count ASC, timestamp DESC, id DESC",
        };
        let query_offset = offset.saturating_sub(1);
        let includes_previous = offset > 0;
        let fetch_limit = limit.saturating_add(usize::from(includes_previous));

        let query = format!(
            "SELECT id, timestamp, text, raw_text, audio_path, status, error_message, llm_cleaned,
                    speech_model, llm_model, word_count, audio_duration_seconds, synced, mode_id, mode_name
             FROM transcriptions{where_clause}
             ORDER BY {order_clause}
             LIMIT ? OFFSET ?"
        );
        let conn = self.connection.lock();
        let total_count = if offset == 0 {
            let count_query = format!("SELECT COUNT(*) FROM transcriptions{where_clause}");
            Some(
                conn.query_row(&count_query, params_from_iter(values.clone()), |row| {
                    row.get::<_, i64>(0).map(|count| count.max(0) as usize)
                })?,
            )
        } else {
            None
        };
        values.push(Value::Integer(fetch_limit as i64));
        values.push(Value::Integer(query_offset as i64));
        let mut records = {
            let mut stmt = conn.prepare(&query)?;
            stmt.query_map(params_from_iter(values), Self::record_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let previous_timestamp = if includes_previous {
            records.first().map(|record| record.timestamp)
        } else {
            None
        };
        if includes_previous && !records.is_empty() {
            records.remove(0);
        }
        Self::resolve_audio_availability(&mut records);

        Ok(TranscriptionPage {
            items: records,
            total_count,
            previous_timestamp,
        })
    }

    pub fn get_recent_transcriptions(&self, limit: usize) -> Result<Vec<TranscriptionRecord>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let mut records = {
            let conn = self.connection.lock();
            let mut stmt = conn.prepare(
                "SELECT id, timestamp, text, raw_text, audio_path, status, error_message, llm_cleaned,
                        speech_model, llm_model, word_count, audio_duration_seconds, synced, mode_id, mode_name
                 FROM transcriptions
                 WHERE status = ?1 AND text <> ''
                 ORDER BY timestamp DESC
                 LIMIT ?2",
            )?;

            stmt.query_map(
                params![TranscriptionStatus::Success.as_str(), limit as i64],
                Self::record_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        Self::resolve_audio_availability(&mut records);
        Ok(records)
    }

    pub fn get_recent_transcriptions_page(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<TranscriptionRecord>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let mut records = {
            let conn = self.connection.lock();
            let mut stmt = conn.prepare(
                "SELECT id, timestamp, text, raw_text, audio_path, status, error_message, llm_cleaned,
                        speech_model, llm_model, word_count, audio_duration_seconds, synced, mode_id, mode_name
                 FROM transcriptions
                 WHERE status = ?1 AND text <> ''
                 ORDER BY timestamp DESC, id DESC
                 LIMIT ?2 OFFSET ?3",
            )?;

            stmt.query_map(
                params![
                    TranscriptionStatus::Success.as_str(),
                    limit as i64,
                    offset as i64
                ],
                Self::record_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        Self::resolve_audio_availability(&mut records);
        Ok(records)
    }

    pub fn search_transcriptions(
        &self,
        needle: &str,
        limit: usize,
    ) -> Result<Vec<TranscriptionRecord>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let escaped = needle
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        let mut records = {
            let conn = self.connection.lock();
            let mut stmt = conn.prepare(
                "SELECT id, timestamp, text, raw_text, audio_path, status, error_message, llm_cleaned,
                        speech_model, llm_model, word_count, audio_duration_seconds, synced, mode_id, mode_name
                 FROM transcriptions
                 WHERE status = ?1 AND text <> ''
                   AND (text LIKE ?2 ESCAPE '\\' OR raw_text LIKE ?2 ESCAPE '\\')
                 ORDER BY timestamp DESC
                 LIMIT ?3",
            )?;

            stmt.query_map(
                params![TranscriptionStatus::Success.as_str(), pattern, limit as i64],
                Self::record_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        Self::resolve_audio_availability(&mut records);
        Ok(records)
    }

    pub fn lifetime_stats(&self) -> Result<LifetimeStats> {
        let conn = self.connection.lock();
        let stats = conn
            .query_row(
                "SELECT words, duration_ms, dictations FROM lifetime_stats WHERE id = 1",
                [],
                |row| {
                    Ok(LifetimeStats {
                        words: row.get::<_, i64>(0)?.max(0) as u64,
                        duration_ms: row.get::<_, i64>(1)?.max(0) as u64,
                        dictations: row.get::<_, i64>(2)?.max(0) as u64,
                    })
                },
            )
            .optional()?;
        Ok(stats.unwrap_or_default())
    }

    pub fn today_dictation_stats(&self, start_ms: i64, end_ms: i64) -> Result<TodayDictationStats> {
        let conn = self.connection.lock();
        conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(word_count), 0),
                    COALESCE(SUM(audio_duration_seconds), 0),
                    COALESCE(MAX(word_count), 0),
                    COALESCE(MAX(audio_duration_seconds), 0),
                    COALESCE(SUM(llm_cleaned), 0)
             FROM transcriptions
             WHERE status = 'success' AND timestamp >= ?1 AND timestamp < ?2",
            params![start_ms, end_ms],
            |row| {
                Ok(TodayDictationStats {
                    count: row.get::<_, i64>(0)?.max(0) as u64,
                    words: row.get::<_, i64>(1)?.max(0) as u64,
                    audio_seconds: row.get::<_, f64>(2)?.max(0.0),
                    longest_words: row.get::<_, i64>(3)?.max(0) as u64,
                    longest_audio_seconds: row.get::<_, f64>(4)?.max(0.0),
                    llm_cleaned_count: row.get::<_, i64>(5)?.max(0) as u64,
                })
            },
        )
        .map_err(Into::into)
    }

    fn record_dictation(
        conn: &Connection,
        word_count: u32,
        audio_duration_seconds: f32,
    ) -> Result<()> {
        let duration_ms = (audio_duration_seconds.max(0.0) * 1000.0).round() as i64;
        conn.execute(
            "UPDATE lifetime_stats
                SET words = words + ?1,
                    duration_ms = duration_ms + ?2,
                    dictations = dictations + 1
                WHERE id = 1",
            params![word_count as i64, duration_ms],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<Option<String>> {
        let conn = self.connection.lock();
        let record = Self::get_record(&conn, id)?;
        if record.is_some() {
            conn.execute("DELETE FROM transcriptions WHERE id = ?1", params![id])?;
        }
        Ok(record.map(|r| r.audio_path))
    }

    pub fn count_prunable_before(&self, cutoff_millis: i64) -> Result<u32> {
        let conn = self.connection.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM transcriptions WHERE timestamp <= ?1",
            params![cutoff_millis],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as u32)
    }

    pub fn prune_before(&self, cutoff_millis: i64) -> Result<Vec<String>> {
        let conn = self.connection.lock();
        let mut stmt =
            conn.prepare("SELECT audio_path FROM transcriptions WHERE timestamp <= ?1")?;
        let audio_paths: Vec<String> = stmt
            .query_map(params![cutoff_millis], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        conn.execute(
            "DELETE FROM transcriptions WHERE timestamp <= ?1",
            params![cutoff_millis],
        )?;
        Ok(audio_paths)
    }

    pub fn prune_before_and_remove_files(&self, cutoff_millis: i64) -> Result<u32> {
        let audio_paths = self.prune_before(cutoff_millis)?;
        let count = audio_paths.len() as u32;
        for audio_path in audio_paths {
            let path = PathBuf::from(audio_path);
            if path.exists() {
                let _ = fs::remove_file(path);
            }
        }
        Ok(count)
    }

    pub fn get_by_id(&self, id: &str) -> Option<TranscriptionRecord> {
        let conn = self.connection.lock();
        match Self::get_record(&conn, id) {
            Ok(record) => record,
            Err(err) => {
                tracing::error!("Failed to read transcription {id}: {err}");
                None
            }
        }
    }

    fn insert_record(conn: &Connection, record: &TranscriptionRecord) -> Result<()> {
        let timestamp = record.timestamp.timestamp_millis();
        conn.execute(
            "INSERT INTO transcriptions (
                id,
                timestamp,
                text,
                raw_text,
                audio_path,
                status,
                error_message,
                llm_cleaned,
                speech_model,
                llm_model,
                word_count,
                audio_duration_seconds,
                synced,
                mode_id,
                mode_name
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                record.id,
                timestamp,
                record.text,
                record.raw_text,
                record.audio_path,
                record.status.as_str(),
                record.error_message,
                if record.llm_cleaned { 1 } else { 0 },
                record.speech_model,
                record.llm_model,
                record.word_count as i64,
                record.audio_duration_seconds as f64,
                if record.synced { 1 } else { 0 },
                record.mode_id,
                record.mode_name,
            ],
        )?;
        Ok(())
    }

    fn apply_llm_cleanup(
        conn: &Connection,
        id: &str,
        cleaned_text: &str,
        llm_model: Option<&str>,
    ) -> Result<Option<TranscriptionRecord>> {
        if let Some(mut record) = Self::get_record(conn, id)? {
            if record.raw_text.is_none() {
                record.raw_text = Some(record.text.clone());
            }
            record.text = cleaned_text.to_string();
            record.llm_cleaned = true;
            record.llm_model = llm_model.map(|value| value.to_string());
            record.word_count = count_words(&record.text);
            record.synced = false;

            conn.execute(
                "UPDATE transcriptions
                 SET text = ?1, raw_text = ?2, llm_cleaned = 1, llm_model = ?3, word_count = ?4, synced = 0
                 WHERE id = ?5",
                params![
                    record.text,
                    record.raw_text,
                    record.llm_model,
                    record.word_count as i64,
                    id
                ],
            )?;

            Ok(Some(record))
        } else {
            Ok(None)
        }
    }

    fn revert_to_raw_internal(conn: &Connection, id: &str) -> Result<Option<TranscriptionRecord>> {
        if let Some(mut record) = Self::get_record(conn, id)?
            && let Some(raw) = record.raw_text.take()
        {
            record.text = raw;
            record.llm_cleaned = false;
            record.word_count = count_words(&record.text);
            record.llm_model = None;
            record.synced = false;
            conn.execute(
                    "UPDATE transcriptions
                     SET text = ?1, raw_text = NULL, llm_cleaned = 0, llm_model = NULL, word_count = ?2, synced = 0
                     WHERE id = ?3",
                    params![record.text, record.word_count as i64, id],
                )?;
            return Ok(Some(record));
        }
        Ok(None)
    }

    fn get_record(conn: &Connection, id: &str) -> Result<Option<TranscriptionRecord>> {
        let mut record = conn
            .query_row(
                "SELECT id, timestamp, text, raw_text, audio_path, status, error_message, llm_cleaned,
                        speech_model, llm_model, word_count, audio_duration_seconds, synced, mode_id, mode_name
                 FROM transcriptions WHERE id = ?1",
                params![id],
                Self::record_from_row,
            )
            .optional()?;
        if let Some(record) = record.as_mut() {
            Self::resolve_audio_availability(std::slice::from_mut(record));
        }
        Ok(record)
    }

    fn resolve_audio_availability(records: &mut [TranscriptionRecord]) {
        let mut dir_listings: HashMap<PathBuf, HashSet<std::ffi::OsString>> = HashMap::new();

        for record in records {
            if record.audio_path.is_empty() {
                record.audio_available = false;
                continue;
            }

            let path = PathBuf::from(&record.audio_path);
            let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) else {
                record.audio_available = path.exists();
                continue;
            };

            let listing = dir_listings.entry(parent.to_path_buf()).or_insert_with(|| {
                std::fs::read_dir(parent)
                    .map(|entries| {
                        entries
                            .filter_map(|entry| entry.ok().map(|e| e.file_name()))
                            .collect()
                    })
                    .unwrap_or_default()
            });

            record.audio_available = listing.contains(file_name);
        }
    }

    fn record_from_row(row: &Row<'_>) -> rusqlite::Result<TranscriptionRecord> {
        let timestamp_ms: i64 = row.get("timestamp")?;
        let timestamp = Local
            .timestamp_millis_opt(timestamp_ms)
            .single()
            .ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    Type::Integer,
                    Box::new(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("Invalid timestamp stored in database: {timestamp_ms}"),
                    )) as Box<dyn std::error::Error + Send + Sync + 'static>,
                )
            })?;

        let status_value: String = row.get("status")?;
        let status = TranscriptionStatus::from_str(&status_value).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                Type::Text,
                Box::new(io::Error::new(io::ErrorKind::InvalidData, err.to_string()))
                    as Box<dyn std::error::Error + Send + Sync + 'static>,
            )
        })?;

        Ok(TranscriptionRecord {
            id: row.get("id")?,
            timestamp,
            text: row.get("text")?,
            raw_text: row.get("raw_text")?,
            audio_path: row.get("audio_path")?,
            // Filled in by resolve_audio_availability after the query.
            audio_available: false,
            status,
            error_message: row.get("error_message")?,
            llm_cleaned: row.get::<_, i64>("llm_cleaned")? == 1,
            speech_model: row.get("speech_model")?,
            llm_model: row.get("llm_model")?,
            word_count: row.get::<_, i64>("word_count")? as u32,
            audio_duration_seconds: row.get::<_, f64>("audio_duration_seconds")? as f32,
            synced: row.get::<_, i64>("synced").unwrap_or(0) == 1,
            mode_id: row.get("mode_id").unwrap_or(None),
            mode_name: row.get("mode_name").unwrap_or(None),
        })
    }

    fn configure_connection(conn: &Connection) -> Result<()> {
        conn.busy_timeout(Duration::from_secs(2))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;\nPRAGMA synchronous = NORMAL;\nPRAGMA foreign_keys = ON;",
        )?;
        Ok(())
    }

    fn apply_migrations(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS transcriptions (
                id TEXT PRIMARY KEY,
                timestamp INTEGER NOT NULL,
                text TEXT NOT NULL,
                raw_text TEXT NULL,
                audio_path TEXT NOT NULL,
                status TEXT NOT NULL,
                error_message TEXT NULL,
                llm_cleaned INTEGER NOT NULL DEFAULT 0,
                speech_model TEXT NOT NULL DEFAULT '',
                llm_model TEXT NULL,
                word_count INTEGER NOT NULL DEFAULT 0,
                audio_duration_seconds REAL NOT NULL DEFAULT 0,
                synced INTEGER NOT NULL DEFAULT 0,
                mode_id TEXT NULL,
                mode_name TEXT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_transcriptions_timestamp ON transcriptions(timestamp);
            CREATE INDEX IF NOT EXISTS idx_transcriptions_status ON transcriptions(status);
            CREATE INDEX IF NOT EXISTS idx_transcriptions_speech_model ON transcriptions(speech_model);

            CREATE TABLE IF NOT EXISTS library_items (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                audio_path TEXT NOT NULL,
                source_path TEXT NOT NULL DEFAULT '',
                store_original INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                progress REAL DEFAULT 0,
                error_message TEXT,
                transcript TEXT,
                segments TEXT,
                words TEXT,
                duration_seconds REAL NOT NULL,
                file_size_bytes INTEGER NOT NULL,
                original_format TEXT NOT NULL,
                created_at TEXT NOT NULL,
                transcribed_at TEXT,
                tags TEXT NOT NULL DEFAULT '[]',
                llm_cleanup_enabled INTEGER NOT NULL DEFAULT 0,
                speech_model TEXT NOT NULL,
                show_timestamps INTEGER NOT NULL DEFAULT 0,
                detect_speakers INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'import',
                speakers TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_library_items_created_at ON library_items(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_library_items_status ON library_items(status);

            CREATE TABLE IF NOT EXISTS lifetime_stats (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                words INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                dictations INTEGER NOT NULL DEFAULT 0
            );",
        )?;

        Self::ensure_column(
            conn,
            "transcriptions",
            "speech_model",
            "ALTER TABLE transcriptions ADD COLUMN speech_model TEXT NOT NULL DEFAULT ''",
        )?;
        Self::ensure_column(
            conn,
            "transcriptions",
            "llm_model",
            "ALTER TABLE transcriptions ADD COLUMN llm_model TEXT NULL",
        )?;
        Self::ensure_column(
            conn,
            "transcriptions",
            "word_count",
            "ALTER TABLE transcriptions ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::ensure_column(
            conn,
            "transcriptions",
            "audio_duration_seconds",
            "ALTER TABLE transcriptions ADD COLUMN audio_duration_seconds REAL NOT NULL DEFAULT 0",
        )?;
        Self::ensure_column(
            conn,
            "transcriptions",
            "synced",
            "ALTER TABLE transcriptions ADD COLUMN synced INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::ensure_column(
            conn,
            "transcriptions",
            "mode_id",
            "ALTER TABLE transcriptions ADD COLUMN mode_id TEXT NULL",
        )?;
        Self::ensure_column(
            conn,
            "transcriptions",
            "mode_name",
            "ALTER TABLE transcriptions ADD COLUMN mode_name TEXT NULL",
        )?;
        Self::ensure_column(
            conn,
            "library_items",
            "show_timestamps",
            "ALTER TABLE library_items ADD COLUMN show_timestamps INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::ensure_column(
            conn,
            "library_items",
            "source_path",
            "ALTER TABLE library_items ADD COLUMN source_path TEXT NOT NULL DEFAULT ''",
        )?;
        Self::ensure_column(
            conn,
            "library_items",
            "store_original",
            "ALTER TABLE library_items ADD COLUMN store_original INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::ensure_column(
            conn,
            "library_items",
            "words",
            "ALTER TABLE library_items ADD COLUMN words TEXT",
        )?;
        Self::ensure_column(
            conn,
            "library_items",
            "kind",
            "ALTER TABLE library_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'import'",
        )?;
        Self::ensure_column(
            conn,
            "library_items",
            "speakers",
            "ALTER TABLE library_items ADD COLUMN speakers TEXT",
        )?;
        Self::ensure_column(
            conn,
            "library_items",
            "detect_speakers",
            "ALTER TABLE library_items ADD COLUMN detect_speakers INTEGER NOT NULL DEFAULT 0",
        )?;

        let stats_seeded: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifetime_stats WHERE id = 1)",
            [],
            |row| row.get(0),
        )?;
        if !stats_seeded {
            conn.execute(
                "INSERT INTO lifetime_stats (id, words, duration_ms, dictations)
                 SELECT 1,
                        COALESCE(SUM(word_count), 0),
                        COALESCE(SUM(CAST(ROUND(audio_duration_seconds * 1000) AS INTEGER)), 0),
                        COUNT(*)
                 FROM transcriptions
                 WHERE status = 'success'",
                [],
            )?;
        }

        Ok(())
    }

    fn ensure_column(conn: &Connection, table: &str, column: &str, add_sql: &str) -> Result<()> {
        if !Self::column_exists(conn, table, column)? {
            conn.execute(add_sql, [])?;
        }
        Ok(())
    }

    fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
        let query = format!("PRAGMA table_info({table})");
        let mut stmt = conn.prepare(&query)?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get("name")?;
            if name == column {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

impl StorageManager {
    pub fn insert_library_item(&self, item: LibraryItem) -> Result<LibraryItem> {
        let conn = self.connection.lock();
        crate::library::repo::insert_library_item(&conn, item)
    }

    pub fn get_library_item(&self, id: &str) -> Result<Option<LibraryItem>> {
        let conn = self.connection.lock();
        crate::library::repo::get_library_item(&conn, &self.library_root, id)
    }

    pub fn get_library_items_page(
        &self,
        filter: LibraryFilter,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<LibraryItem>, bool)> {
        let conn = self.connection.lock();
        crate::library::repo::get_library_items_page(
            &conn,
            &self.library_root,
            filter,
            limit,
            offset,
        )
    }

    pub fn get_recoverable_library_items(&self) -> Result<Vec<LibraryItem>> {
        let conn = self.connection.lock();
        crate::library::repo::get_recoverable_library_items(&conn, &self.library_root)
    }

    pub fn update_library_item(
        &self,
        id: &str,
        patch: LibraryItemPatch,
    ) -> Result<Option<LibraryItem>> {
        let mut conn = self.connection.lock();
        crate::library::repo::update_library_item(&mut conn, &self.library_root, id, patch)
    }

    pub fn delete_library_item(&self, id: &str) -> Result<Option<String>> {
        let conn = self.connection.lock();
        crate::library::repo::delete_library_item(&conn, &self.library_root, id)
    }

    pub fn get_library_tags(&self) -> Result<Vec<String>> {
        let conn = self.connection.lock();
        crate::library::repo::get_library_tags(&conn)
    }
}

fn count_words(text: &str) -> u32 {
    crate::transcribe::count_words(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcription_pages_filter_sort_and_aggregate() {
        let root = std::env::temp_dir().join(format!("glimpse-storage-test-{}", Uuid::new_v4()));
        let storage = StorageManager::new(root.join("transcriptions.db")).unwrap();
        let first = Local.with_ymd_and_hms(2026, 7, 13, 9, 0, 0).unwrap();
        let second = Local.with_ymd_and_hms(2026, 7, 13, 10, 0, 0).unwrap();
        let third = Local.with_ymd_and_hms(2026, 7, 14, 9, 0, 0).unwrap();

        for (text, timestamp, word_count, status) in [
            ("short note", first, 2, TranscriptionStatus::Success),
            (
                "a much longer searchable note",
                second,
                5,
                TranscriptionStatus::Success,
            ),
            ("failed note", third, 0, TranscriptionStatus::Error),
        ] {
            storage
                .save_transcription(
                    text.to_string(),
                    String::new(),
                    status,
                    None,
                    TranscriptionMetadata {
                        word_count,
                        ..Default::default()
                    },
                    None,
                    Some(timestamp),
                )
                .unwrap();
        }

        let recent = storage
            .get_transcriptions_page(None, None, None, TranscriptionSort::Recent, 2, 0)
            .unwrap();
        assert_eq!(recent.total_count, Some(3));
        assert_eq!(recent.previous_timestamp, None);
        assert_eq!(recent.items[0].text, "failed note");

        let next = storage
            .get_transcriptions_page(None, None, None, TranscriptionSort::Recent, 1, 1)
            .unwrap();
        assert_eq!(next.total_count, None);
        assert_eq!(next.previous_timestamp, Some(third));
        assert_eq!(next.items[0].text, "a much longer searchable note");

        let longest = storage
            .get_transcriptions_page(None, None, None, TranscriptionSort::Longest, 3, 0)
            .unwrap();
        assert_eq!(longest.items[0].text, "a much longer searchable note");

        let search = storage
            .get_transcriptions_page(
                Some("searchable"),
                None,
                None,
                TranscriptionSort::Recent,
                10,
                0,
            )
            .unwrap();
        assert_eq!(search.items.len(), 1);

        let stats = storage
            .today_dictation_stats(first.timestamp_millis(), third.timestamp_millis())
            .unwrap();
        assert_eq!(stats.count, 2);
        assert_eq!(stats.words, 7);
        assert_eq!(stats.longest_words, 5);

        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
