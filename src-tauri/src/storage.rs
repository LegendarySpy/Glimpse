use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::{DateTime, Local};
use parking_lot::Mutex;
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
    pub confidence: Option<f32>,
    /// Whether LLM cleanup was applied
    #[serde(default)]
    pub llm_cleaned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionStatus {
    Success,
    Error,
}

pub struct StorageManager {
    storage_path: PathBuf,
    records: Arc<Mutex<Vec<TranscriptionRecord>>>,
}

impl StorageManager {
    pub fn new(storage_path: PathBuf) -> Result<Self> {
        if let Some(parent) = storage_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("Failed to create storage directory at {}", parent.display())
            })?;
        }

        let records = if storage_path.exists() {
            let data = fs::read_to_string(&storage_path).with_context(|| {
                format!(
                    "Failed to read transcriptions from {}",
                    storage_path.display()
                )
            })?;
            serde_json::from_str(&data).unwrap_or_else(|_| Vec::new())
        } else {
            Vec::new()
        };

        Ok(Self {
            storage_path,
            records: Arc::new(Mutex::new(records)),
        })
    }

    pub fn save_transcription(
        &self,
        text: String,
        audio_path: String,
        status: TranscriptionStatus,
        error_message: Option<String>,
        confidence: Option<f32>,
    ) -> Result<TranscriptionRecord> {
        let record = TranscriptionRecord {
            id: Uuid::new_v4().to_string(),
            timestamp: Local::now(),
            text,
            raw_text: None,
            audio_path,
            status,
            error_message,
            confidence,
            llm_cleaned: false,
        };

        let mut records = self.records.lock();
        records.push(record.clone());
        self.persist(&records)?;

        Ok(record)
    }

    /// Save a transcription with LLM cleanup applied
    pub fn save_transcription_with_cleanup(
        &self,
        raw_text: String,
        cleaned_text: String,
        audio_path: String,
        confidence: Option<f32>,
    ) -> Result<TranscriptionRecord> {
        let record = TranscriptionRecord {
            id: Uuid::new_v4().to_string(),
            timestamp: Local::now(),
            text: cleaned_text,
            raw_text: Some(raw_text),
            audio_path,
            status: TranscriptionStatus::Success,
            error_message: None,
            confidence,
            llm_cleaned: true,
        };

        let mut records = self.records.lock();
        records.push(record.clone());
        self.persist(&records)?;

        Ok(record)
    }

    /// Update an existing transcription with LLM cleaned text
    pub fn update_with_llm_cleanup(
        &self,
        id: &str,
        cleaned_text: String,
    ) -> Result<Option<TranscriptionRecord>> {
        let mut records = self.records.lock();
        if let Some(record) = records.iter_mut().find(|r| r.id == id) {
            // Store raw text if not already stored
            if record.raw_text.is_none() {
                record.raw_text = Some(record.text.clone());
            }
            record.text = cleaned_text;
            record.llm_cleaned = true;
            let updated = record.clone();
            self.persist(&records)?;
            Ok(Some(updated))
        } else {
            Ok(None)
        }
    }

    /// Revert a transcription to its raw text (undo LLM cleanup)
    pub fn revert_to_raw(&self, id: &str) -> Result<Option<TranscriptionRecord>> {
        let mut records = self.records.lock();
        if let Some(record) = records.iter_mut().find(|r| r.id == id) {
            if let Some(raw) = record.raw_text.take() {
                record.text = raw;
                record.llm_cleaned = false;
                let updated = record.clone();
                self.persist(&records)?;
                return Ok(Some(updated));
            }
        }
        Ok(None)
    }

    pub fn get_all(&self) -> Vec<TranscriptionRecord> {
        let records = self.records.lock();
        let mut sorted = records.clone();
        sorted.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        sorted
    }

    pub fn delete(&self, id: &str) -> Result<Option<String>> {
        let mut records = self.records.lock();
        if let Some(pos) = records.iter().position(|r| r.id == id) {
            let removed = records.remove(pos);
            self.persist(&records)?;
            Ok(Some(removed.audio_path))
        } else {
            Ok(None)
        }
    }

    pub fn get_by_id(&self, id: &str) -> Option<TranscriptionRecord> {
        let records = self.records.lock();
        records.iter().find(|r| r.id == id).cloned()
    }

    fn persist(&self, records: &[TranscriptionRecord]) -> Result<()> {
        let json =
            serde_json::to_string_pretty(records).context("Failed to serialize transcriptions")?;
        fs::write(&self.storage_path, json).with_context(|| {
            format!(
                "Failed to write transcriptions to {}",
                self.storage_path.display()
            )
        })?;
        Ok(())
    }
}
