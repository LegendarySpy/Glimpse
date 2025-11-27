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
    pub text: String,
    pub audio_path: String,
    pub status: TranscriptionStatus,
    pub error_message: Option<String>,
    pub confidence: Option<f32>,
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
            audio_path,
            status,
            error_message,
            confidence,
        };

        let mut records = self.records.lock();
        records.push(record.clone());
        self.persist(&records)?;

        Ok(record)
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
