use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_DB_FILE_NAME: &str = "settings.db";
const SETTINGS_DB_KEY: &str = "user_settings";

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

pub struct SettingsStore {
    conn: Mutex<Connection>,
}

impl SettingsStore {
    pub fn new(app: &AppHandle) -> Result<Self> {
        let path = db_path(app)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create settings dir {}", parent.display()))?;
        }

        let conn = Connection::open(&path)
            .with_context(|| format!("Failed to open settings DB at {}", path.display()))?;

        let store = Self {
            conn: Mutex::new(conn),
        };

        store.init_schema()?;

        Ok(store)
    }

    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .context("Failed to create settings table")?;
        Ok(())
    }

    /// Load settings from DB, falling back to defaults if empty.
    pub fn load(&self) -> Result<UserSettings> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![SETTINGS_DB_KEY],
                |row| row.get(0),
            )
            .optional()
            .context("Failed to read settings from DB")?;
        drop(conn);

        if let Some(raw) = raw {
            serde_json::from_str(&raw).context("Malformed settings JSON in DB")
        } else {
            Ok(UserSettings::default())
        }
    }

    /// Persist settings into DB immediately.
    pub fn save(&self, settings: &UserSettings) -> Result<()> {
        let data = serde_json::to_string(settings)?;
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![SETTINGS_DB_KEY, data],
        )
        .context("Failed to upsert settings into DB")?;
        Ok(())
    }
}

fn db_path(app: &AppHandle) -> Result<PathBuf> {
    let resolver = app.path();
    let mut dir = resolver
        .app_config_dir()
        .or_else(|_| resolver.app_data_dir())
        .context("Unable to resolve config directory")?;
    dir.push("Glimpse");
    dir.push(SETTINGS_DB_FILE_NAME);
    Ok(dir)
}
