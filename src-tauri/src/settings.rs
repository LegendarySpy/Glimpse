use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSettings {
    pub shortcut: String,
    #[serde(default = "default_transcription_mode")]
    pub transcription_mode: TranscriptionMode,
    #[serde(default = "default_local_model")]
    pub local_model: String,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            shortcut: "Control+Space".to_string(),
            transcription_mode: default_transcription_mode(),
            local_model: default_local_model(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionMode {
    Cloud,
    Local,
}

impl Default for TranscriptionMode {
    fn default() -> Self {
        TranscriptionMode::Cloud
    }
}

fn default_transcription_mode() -> TranscriptionMode {
    TranscriptionMode::Cloud
}

pub fn default_local_model() -> String {
    "parakeet_tdt_int8".to_string()
}

impl UserSettings {
    pub fn load(app: &AppHandle) -> Result<Self> {
        let path = settings_path(app)?;
        if !path.exists() {
            return Ok(Self::default());
        }

        let contents = fs::read_to_string(&path)
            .with_context(|| format!("Failed to read settings file at {}", path.display()))?;
        let parsed: Self =
            serde_json::from_str(&contents).with_context(|| "Malformed settings JSON")?;
        Ok(parsed)
    }

    pub fn save(&self, app: &AppHandle) -> Result<()> {
        let path = settings_path(app)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "Failed to create settings directory at {}",
                    parent.display()
                )
            })?;
        }
        let data = serde_json::to_string_pretty(self)?;
        fs::write(&path, data)
            .with_context(|| format!("Failed to write settings file at {}", path.display()))?;
        Ok(())
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    let resolver = app.path();
    let mut dir = resolver
        .app_config_dir()
        .or_else(|_| resolver.app_data_dir())
        .context("Unable to resolve config directory")?;
    dir.push("Glimpse");
    dir.push(SETTINGS_FILE_NAME);
    Ok(dir)
}
