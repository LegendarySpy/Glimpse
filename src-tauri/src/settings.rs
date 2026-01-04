use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_DB_FILE_NAME: &str = "settings.db";
const KEY_ONBOARDING_COMPLETED: &str = "onboarding_completed";
const KEY_SMART_SHORTCUT: &str = "smart_shortcut";
const KEY_SMART_ENABLED: &str = "smart_enabled";
const KEY_HOLD_SHORTCUT: &str = "hold_shortcut";
const KEY_HOLD_ENABLED: &str = "hold_enabled";
const KEY_TOGGLE_SHORTCUT: &str = "toggle_shortcut";
const KEY_TOGGLE_ENABLED: &str = "toggle_enabled";
const KEY_TRANSCRIPTION_MODE: &str = "transcription_mode";
const KEY_LOCAL_MODEL: &str = "local_model";
const KEY_MICROPHONE_DEVICE: &str = "microphone_device";
const KEY_LANGUAGE: &str = "language";
const KEY_LLM_CLEANUP_ENABLED: &str = "llm_cleanup_enabled";
const KEY_LLM_PROVIDER: &str = "llm_provider";
const KEY_LLM_ENDPOINT: &str = "llm_endpoint";
const KEY_LLM_API_KEY: &str = "llm_api_key";
const KEY_LLM_MODEL: &str = "llm_model";
const KEY_USER_CONTEXT: &str = "user_context";
const KEY_USER_NAME: &str = "user_name";
const KEY_PERSONALITIES_NOTES_SEEDED: &str = "personalities_notes_seeded";
const KEY_DICTIONARY: &str = "dictionary";
const KEY_REPLACEMENTS: &str = "replacements";
const KEY_PERSONALITIES: &str = "personalities";
const KEY_EDIT_MODE_ENABLED: &str = "edit_mode_enabled";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Replacement {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Personality {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(default)]
    pub websites: Vec<String>,
    #[serde(default)]
    pub instructions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSettings {
    #[serde(default)]
    pub onboarding_completed: bool,

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
    #[serde(default)]
    pub user_name: String,
    #[serde(default)]
    pub personalities_notes_seeded: bool,
    #[serde(default)]
    pub dictionary: Vec<String>,
    #[serde(default)]
    pub replacements: Vec<Replacement>,
    #[serde(default = "default_personalities")]
    pub personalities: Vec<Personality>,
    #[serde(default)]
    pub edit_mode_enabled: bool,
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

fn default_personalities() -> Vec<Personality> {
    vec![
        Personality {
            id: "messaging".to_string(),
            name: "Messaging".to_string(),
            enabled: true,
            apps: vec!["Messages".to_string(), "Slack".to_string()],
            websites: vec!["slack.com".to_string()],
            instructions: vec![],
        },
        Personality {
            id: "email".to_string(),
            name: "Email".to_string(),
            enabled: true,
            apps: vec![
                "Mail".to_string(),
                "Outlook".to_string(),
                "Spark".to_string(),
            ],
            websites: vec![
                "gmail.com".to_string(),
                "outlook.com".to_string(),
                "mail.yahoo.com".to_string(),
            ],
            instructions: vec![],
        },
        Personality {
            id: "notes".to_string(),
            name: "Notes".to_string(),
            enabled: true,
            apps: vec![
                "Notes".to_string(),
                "Notion".to_string(),
                "Obsidian".to_string(),
                "Craft".to_string(),
                "Affine".to_string(),
            ],
            websites: vec![
                "notion.so".to_string(),
                "craft.do".to_string(),
                "affine.pro".to_string(),
                "obsidian.md".to_string(),
            ],
            instructions: vec![],
        },
        Personality {
            id: "coding".to_string(),
            name: "Coding".to_string(),
            enabled: true,
            apps: vec![
                "Cursor".to_string(),
                "Visual Studio Code".to_string(),
                "Xcode".to_string(),
                "WebStorm".to_string(),
                "IntelliJ IDEA".to_string(),
            ],
            websites: vec![
                "github.com".to_string(),
                "gitlab.com".to_string(),
                "bitbucket.org".to_string(),
            ],
            instructions: vec![],
        },
    ]
}

fn seed_personality_notes(personalities: &mut [Personality]) {
    for personality in personalities.iter_mut() {
        if !personality.instructions.is_empty() {
            continue;
        }

        let defaults = match personality.id.as_str() {
            "messaging" => vec![
                "- Clean up into natural, conversational text—casual and concise like you'd type.".to_string(),
                "- Remove filler words but keep the friendly, informal tone.".to_string(),
            ],
            "email" => vec![
                "- Format as a proper email with greeting and sign-off.".to_string(),
                "- Polish into professional, clear language with short paragraphs.".to_string(),
            ],
            "notes" => vec![
                "- Organize into structured notes with Markdown headings and bullet points.".to_string(),
                "- Remove filler but keep all content scannable and easy to reference.".to_string(),
            ],
            "coding" => vec![
                "- Format code into proper blocks with clear syntax.".to_string(),
                "- Structure technical explanations logically, keeping all details precise.".to_string(),
            ],
            _ => Vec::new(),
        };

        if !defaults.is_empty() {
            personality.instructions = defaults;
        }
    }
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
            user_name: String::new(),
            personalities_notes_seeded: false,
            dictionary: Vec::new(),
            replacements: Vec::new(),
            personalities: default_personalities(),
            edit_mode_enabled: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionMode {
    #[default]
    Cloud,
    Local,
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
    Anthropic,
    Google,
    Xai,
    Groq,
    Cerebras,
    Sambanova,
    Together,
    OpenRouter,
    Perplexity,
    DeepSeek,
    Fireworks,
    Mistral,
    #[serde(other)]
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
        let mut settings = UserSettings::default();
        {
            let conn = self.conn.lock();

            settings.onboarding_completed = self.read_value(
                &conn,
                KEY_ONBOARDING_COMPLETED,
                settings.onboarding_completed,
            )?;
            settings.smart_shortcut =
                self.read_value(&conn, KEY_SMART_SHORTCUT, settings.smart_shortcut.clone())?;
            settings.smart_enabled =
                self.read_value(&conn, KEY_SMART_ENABLED, settings.smart_enabled)?;
            settings.hold_shortcut =
                self.read_value(&conn, KEY_HOLD_SHORTCUT, settings.hold_shortcut.clone())?;
            settings.hold_enabled =
                self.read_value(&conn, KEY_HOLD_ENABLED, settings.hold_enabled)?;
            settings.toggle_shortcut =
                self.read_value(&conn, KEY_TOGGLE_SHORTCUT, settings.toggle_shortcut.clone())?;
            settings.toggle_enabled =
                self.read_value(&conn, KEY_TOGGLE_ENABLED, settings.toggle_enabled)?;
            settings.transcription_mode = self.read_value(
                &conn,
                KEY_TRANSCRIPTION_MODE,
                settings.transcription_mode.clone(),
            )?;
            settings.local_model =
                self.read_value(&conn, KEY_LOCAL_MODEL, settings.local_model.clone())?;
            settings.microphone_device = self.read_value(
                &conn,
                KEY_MICROPHONE_DEVICE,
                settings.microphone_device.clone(),
            )?;
            settings.language = self.read_value(&conn, KEY_LANGUAGE, settings.language.clone())?;
            settings.llm_cleanup_enabled =
                self.read_value(&conn, KEY_LLM_CLEANUP_ENABLED, settings.llm_cleanup_enabled)?;
            settings.llm_provider =
                self.read_value(&conn, KEY_LLM_PROVIDER, settings.llm_provider.clone())?;
            settings.llm_endpoint =
                self.read_value(&conn, KEY_LLM_ENDPOINT, settings.llm_endpoint.clone())?;

            let encrypted_key: String = self.read_value(&conn, KEY_LLM_API_KEY, String::new())?;
            if !encrypted_key.is_empty() {
                if let Some(hardware_uuid) = crate::crypto::get_hardware_uuid() {
                    match crate::crypto::decrypt(&encrypted_key, &hardware_uuid) {
                        Ok(decrypted) => settings.llm_api_key = decrypted,
                        Err(e) => {
                            if !crate::crypto::looks_encrypted(&encrypted_key) {
                                settings.llm_api_key = encrypted_key;
                            } else {
                                eprintln!("Error: Failed to decrypt API key: {}. Key will need to be re-entered.", e);
                            }
                        }
                    }
                } else {
                    eprintln!("Warning: Could not get hardware UUID, API key won't be encrypted");
                    settings.llm_api_key = encrypted_key;
                }
            }

            settings.llm_model =
                self.read_value(&conn, KEY_LLM_MODEL, settings.llm_model.clone())?;
            settings.user_context =
                self.read_value(&conn, KEY_USER_CONTEXT, settings.user_context.clone())?;
            settings.user_name =
                self.read_value(&conn, KEY_USER_NAME, settings.user_name.clone())?;
            settings.personalities_notes_seeded = self.read_value(
                &conn,
                KEY_PERSONALITIES_NOTES_SEEDED,
                settings.personalities_notes_seeded,
            )?;
            settings.dictionary =
                self.read_value(&conn, KEY_DICTIONARY, settings.dictionary.clone())?;
            settings.replacements =
                self.read_value(&conn, KEY_REPLACEMENTS, settings.replacements.clone())?;
            settings.personalities =
                self.read_value(&conn, KEY_PERSONALITIES, settings.personalities.clone())?;
            settings.edit_mode_enabled =
                self.read_value(&conn, KEY_EDIT_MODE_ENABLED, settings.edit_mode_enabled)?;
        }

        if !settings.personalities_notes_seeded {
            seed_personality_notes(&mut settings.personalities);
            settings.personalities_notes_seeded = true;
            self.save(&settings)?;
        }

        Ok(settings)
    }

    /// Persist settings into DB immediately.
    pub fn save(&self, settings: &UserSettings) -> Result<()> {
        let conn = self.conn.lock();
        self.write_value(
            &conn,
            KEY_ONBOARDING_COMPLETED,
            &settings.onboarding_completed,
        )?;
        self.write_value(&conn, KEY_SMART_SHORTCUT, &settings.smart_shortcut)?;
        self.write_value(&conn, KEY_SMART_ENABLED, &settings.smart_enabled)?;
        self.write_value(&conn, KEY_HOLD_SHORTCUT, &settings.hold_shortcut)?;
        self.write_value(&conn, KEY_HOLD_ENABLED, &settings.hold_enabled)?;
        self.write_value(&conn, KEY_TOGGLE_SHORTCUT, &settings.toggle_shortcut)?;
        self.write_value(&conn, KEY_TOGGLE_ENABLED, &settings.toggle_enabled)?;
        self.write_value(&conn, KEY_TRANSCRIPTION_MODE, &settings.transcription_mode)?;
        self.write_value(&conn, KEY_LOCAL_MODEL, &settings.local_model)?;
        self.write_value(&conn, KEY_MICROPHONE_DEVICE, &settings.microphone_device)?;
        self.write_value(&conn, KEY_LANGUAGE, &settings.language)?;
        self.write_value(
            &conn,
            KEY_LLM_CLEANUP_ENABLED,
            &settings.llm_cleanup_enabled,
        )?;
        self.write_value(&conn, KEY_LLM_PROVIDER, &settings.llm_provider)?;
        self.write_value(&conn, KEY_LLM_ENDPOINT, &settings.llm_endpoint)?;

        let stored_key = if settings.llm_api_key.is_empty() {
            String::new()
        } else if let Some(hardware_uuid) = crate::crypto::get_hardware_uuid() {
            crate::crypto::encrypt(&settings.llm_api_key, &hardware_uuid)
                .map_err(|e| anyhow::anyhow!("Failed to encrypt API key: {}", e))?
        } else {
            eprintln!("Warning: Could not get hardware UUID, storing API key unencrypted");
            settings.llm_api_key.clone()
        };
        self.write_value(&conn, KEY_LLM_API_KEY, &stored_key)?;

        self.write_value(&conn, KEY_LLM_MODEL, &settings.llm_model)?;
        self.write_value(&conn, KEY_USER_CONTEXT, &settings.user_context)?;
        self.write_value(&conn, KEY_USER_NAME, &settings.user_name)?;
        self.write_value(
            &conn,
            KEY_PERSONALITIES_NOTES_SEEDED,
            &settings.personalities_notes_seeded,
        )?;
        self.write_value(&conn, KEY_DICTIONARY, &settings.dictionary)?;
        self.write_value(&conn, KEY_REPLACEMENTS, &settings.replacements)?;
        self.write_value(&conn, KEY_PERSONALITIES, &settings.personalities)?;
        self.write_value(&conn, KEY_EDIT_MODE_ENABLED, &settings.edit_mode_enabled)?;
        Ok(())
    }

    fn read_value<T>(&self, conn: &Connection, key: &str, default: T) -> Result<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .context("Failed to read setting from DB")?;

        if let Some(raw) = raw {
            serde_json::from_str(&raw).context("Malformed setting JSON in DB")
        } else {
            Ok(default)
        }
    }

    fn write_value<T>(&self, conn: &Connection, key: &str, value: &T) -> Result<()>
    where
        T: Serialize,
    {
        let data = serde_json::to_string(value)?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, data],
        )
        .with_context(|| format!("Failed to upsert setting '{key}' into DB"))?;
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
