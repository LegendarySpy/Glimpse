use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};
use parking_lot::Mutex;
use rusqlite::{params, types::Type, Connection, OptionalExtension, Row, ToSql};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
}

#[derive(Debug, Clone)]
pub struct TranscriptionMetadata {
    pub speech_model: String,
    pub llm_model: Option<String>,
    pub word_count: u32,
    pub audio_duration_seconds: f32,
    pub synced: bool,
}

impl Default for TranscriptionMetadata {
    fn default() -> Self {
        Self {
            speech_model: String::new(),
            llm_model: None,
            word_count: 0,
            audio_duration_seconds: 0.0,
            synced: false,
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

        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn save_transcription(
        &self,
        text: String,
        audio_path: String,
        status: TranscriptionStatus,
        error_message: Option<String>,
        metadata: TranscriptionMetadata,
        id_override: Option<String>,
    ) -> Result<TranscriptionRecord> {
        let record = TranscriptionRecord {
            id: id_override.unwrap_or_else(|| Uuid::new_v4().to_string()),
            timestamp: Local::now(),
            text,
            raw_text: None,
            audio_path,
            status,
            error_message,
            llm_cleaned: false,
            speech_model: metadata.speech_model,
            llm_model: metadata.llm_model,
            word_count: metadata.word_count,
            audio_duration_seconds: metadata.audio_duration_seconds,
            synced: metadata.synced,
        };

        let conn = self.connection.lock();
        Self::insert_record(&conn, &record)?;
        Ok(record)
    }

    pub fn import_transcription(&self, record: TranscriptionRecord) -> Result<bool> {
        let conn = self.connection.lock();

        if Self::get_record(&conn, &record.id)?.is_some() {
            return Ok(false);
        }

        Self::insert_record(&conn, &record)?;
        Ok(true)
    }

    pub fn save_transcription_with_cleanup(
        &self,
        raw_text: String,
        cleaned_text: String,
        audio_path: String,
        metadata: TranscriptionMetadata,
        id_override: Option<String>,
    ) -> Result<TranscriptionRecord> {
        let record = TranscriptionRecord {
            id: id_override.unwrap_or_else(|| Uuid::new_v4().to_string()),
            timestamp: Local::now(),
            text: cleaned_text,
            raw_text: Some(raw_text),
            audio_path,
            status: TranscriptionStatus::Success,
            error_message: None,
            llm_cleaned: true,
            speech_model: metadata.speech_model,
            llm_model: metadata.llm_model,
            word_count: metadata.word_count,
            audio_duration_seconds: metadata.audio_duration_seconds,
            synced: metadata.synced,
        };

        let conn = self.connection.lock();
        Self::insert_record(&conn, &record)?;
        Ok(record)
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

    pub fn mark_as_synced(&self, id: &str) -> Result<()> {
        let conn = self.connection.lock();
        conn.execute(
            "UPDATE transcriptions SET synced = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn get_all(&self) -> Vec<TranscriptionRecord> {
        match self.load_all_from_db() {
            Ok(records) => records,
            Err(err) => {
                eprintln!("Failed to load transcriptions: {err}");
                Vec::new()
            }
        }
    }

    pub fn delete(&self, id: &str) -> Result<Option<String>> {
        let conn = self.connection.lock();
        let record = Self::get_record(&conn, id)?;
        if record.is_some() {
            conn.execute("DELETE FROM transcriptions WHERE id = ?1", params![id])?;
        }
        Ok(record.map(|r| r.audio_path))
    }

    /// Delete all transcription records and return their audio paths
    pub fn delete_all(&self) -> Result<Vec<String>> {
        let conn = self.connection.lock();
        let mut stmt = conn.prepare("SELECT audio_path FROM transcriptions")?;
        let paths = stmt
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        conn.execute("DELETE FROM transcriptions", [])?;
        Ok(paths)
    }

    pub fn get_by_id(&self, id: &str) -> Option<TranscriptionRecord> {
        let conn = self.connection.lock();
        match Self::get_record(&conn, id) {
            Ok(record) => record,
            Err(err) => {
                eprintln!("Failed to read transcription {id}: {err}");
                None
            }
        }
    }

    pub fn get_paginated(
        &self,
        limit: u32,
        offset: u32,
        search_query: Option<&str>,
    ) -> Result<Vec<TranscriptionRecord>> {
        let conn = self.connection.lock();
        let (where_clause, params) = Self::build_search_query(search_query);

        let sql = format!(
            "SELECT id, timestamp, text, raw_text, audio_path, status, error_message, llm_cleaned,
                    speech_model, llm_model, word_count, audio_duration_seconds, synced
             FROM transcriptions
             {}
             ORDER BY timestamp DESC
             LIMIT ?{} OFFSET ?{}",
            where_clause,
            params.len() + 1,
            params.len() + 2
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut query_params = params;
        query_params.push(Box::new(limit));
        query_params.push(Box::new(offset));

        let records = stmt
            .query_map(rusqlite::params_from_iter(query_params.iter()), |row| {
                Self::record_from_row(row)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(records)
    }

    pub fn get_count(&self, search_query: Option<&str>) -> Result<usize> {
        let conn = self.connection.lock();
        let (where_clause, params) = Self::build_search_query(search_query);

        let sql = format!("SELECT COUNT(*) FROM transcriptions {}", where_clause);

        let mut stmt = conn.prepare(&sql)?;
        let count: usize =
            stmt.query_row(rusqlite::params_from_iter(params.iter()), |row| row.get(0))?;

        Ok(count)
    }

    /// Get usage statistics for the account view
    pub fn get_usage_stats(&self) -> Result<UsageStats> {
        let conn = self.connection.lock();

        // Get the start of the current month as timestamp
        let now = Local::now();
        let month_start = now
            .with_day(1)
            .and_then(|d| d.with_hour(0))
            .and_then(|d| d.with_minute(0))
            .and_then(|d| d.with_second(0))
            .and_then(|d| d.with_nanosecond(0))
            .unwrap_or(now);
        let month_start_ms = month_start.timestamp_millis();

        // Cloud models start with "cloud-"
        let cloud_filter = "status = 'success' AND speech_model LIKE 'cloud-%'";

        // Query for cloud minutes this month
        let cloud_minutes_this_month: f64 = conn
            .query_row(
                &format!(
                    "SELECT COALESCE(SUM(audio_duration_seconds), 0) / 60.0
                 FROM transcriptions
                 WHERE timestamp >= ?1 AND {}",
                    cloud_filter
                ),
                params![month_start_ms],
                |row| row.get(0),
            )
            .unwrap_or(0.0);

        // Query for lifetime cloud audio hours
        let cloud_seconds_lifetime: f64 = conn
            .query_row(
                &format!(
                    "SELECT COALESCE(SUM(audio_duration_seconds), 0)
                 FROM transcriptions
                 WHERE {}",
                    cloud_filter
                ),
                [],
                |row| row.get(0),
            )
            .unwrap_or(0.0);

        // Query for total cloud transcription count
        let cloud_transcriptions_count: u32 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM transcriptions WHERE {}", cloud_filter),
                [],
                |row| row.get::<_, i64>(0).map(|c| c as u32),
            )
            .unwrap_or(0);

        // Query for cloud transcriptions this month
        let cloud_transcriptions_this_month: u32 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*)
                 FROM transcriptions
                 WHERE timestamp >= ?1 AND {}",
                    cloud_filter
                ),
                params![month_start_ms],
                |row| row.get::<_, i64>(0).map(|c| c as u32),
            )
            .unwrap_or(0);

        Ok(UsageStats {
            cloud_minutes_this_month: cloud_minutes_this_month as f32,
            cloud_hours_lifetime: (cloud_seconds_lifetime / 3600.0) as f32,
            cloud_transcriptions_count,
            cloud_transcriptions_this_month,
        })
    }

    fn build_search_query(search_query: Option<&str>) -> (String, Vec<Box<dyn ToSql>>) {
        if let Some(query) = search_query {
            if !query.trim().is_empty() {
                let like_query = format!("%{}%", query.trim());
                return (
                    "WHERE text LIKE ?1 OR raw_text LIKE ?1".to_string(),
                    vec![Box::new(like_query)],
                );
            }
        }
        ("".to_string(), Vec::new())
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
                synced
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
        if let Some(mut record) = Self::get_record(conn, id)? {
            if let Some(raw) = record.raw_text.take() {
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
        }
        Ok(None)
    }

    fn get_record(conn: &Connection, id: &str) -> Result<Option<TranscriptionRecord>> {
        conn.query_row(
            "SELECT id, timestamp, text, raw_text, audio_path, status, error_message, llm_cleaned,
                    speech_model, llm_model, word_count, audio_duration_seconds, synced
             FROM transcriptions WHERE id = ?1",
            params![id],
            Self::record_from_row,
        )
        .optional()
        .map_err(Into::into)
    }

    fn load_all_from_db(&self) -> Result<Vec<TranscriptionRecord>> {
        let conn = self.connection.lock();
        let mut stmt = conn.prepare(
            "SELECT id, timestamp, text, raw_text, audio_path, status, error_message, llm_cleaned,
                    speech_model, llm_model, word_count, audio_duration_seconds, synced
             FROM transcriptions ORDER BY timestamp DESC",
        )?;

        let records = stmt
            .query_map([], Self::record_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(records)
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
            status,
            error_message: row.get("error_message")?,
            llm_cleaned: row.get::<_, i64>("llm_cleaned")? == 1,
            speech_model: row.get("speech_model")?,
            llm_model: row.get("llm_model")?,
            word_count: row.get::<_, i64>("word_count")? as u32,
            audio_duration_seconds: row.get::<_, f64>("audio_duration_seconds")? as f32,
            synced: row.get::<_, i64>("synced").unwrap_or(0) == 1,
        })
    }

    fn configure_connection(conn: &Connection) -> Result<()> {
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
                synced INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_transcriptions_timestamp ON transcriptions(timestamp);
            CREATE INDEX IF NOT EXISTS idx_transcriptions_status ON transcriptions(status);
            CREATE INDEX IF NOT EXISTS idx_transcriptions_speech_model ON transcriptions(speech_model);",
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

fn count_words(text: &str) -> u32 {
    text.split_whitespace()
        .filter(|word| !word.is_empty())
        .count() as u32
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UsageStats {
    pub cloud_minutes_this_month: f32,
    pub cloud_hours_lifetime: f32,
    pub cloud_transcriptions_count: u32,
    pub cloud_transcriptions_this_month: u32,
}
