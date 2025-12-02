use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSettings {
    // Onboarding state
    #[serde(default)]
    pub onboarding_completed: bool,

    // Smart mode settings (default enabled)
    #[serde(default = "default_smart_shortcut")]
    pub smart_shortcut: String,
    #[serde(default = "default_true")]
    pub smart_enabled: bool,

    #[serde(default = "default_hold_shortcut")]
    pub hold_shortcut: String,
    #[serde(default)]
    pub hold_enabled: bool,
    #[serde(default = "default_toggle_shortcut")]
    pub toggle_shortcut: String,
    #[serde(default)]
    pub toggle_enabled: bool,
    #[serde(default = "default_transcription_mode")]
    pub transcription_mode: TranscriptionMode,
    #[serde(default = "default_local_model")]
    pub local_model: String,
    pub microphone_device: Option<String>,
    #[serde(default = "default_language")]
    pub language: String,
    // LLM cleanup settings
    #[serde(default)]
    pub llm_cleanup_enabled: bool,
    #[serde(default = "default_llm_provider")]
    pub llm_provider: LlmProvider,
    #[serde(default)]
    pub llm_endpoint: String,
    #[serde(default)]
    pub llm_api_key: String,
    #[serde(default)]
    pub llm_model: String,
    #[serde(default)]
    pub user_context: String,
}

fn default_smart_shortcut() -> String {
    "Control+Space".to_string()
}

fn default_hold_shortcut() -> String {
    "Control+Shift+Space".to_string()
}

fn default_toggle_shortcut() -> String {
    "Control+Alt+Space".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            onboarding_completed: false,
            smart_shortcut: default_smart_shortcut(),
            smart_enabled: true,
            hold_shortcut: default_hold_shortcut(),
            hold_enabled: false,
            toggle_shortcut: default_toggle_shortcut(),
            toggle_enabled: false,
            transcription_mode: default_transcription_mode(),
            local_model: default_local_model(),
            microphone_device: None,
            language: default_language(),
            llm_cleanup_enabled: false,
            llm_provider: default_llm_provider(),
            llm_endpoint: String::new(),
            llm_api_key: String::new(),
            llm_model: String::new(),
            user_context: String::new(),
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LlmProvider {
    #[default]
    None,
    LmStudio,
    Ollama,
    OpenAI,
    Custom,
}

fn default_llm_provider() -> LlmProvider {
    LlmProvider::None
}

pub fn default_local_model() -> String {
    "parakeet_tdt_int8".to_string()
}

fn default_language() -> String {
    "en".to_string()
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
