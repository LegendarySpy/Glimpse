use std::{collections::HashSet, env, fs, path::PathBuf, sync::OnceLock, time::Duration};

use anyhow::{Context, Result};
use chrono::{DateTime, Days, Local, Months};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tauri::{AppHandle, Manager};

const SETTINGS_DB_FILE_NAME: &str = "settings.db";
const KEY_ONBOARDING_COMPLETED: &str = "onboarding_completed";
const KEY_SMART_SHORTCUT: &str = "smart_shortcut";
const KEY_SMART_ENABLED: &str = "smart_enabled";
const KEY_HOLD_SHORTCUT: &str = "hold_shortcut";
const KEY_HOLD_ENABLED: &str = "hold_enabled";
const KEY_TOGGLE_SHORTCUT: &str = "toggle_shortcut";
const KEY_TOGGLE_ENABLED: &str = "toggle_enabled";
const KEY_SHORTCUT_BINDINGS: &str = "shortcut_bindings";
const KEY_TRANSCRIPTION_MODE: &str = "transcription_mode";
const KEY_LOCAL_MODEL: &str = "local_model";
const KEY_REMOTE_SPEECH_ENABLED: &str = "remote_speech_enabled";
const KEY_REMOTE_SPEECH_PROVIDER: &str = "remote_speech_provider";
const KEY_REMOTE_SPEECH_ENDPOINT: &str = "remote_speech_endpoint";
const KEY_REMOTE_SPEECH_API_KEY: &str = "remote_speech_api_key";
const KEY_REMOTE_SPEECH_MODEL: &str = "remote_speech_model";
const KEY_MICROPHONE_DEVICE: &str = "microphone_device";
const KEY_LANGUAGE: &str = "language";
const KEY_APP_LOCALE: &str = "app_locale";
const KEY_THEME_MODE: &str = "theme_mode";

const KEY_LLM_ENABLED: &str = "llm_enabled";
const KEY_CLEANUP_ENABLED: &str = "cleanup_enabled";
const KEY_LLM_PROVIDER: &str = "llm_provider";
const KEY_LLM_ENDPOINT: &str = "llm_endpoint";
const KEY_LLM_API_KEY: &str = "llm_api_key";
const KEY_LLM_MODEL: &str = "llm_model";
const KEY_PERSONALITIES_NOTES_SEEDED: &str = "personalities_notes_seeded";
const KEY_DICTIONARY: &str = "dictionary";
const KEY_AUTO_DICTIONARY_ENABLED: &str = "auto_dictionary_enabled";
const KEY_AUTO_DICTIONARY_IGNORED: &str = "auto_dictionary_ignored";
const KEY_REPLACEMENTS: &str = "replacements";
const KEY_PERSONALITIES: &str = "personalities";
const KEY_EDIT_MODE_ENABLED: &str = "edit_mode_enabled";
const KEY_MEDIA_ACTION: &str = "media_action";
const LEGACY_KEY_MEDIA_CONTROL_ENABLED: &str = "media_control_enabled";
const KEY_AUTO_UPDATE_ENABLED: &str = "auto_update_enabled";
const KEY_AUTO_LAUNCH_ENABLED: &str = "auto_launch_enabled";
const KEY_START_IN_BACKGROUND: &str = "start_in_background";
const KEY_AUTO_DELETE_TARGET: &str = "auto_delete_target";
const KEY_AUTO_DELETE_DURATION: &str = "auto_delete_duration";
const LEGACY_KEY_RECORDING_PRUNE_POLICY: &str = "recording_prune_policy";
const LEGACY_KEY_TRANSCRIPTION_PRUNE_POLICY: &str = "transcription_prune_policy";
const KEY_ANALYTICS_ENABLED: &str = "analytics_enabled";
const KEY_ANALYTICS_INSTALL_ID: &str = "analytics_install_id";
const KEY_LOCAL_API_KEY: &str = "local_api_key";
const KEY_LOCAL_API_PORT: &str = "local_api_port";
const KEY_LOCAL_API_MODEL: &str = "local_api_model";
const KEY_LOCAL_API_HOST: &str = "local_api_host";
const KEY_LOCAL_API_START_ON_LAUNCH: &str = "local_api_start_on_launch";
const KEY_LOCAL_API_CORS: &str = "local_api_cors";

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShortcutBinding {
    pub shortcut: String,
    #[serde(default)]
    pub temporary: bool,
    #[serde(default)]
    pub cleanup_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShortcutBindings {
    #[serde(default)]
    pub smart: Vec<ShortcutBinding>,
    #[serde(default)]
    pub hold: Vec<ShortcutBinding>,
    #[serde(default)]
    pub toggle: Vec<ShortcutBinding>,
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
    #[serde(default = "default_shortcut_bindings")]
    pub shortcut_bindings: ShortcutBindings,
    #[serde(default = "default_transcription_mode")]
    pub transcription_mode: TranscriptionMode,
    #[serde(default = "default_local_model")]
    pub local_model: String,
    #[serde(default)]
    pub remote_speech_enabled: bool,
    #[serde(default = "default_remote_speech_provider")]
    pub remote_speech_provider: String,
    #[serde(default = "default_remote_speech_endpoint")]
    pub remote_speech_endpoint: String,
    #[serde(default)]
    pub remote_speech_api_key: String,
    #[serde(default = "default_remote_speech_model")]
    pub remote_speech_model: String,
    pub microphone_device: Option<String>,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_app_locale")]
    pub app_locale: String,
    #[serde(default)]
    pub theme_mode: ThemeMode,

    #[serde(default)]
    pub llm_enabled: bool,
    #[serde(default)]
    pub cleanup_enabled: bool,
    #[serde(default = "default_llm_provider")]
    pub llm_provider: String,
    #[serde(default)]
    pub llm_endpoint: String,
    #[serde(default)]
    pub llm_api_key: String,
    #[serde(default)]
    pub llm_model: String,
    #[serde(default)]
    pub personalities_notes_seeded: bool,
    #[serde(default)]
    pub dictionary: Vec<String>,
    #[serde(default)]
    pub auto_dictionary_enabled: bool,
    #[serde(default)]
    pub auto_dictionary_ignored: Vec<String>,
    #[serde(default)]
    pub replacements: Vec<Replacement>,
    #[serde(default = "default_personalities")]
    pub personalities: Vec<Personality>,
    #[serde(default)]
    pub edit_mode_enabled: bool,
    #[serde(default)]
    pub media_action: MediaAction,
    #[serde(default)]
    pub auto_update_enabled: bool,
    #[serde(default)]
    pub auto_launch_enabled: bool,
    #[serde(default)]
    pub start_in_background: bool,
    #[serde(default = "default_auto_delete_target")]
    pub auto_delete_target: AutoDeleteTarget,
    #[serde(default = "default_auto_delete_duration")]
    pub auto_delete_duration: RecordingPrunePolicy,
    #[serde(default = "default_true")]
    pub analytics_enabled: bool,
    #[serde(default)]
    pub analytics_install_id: String,
    #[serde(skip)]
    pub analytics_first_run: bool,
    pub local_api_key: String,
    #[serde(default = "default_local_api_port")]
    pub local_api_port: u16,
    #[serde(default = "default_local_api_model")]
    pub local_api_model: String,
    #[serde(default = "default_local_api_host")]
    pub local_api_host: String,
    #[serde(default)]
    pub local_api_start_on_launch: bool,
    #[serde(default = "default_local_api_cors")]
    pub local_api_cors: bool,
}

// Alt+Space opens the window menu on Windows, so the hotkey never reaches us.
fn default_smart_shortcut() -> String {
    if cfg!(target_os = "windows") {
        "Control+Shift+Space".to_string()
    } else {
        "Alt+Space".to_string()
    }
}

fn default_hold_shortcut() -> String {
    if cfg!(target_os = "windows") {
        "Control+Alt+Space".to_string()
    } else {
        "Control+Shift+Space".to_string()
    }
}

fn default_toggle_shortcut() -> String {
    if cfg!(target_os = "windows") {
        "Control+Shift+Alt+Space".to_string()
    } else {
        "Control+Alt+Space".to_string()
    }
}

pub fn default_shortcut_bindings() -> ShortcutBindings {
    ShortcutBindings {
        smart: vec![ShortcutBinding {
            shortcut: default_smart_shortcut(),
            temporary: false,
            cleanup_enabled: false,
        }],
        hold: vec![ShortcutBinding {
            shortcut: default_hold_shortcut(),
            temporary: false,
            cleanup_enabled: false,
        }],
        toggle: vec![ShortcutBinding {
            shortcut: default_toggle_shortcut(),
            temporary: false,
            cleanup_enabled: false,
        }],
    }
}

pub fn shortcut_bindings_from_legacy(settings: &UserSettings) -> ShortcutBindings {
    ShortcutBindings {
        smart: vec![ShortcutBinding {
            shortcut: settings.smart_shortcut.clone(),
            temporary: false,
            cleanup_enabled: settings.cleanup_enabled,
        }],
        hold: vec![ShortcutBinding {
            shortcut: settings.hold_shortcut.clone(),
            temporary: false,
            cleanup_enabled: settings.cleanup_enabled,
        }],
        toggle: vec![ShortcutBinding {
            shortcut: settings.toggle_shortcut.clone(),
            temporary: false,
            cleanup_enabled: settings.cleanup_enabled,
        }],
    }
}

pub fn sync_legacy_shortcuts_from_bindings(settings: &mut UserSettings) {
    if let Some(binding) = settings.shortcut_bindings.smart.first() {
        settings.smart_shortcut = binding.shortcut.clone();
    }
    if let Some(binding) = settings.shortcut_bindings.hold.first() {
        settings.hold_shortcut = binding.shortcut.clone();
    }
    if let Some(binding) = settings.shortcut_bindings.toggle.first() {
        settings.toggle_shortcut = binding.shortcut.clone();
    }
}

fn default_true() -> bool {
    true
}

fn owned_app_names(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_string()).collect()
}

#[derive(Clone, Copy)]
struct PersonalityAppDefaults {
    messaging: &'static [&'static str],
    email: &'static [&'static str],
    notes: &'static [&'static str],
    coding: &'static [&'static str],
}

impl PersonalityAppDefaults {
    fn for_personality(self, id: &str) -> Option<&'static [&'static str]> {
        match id {
            "messaging" => Some(self.messaging),
            "email" => Some(self.email),
            "notes" => Some(self.notes),
            "coding" => Some(self.coding),
            _ => None,
        }
    }
}

#[cfg(target_os = "windows")]
const PERSONALITY_APP_DEFAULTS: PersonalityAppDefaults = PersonalityAppDefaults {
    messaging: &["Microsoft Teams", "Slack", "Discord", "WhatsApp"],
    email: &["Outlook", "Thunderbird"],
    notes: &["OneNote", "Sticky Notes", "Notion", "Obsidian"],
    coding: &[
        "Cursor",
        "Visual Studio Code",
        "Visual Studio",
        "WebStorm",
        "IntelliJ IDEA",
    ],
};

#[cfg(not(target_os = "windows"))]
const PERSONALITY_APP_DEFAULTS: PersonalityAppDefaults = PersonalityAppDefaults {
    messaging: &["Messages", "Slack"],
    email: &["Mail", "Outlook", "Spark"],
    notes: &["Notes", "Notion", "Obsidian", "Craft", "Affine"],
    coding: &[
        "Cursor",
        "Visual Studio Code",
        "Xcode",
        "WebStorm",
        "IntelliJ IDEA",
    ],
};

fn default_apps_for(personality_id: &str) -> Vec<String> {
    owned_app_names(
        PERSONALITY_APP_DEFAULTS
            .for_personality(personality_id)
            .expect("known default personality"),
    )
}

fn default_personalities() -> Vec<Personality> {
    vec![
        Personality {
            id: "messaging".to_string(),
            name: "Messaging".to_string(),
            enabled: true,
            apps: default_apps_for("messaging"),
            websites: vec!["slack.com".to_string()],
            instructions: vec![],
        },
        Personality {
            id: "email".to_string(),
            name: "Email".to_string(),
            enabled: true,
            apps: default_apps_for("email"),
            websites: vec![
                "mail.google.com".to_string(),
                "outlook.com".to_string(),
                "mail.yahoo.com".to_string(),
            ],
            instructions: vec![],
        },
        Personality {
            id: "notes".to_string(),
            name: "Notes".to_string(),
            enabled: true,
            apps: default_apps_for("notes"),
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
            apps: default_apps_for("coding"),
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
                "- Write semi-casual, friendly, as if you're messaging someone".to_string(),
                "".to_string(),
                "- Transcribe spoken emoji descriptions directly into icons (e.g., 'laughing face' becomes 😂).".to_string(),
                "".to_string(),
                "- Retain all internet slang, acronyms, and text-speak (e.g., 'tmrw', 'rn', 'omg') exactly as said.".to_string(),
            ],
            "email" => vec![
                "- Write in correct email semi-formal, friendly, formatting with new lines and paragraphs.".to_string(),
                "".to_string(),
                "- Fix run-on sentences by breaking them into distinct, logical statements.".to_string(),
                "".to_string(),
                "- Ensure standard capitalization and punctuation rules are applied strictly.".to_string(),
                "".to_string(),
                "- Sign off emails with [My Name].".to_string(),
            ],
            "notes" => vec![
                "- Distill into a concise, scannable format based on the user's speech.".to_string(),
                "".to_string(),
                "- Remove conversational filler (ums, ahs), repetitive thoughts, and fluff.".to_string(),
                "".to_string(),
                "- Utilize Markdown syntax: Use bullet points for lists and bold text for key concepts.".to_string(),
                "".to_string(),
                "- Rephrase rambling narrative into direct, active-voice statements based on the user's speech.".to_string(),
            ],
            "coding" => vec![
                "- Treat technical keywords, library names, and logic as immutable constants based on the user's speech; do not rephrase them.".to_string(),
                "".to_string(),
                "- Apply proper casing conventions to variables and functions based on context (e.g., camelCase for JS, snake_case for Python) based on the user's speech.".to_string(),
                "".to_string(),
                "- Prioritize syntax accuracy over conversational flow based on the user's speech.".to_string(),
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
            shortcut_bindings: default_shortcut_bindings(),
            transcription_mode: default_transcription_mode(),
            local_model: default_local_model(),
            remote_speech_enabled: false,
            remote_speech_provider: default_remote_speech_provider(),
            remote_speech_endpoint: default_remote_speech_endpoint(),
            remote_speech_api_key: String::new(),
            remote_speech_model: default_remote_speech_model(),
            microphone_device: None,
            language: default_language(),
            app_locale: default_app_locale(),
            theme_mode: ThemeMode::default(),

            llm_enabled: false,
            cleanup_enabled: false,
            llm_provider: default_llm_provider(),
            llm_endpoint: String::new(),
            llm_api_key: String::new(),
            llm_model: String::new(),
            personalities_notes_seeded: false,
            dictionary: Vec::new(),
            auto_dictionary_enabled: false,
            auto_dictionary_ignored: Vec::new(),
            replacements: Vec::new(),
            personalities: default_personalities(),
            edit_mode_enabled: false,
            media_action: MediaAction::Off,
            auto_update_enabled: false,
            auto_launch_enabled: false,
            start_in_background: true,
            auto_delete_target: default_auto_delete_target(),
            auto_delete_duration: default_auto_delete_duration(),
            analytics_enabled: true,
            analytics_install_id: String::new(),
            analytics_first_run: false,
            local_api_key: String::new(),
            local_api_port: default_local_api_port(),
            local_api_model: default_local_api_model(),
            local_api_host: default_local_api_host(),
            local_api_start_on_launch: false,
            local_api_cors: default_local_api_cors(),
        }
    }
}

pub fn default_local_api_port() -> u16 {
    11435
}

pub fn default_local_api_cors() -> bool {
    false
}

pub fn default_local_api_model() -> String {
    "auto".to_string()
}

pub fn default_remote_speech_provider() -> String {
    "openai".to_string()
}

pub fn default_remote_speech_endpoint() -> String {
    "https://api.openai.com/v1".to_string()
}

pub fn default_remote_speech_model() -> String {
    "auto".to_string()
}

pub fn default_local_api_host() -> String {
    "127.0.0.1".to_string()
}

pub fn canonicalize_local_api_host(value: &str) -> String {
    if value == "0.0.0.0" {
        "0.0.0.0".to_string()
    } else {
        default_local_api_host()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionMode {
    #[default]
    Local,
    Cloud,
}

fn default_transcription_mode() -> TranscriptionMode {
    TranscriptionMode::Local
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RecordingPrunePolicy {
    #[default]
    Never,
    Immediately,
    Day,
    Week,
    Month,
    ThreeMonths,
    Year,
}

fn default_auto_delete_duration() -> RecordingPrunePolicy {
    RecordingPrunePolicy::Never
}

pub fn canonicalize_recording_prune_policy(policy: RecordingPrunePolicy) -> RecordingPrunePolicy {
    match policy {
        RecordingPrunePolicy::ThreeMonths => RecordingPrunePolicy::Year,
        policy => policy,
    }
}

pub(crate) fn recording_prune_cutoff(
    policy: RecordingPrunePolicy,
    now: DateTime<Local>,
) -> Option<DateTime<Local>> {
    match policy {
        RecordingPrunePolicy::Never => None,
        RecordingPrunePolicy::Immediately => Some(now),
        RecordingPrunePolicy::Day => now.checked_sub_days(Days::new(1)),
        RecordingPrunePolicy::Week => now.checked_sub_days(Days::new(7)),
        RecordingPrunePolicy::Month => now.checked_sub_months(Months::new(1)),
        RecordingPrunePolicy::ThreeMonths => now.checked_sub_months(Months::new(3)),
        RecordingPrunePolicy::Year => now.checked_sub_months(Months::new(12)),
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AutoDeleteTarget {
    #[default]
    Transcripts,
    Audio,
}

fn default_auto_delete_target() -> AutoDeleteTarget {
    AutoDeleteTarget::Transcripts
}

pub fn auto_delete_recording_policy(settings: &UserSettings) -> RecordingPrunePolicy {
    match settings.auto_delete_target {
        AutoDeleteTarget::Audio => settings.auto_delete_duration,
        AutoDeleteTarget::Transcripts => RecordingPrunePolicy::Never,
    }
}

pub fn auto_delete_transcription_policy(settings: &UserSettings) -> RecordingPrunePolicy {
    match settings.auto_delete_target {
        AutoDeleteTarget::Audio => RecordingPrunePolicy::Never,
        AutoDeleteTarget::Transcripts => settings.auto_delete_duration,
    }
}

fn migrate_auto_delete_from_legacy(
    settings: &mut UserSettings,
    legacy_recording: RecordingPrunePolicy,
    legacy_transcription: RecordingPrunePolicy,
) {
    if legacy_transcription != RecordingPrunePolicy::Never {
        settings.auto_delete_target = AutoDeleteTarget::Transcripts;
        settings.auto_delete_duration = canonicalize_recording_prune_policy(legacy_transcription);
        return;
    }

    if legacy_recording != RecordingPrunePolicy::Never {
        settings.auto_delete_target = AutoDeleteTarget::Audio;
        settings.auto_delete_duration = canonicalize_recording_prune_policy(legacy_recording);
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MediaAction {
    #[default]
    Off,
    Pause,
    Duck10,
    Duck25,
    Duck50,
    Duck75,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

fn default_llm_provider() -> String {
    "none".to_string()
}

pub fn default_local_model() -> String {
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "whisper_small_q5".to_string()
    }

    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    {
        "parakeet_tdt_int8".to_string()
    }
}

fn default_language() -> String {
    "en".to_string()
}

fn default_app_locale() -> String {
    "system".to_string()
}

const SUPPORTED_APP_LOCALES_JSON: &str = include_str!("../../supported-app-locales.json");
static SUPPORTED_APP_LOCALES: OnceLock<Vec<String>> = OnceLock::new();

fn supported_app_locales() -> &'static [String] {
    SUPPORTED_APP_LOCALES
        .get_or_init(|| {
            // Main source of truth for shipped app translations.
            let locales: Vec<String> = serde_json::from_str(SUPPORTED_APP_LOCALES_JSON)
                .expect("supported-app-locales.json must be a JSON array of locale strings");

            if locales.is_empty() {
                panic!("supported-app-locales.json must not be empty");
            }

            let mut seen = HashSet::new();
            for locale in &locales {
                if locale.is_empty()
                    || locale.trim() != locale
                    || locale.to_ascii_lowercase() != *locale
                {
                    panic!("supported-app-locales.json must use lowercase, trimmed locale codes");
                }

                if !seen.insert(locale.clone()) {
                    panic!("supported-app-locales.json cannot contain duplicate locale codes");
                }
            }

            locales
        })
        .as_slice()
}

pub fn canonicalize_app_locale(value: &str) -> Option<String> {
    let normalized = value.trim().replace('_', "-").to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }

    if normalized == default_app_locale() {
        return Some(normalized);
    }

    if supported_app_locales()
        .iter()
        .any(|locale| locale == &normalized)
    {
        return Some(normalized);
    }

    None
}

pub fn canonicalize_app_locale_or_default(value: &str) -> String {
    canonicalize_app_locale(value).unwrap_or_else(default_app_locale)
}

pub struct SettingsStore {
    conn: Mutex<Connection>,
    llm_api_key_ciphertext: Mutex<Option<String>>,
    remote_speech_api_key_ciphertext: Mutex<Option<String>>,
    local_api_key_ciphertext: Mutex<Option<String>>,
}

impl SettingsStore {
    pub fn new(app: &AppHandle) -> Result<Self> {
        Self::open(db_path(app)?)
    }

    pub(crate) fn for_cli(app_identifier: &str) -> Result<Self> {
        Self::open(settings_db_path(cli_app_config_dir(app_identifier)?))
    }

    fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create settings dir {}", parent.display()))?;
        }

        let conn = Connection::open(&path)
            .with_context(|| format!("Failed to open settings DB at {}", path.display()))?;
        conn.busy_timeout(Duration::from_secs(2))?;
        conn.execute_batch("PRAGMA journal_mode = WAL;\nPRAGMA synchronous = NORMAL;")?;

        let store = Self {
            conn: Mutex::new(conn),
            llm_api_key_ciphertext: Mutex::new(None),
            remote_speech_api_key_ciphertext: Mutex::new(None),
            local_api_key_ciphertext: Mutex::new(None),
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
        let mut should_persist = false;
        let mut llm_api_key_ciphertext: Option<String> = None;
        let mut remote_speech_api_key_ciphertext: Option<String> = None;
        let mut local_api_key_ciphertext: Option<String> = None;
        let encrypted_llm_api_key: String;
        let encrypted_remote_speech_api_key: String;
        let encrypted_local_api_key: String;
        let theme_mode_exists: bool;
        let shortcut_bindings_exists: bool;
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
            let shortcut_bindings =
                self.read_optional_value::<ShortcutBindings>(&conn, KEY_SHORTCUT_BINDINGS)?;
            shortcut_bindings_exists = shortcut_bindings.is_some();
            if let Some(shortcut_bindings) = shortcut_bindings {
                settings.shortcut_bindings = shortcut_bindings;
            }
            settings.transcription_mode = self.read_value(
                &conn,
                KEY_TRANSCRIPTION_MODE,
                settings.transcription_mode.clone(),
            )?;
            settings.local_model =
                self.read_value(&conn, KEY_LOCAL_MODEL, settings.local_model.clone())?;
            settings.remote_speech_enabled = self.read_value(
                &conn,
                KEY_REMOTE_SPEECH_ENABLED,
                settings.remote_speech_enabled,
            )?;
            settings.remote_speech_provider = self.read_value(
                &conn,
                KEY_REMOTE_SPEECH_PROVIDER,
                settings.remote_speech_provider.clone(),
            )?;
            settings.remote_speech_endpoint = self.read_value(
                &conn,
                KEY_REMOTE_SPEECH_ENDPOINT,
                settings.remote_speech_endpoint.clone(),
            )?;
            encrypted_remote_speech_api_key =
                self.read_value(&conn, KEY_REMOTE_SPEECH_API_KEY, String::new())?;
            settings.remote_speech_model = self.read_value(
                &conn,
                KEY_REMOTE_SPEECH_MODEL,
                settings.remote_speech_model.clone(),
            )?;
            settings.microphone_device = self.read_value(
                &conn,
                KEY_MICROPHONE_DEVICE,
                settings.microphone_device.clone(),
            )?;
            settings.language = self.read_value(&conn, KEY_LANGUAGE, settings.language.clone())?;
            settings.app_locale =
                self.read_value(&conn, KEY_APP_LOCALE, settings.app_locale.clone())?;
            let theme_mode = self.read_optional_value::<ThemeMode>(&conn, KEY_THEME_MODE)?;
            theme_mode_exists = theme_mode.is_some();
            settings.theme_mode = theme_mode.unwrap_or(settings.theme_mode);

            settings.llm_enabled = self.read_value(&conn, KEY_LLM_ENABLED, settings.llm_enabled)?;
            settings.cleanup_enabled =
                self.read_value(&conn, KEY_CLEANUP_ENABLED, settings.cleanup_enabled)?;
            settings.llm_provider =
                self.read_value(&conn, KEY_LLM_PROVIDER, settings.llm_provider.clone())?;
            settings.llm_endpoint =
                self.read_value(&conn, KEY_LLM_ENDPOINT, settings.llm_endpoint.clone())?;

            encrypted_llm_api_key = self.read_value(&conn, KEY_LLM_API_KEY, String::new())?;

            settings.llm_model =
                self.read_value(&conn, KEY_LLM_MODEL, settings.llm_model.clone())?;
            settings.personalities_notes_seeded = self.read_value(
                &conn,
                KEY_PERSONALITIES_NOTES_SEEDED,
                settings.personalities_notes_seeded,
            )?;
            settings.dictionary =
                self.read_value(&conn, KEY_DICTIONARY, settings.dictionary.clone())?;
            settings.auto_dictionary_enabled = self.read_value(
                &conn,
                KEY_AUTO_DICTIONARY_ENABLED,
                settings.auto_dictionary_enabled,
            )?;
            settings.auto_dictionary_ignored = self.read_value(
                &conn,
                KEY_AUTO_DICTIONARY_IGNORED,
                settings.auto_dictionary_ignored.clone(),
            )?;
            settings.replacements =
                self.read_value(&conn, KEY_REPLACEMENTS, settings.replacements.clone())?;
            settings.personalities =
                self.read_value(&conn, KEY_PERSONALITIES, settings.personalities.clone())?;
            settings.edit_mode_enabled =
                self.read_value(&conn, KEY_EDIT_MODE_ENABLED, settings.edit_mode_enabled)?;
            if let Some(media_action) =
                self.read_optional_value::<MediaAction>(&conn, KEY_MEDIA_ACTION)?
            {
                settings.media_action = media_action;
            } else if let Some(legacy_enabled) =
                self.read_optional_value::<bool>(&conn, LEGACY_KEY_MEDIA_CONTROL_ENABLED)?
            {
                settings.media_action = if legacy_enabled {
                    MediaAction::Pause
                } else {
                    MediaAction::Off
                };
                should_persist = true;
            }
            settings.auto_update_enabled =
                self.read_value(&conn, KEY_AUTO_UPDATE_ENABLED, settings.auto_update_enabled)?;
            settings.auto_launch_enabled =
                self.read_value(&conn, KEY_AUTO_LAUNCH_ENABLED, settings.auto_launch_enabled)?;
            settings.start_in_background =
                self.read_value(&conn, KEY_START_IN_BACKGROUND, settings.start_in_background)?;
            settings.auto_delete_target =
                self.read_value(&conn, KEY_AUTO_DELETE_TARGET, settings.auto_delete_target)?;
            let auto_delete_duration =
                self.read_optional_value::<RecordingPrunePolicy>(&conn, KEY_AUTO_DELETE_DURATION)?;
            if let Some(duration) = auto_delete_duration {
                settings.auto_delete_duration = duration;
            } else {
                let legacy_recording = self.read_value(
                    &conn,
                    LEGACY_KEY_RECORDING_PRUNE_POLICY,
                    RecordingPrunePolicy::Never,
                )?;
                let legacy_transcription = self.read_value(
                    &conn,
                    LEGACY_KEY_TRANSCRIPTION_PRUNE_POLICY,
                    RecordingPrunePolicy::Never,
                )?;
                migrate_auto_delete_from_legacy(
                    &mut settings,
                    legacy_recording,
                    legacy_transcription,
                );
                should_persist = true;
            }
            settings.analytics_enabled =
                self.read_value(&conn, KEY_ANALYTICS_ENABLED, settings.analytics_enabled)?;
            settings.analytics_install_id = self.read_value(
                &conn,
                KEY_ANALYTICS_INSTALL_ID,
                settings.analytics_install_id.clone(),
            )?;
            encrypted_local_api_key = self.read_value(&conn, KEY_LOCAL_API_KEY, String::new())?;
            settings.local_api_port =
                self.read_value(&conn, KEY_LOCAL_API_PORT, settings.local_api_port)?;
            settings.local_api_model =
                self.read_value(&conn, KEY_LOCAL_API_MODEL, settings.local_api_model.clone())?;
            settings.local_api_host =
                self.read_value(&conn, KEY_LOCAL_API_HOST, settings.local_api_host.clone())?;
            settings.local_api_start_on_launch = self.read_value(
                &conn,
                KEY_LOCAL_API_START_ON_LAUNCH,
                settings.local_api_start_on_launch,
            )?;
            settings.local_api_cors =
                self.read_value(&conn, KEY_LOCAL_API_CORS, settings.local_api_cors)?;
        }

        if !encrypted_llm_api_key.is_empty() {
            let key_looks_encrypted = crate::crypto::looks_encrypted(&encrypted_llm_api_key);
            if let Some(hardware_uuid) = crate::crypto::get_hardware_uuid() {
                match crate::crypto::decrypt(&encrypted_llm_api_key, &hardware_uuid) {
                    Ok(decrypted) => settings.llm_api_key = decrypted,
                    Err(e) => {
                        if !key_looks_encrypted {
                            settings.llm_api_key = encrypted_llm_api_key;
                        } else {
                            tracing::error!(
                                "Error: Failed to decrypt API key: {}. Preserving encrypted value.",
                                e
                            );
                            settings.llm_api_key = String::new();
                            llm_api_key_ciphertext = Some(encrypted_llm_api_key);
                        }
                    }
                }
            } else {
                tracing::error!("Warning: Could not get hardware UUID, preserving stored API key");
                if key_looks_encrypted {
                    settings.llm_api_key = String::new();
                    llm_api_key_ciphertext = Some(encrypted_llm_api_key);
                } else {
                    settings.llm_api_key = encrypted_llm_api_key;
                }
            }
        }
        *self.llm_api_key_ciphertext.lock() = llm_api_key_ciphertext;

        if !encrypted_remote_speech_api_key.is_empty() {
            let key_looks_encrypted =
                crate::crypto::looks_encrypted(&encrypted_remote_speech_api_key);
            if let Some(hardware_uuid) = crate::crypto::get_hardware_uuid() {
                match crate::crypto::decrypt(&encrypted_remote_speech_api_key, &hardware_uuid) {
                    Ok(decrypted) => settings.remote_speech_api_key = decrypted,
                    Err(e) => {
                        if !key_looks_encrypted {
                            settings.remote_speech_api_key = encrypted_remote_speech_api_key;
                        } else {
                            tracing::error!(
                                "Error: Failed to decrypt remote speech API key: {}. Preserving encrypted value.",
                                e
                            );
                            settings.remote_speech_api_key = String::new();
                            remote_speech_api_key_ciphertext =
                                Some(encrypted_remote_speech_api_key);
                        }
                    }
                }
            } else {
                tracing::error!(
                    "Warning: Could not get hardware UUID, preserving stored remote speech API key"
                );
                if key_looks_encrypted {
                    settings.remote_speech_api_key = String::new();
                    remote_speech_api_key_ciphertext = Some(encrypted_remote_speech_api_key);
                } else {
                    settings.remote_speech_api_key = encrypted_remote_speech_api_key;
                }
            }
        }
        *self.remote_speech_api_key_ciphertext.lock() = remote_speech_api_key_ciphertext;

        if !encrypted_local_api_key.is_empty() {
            let key_looks_encrypted = crate::crypto::looks_encrypted(&encrypted_local_api_key);
            if let Some(hardware_uuid) = crate::crypto::get_hardware_uuid() {
                match crate::crypto::decrypt(&encrypted_local_api_key, &hardware_uuid) {
                    Ok(decrypted) => settings.local_api_key = decrypted,
                    Err(e) => {
                        if !key_looks_encrypted {
                            settings.local_api_key = encrypted_local_api_key;
                        } else {
                            tracing::error!(
                                "Error: Failed to decrypt Local API key: {}. Preserving encrypted value.",
                                e
                            );
                            settings.local_api_key = String::new();
                            local_api_key_ciphertext = Some(encrypted_local_api_key);
                        }
                    }
                }
            } else {
                tracing::error!(
                    "Warning: Could not get hardware UUID, preserving stored Local API key"
                );
                if key_looks_encrypted {
                    settings.local_api_key = String::new();
                    local_api_key_ciphertext = Some(encrypted_local_api_key);
                } else {
                    settings.local_api_key = encrypted_local_api_key;
                }
            }
        }
        *self.local_api_key_ciphertext.lock() = local_api_key_ciphertext;

        if settings.analytics_install_id.is_empty() {
            settings.analytics_install_id = uuid::Uuid::new_v4().to_string();
            settings.analytics_first_run = true;
            should_persist = true;
        }

        if !settings.personalities_notes_seeded {
            seed_personality_notes(&mut settings.personalities);
            settings.personalities_notes_seeded = true;
            should_persist = true;
        }

        if !theme_mode_exists {
            should_persist = true;
        }

        if !shortcut_bindings_exists {
            settings.shortcut_bindings = shortcut_bindings_from_legacy(&settings);
            should_persist = true;
        }

        if settings.cleanup_enabled {
            if !shortcut_bindings_exists {
                for binding in settings
                    .shortcut_bindings
                    .smart
                    .iter_mut()
                    .chain(settings.shortcut_bindings.hold.iter_mut())
                    .chain(settings.shortcut_bindings.toggle.iter_mut())
                {
                    binding.cleanup_enabled = true;
                }
            }
            settings.cleanup_enabled = false;
            should_persist = true;
        }

        sync_legacy_shortcuts_from_bindings(&mut settings);

        if crate::model_manager::definition(&settings.local_model).is_none() {
            settings.local_model = default_local_model();
            should_persist = true;
        }

        if matches!(settings.transcription_mode, TranscriptionMode::Cloud) {
            settings.transcription_mode = TranscriptionMode::Local;
            should_persist = true;
        }

        let canonical_auto_delete_duration =
            canonicalize_recording_prune_policy(settings.auto_delete_duration);
        if settings.auto_delete_duration != canonical_auto_delete_duration {
            settings.auto_delete_duration = canonical_auto_delete_duration;
            should_persist = true;
        }

        let canonical_locale = canonicalize_app_locale_or_default(&settings.app_locale);
        if settings.app_locale != canonical_locale {
            settings.app_locale = canonical_locale;
            should_persist = true;
        }

        if settings.local_api_port == 0 {
            settings.local_api_port = default_local_api_port();
            should_persist = true;
        }

        if settings.local_api_model.trim().is_empty()
            || (settings.local_api_model != "auto"
                && crate::model_manager::definition(&settings.local_api_model).is_none())
        {
            settings.local_api_model = default_local_api_model();
            should_persist = true;
        }

        let canonical_host = canonicalize_local_api_host(&settings.local_api_host);
        if settings.local_api_host != canonical_host {
            settings.local_api_host = canonical_host;
            should_persist = true;
        }

        if should_persist {
            self.save(&settings)?;
        }

        Ok(settings)
    }

    /// Persist settings into DB immediately.
    pub fn save(&self, settings: &UserSettings) -> Result<()> {
        let stored_app_locale = canonicalize_app_locale_or_default(&settings.app_locale);
        let stored_key = {
            let mut llm_api_key_ciphertext = self.llm_api_key_ciphertext.lock();
            if settings.llm_api_key.is_empty() {
                llm_api_key_ciphertext.clone().unwrap_or_default()
            } else if llm_api_key_ciphertext
                .as_ref()
                .is_some_and(|ciphertext| ciphertext == &settings.llm_api_key)
            {
                settings.llm_api_key.clone()
            } else if let Some(hardware_uuid) = crate::crypto::get_hardware_uuid() {
                *llm_api_key_ciphertext = None;
                crate::crypto::encrypt(&settings.llm_api_key, &hardware_uuid)
                    .map_err(|e| anyhow::anyhow!("Failed to encrypt API key: {}", e))?
            } else {
                *llm_api_key_ciphertext = None;
                tracing::error!(
                    "Warning: Could not get hardware UUID, storing API key unencrypted"
                );
                settings.llm_api_key.clone()
            }
        };
        let stored_remote_speech_api_key = {
            let mut remote_speech_api_key_ciphertext = self.remote_speech_api_key_ciphertext.lock();
            if settings.remote_speech_api_key.is_empty() {
                remote_speech_api_key_ciphertext.clone().unwrap_or_default()
            } else if remote_speech_api_key_ciphertext
                .as_ref()
                .is_some_and(|ciphertext| ciphertext == &settings.remote_speech_api_key)
            {
                settings.remote_speech_api_key.clone()
            } else if let Some(hardware_uuid) = crate::crypto::get_hardware_uuid() {
                *remote_speech_api_key_ciphertext = None;
                crate::crypto::encrypt(&settings.remote_speech_api_key, &hardware_uuid).map_err(
                    |e| anyhow::anyhow!("Failed to encrypt remote speech API key: {}", e),
                )?
            } else {
                *remote_speech_api_key_ciphertext = None;
                tracing::error!(
                    "Warning: Could not get hardware UUID, storing remote speech API key unencrypted"
                );
                settings.remote_speech_api_key.clone()
            }
        };
        let stored_local_api_key = {
            let mut local_api_key_ciphertext = self.local_api_key_ciphertext.lock();
            if settings.local_api_key.is_empty() {
                local_api_key_ciphertext.clone().unwrap_or_default()
            } else if local_api_key_ciphertext
                .as_ref()
                .is_some_and(|ciphertext| ciphertext == &settings.local_api_key)
            {
                settings.local_api_key.clone()
            } else if let Some(hardware_uuid) = crate::crypto::get_hardware_uuid() {
                *local_api_key_ciphertext = None;
                crate::crypto::encrypt(&settings.local_api_key, &hardware_uuid)
                    .map_err(|e| anyhow::anyhow!("Failed to encrypt Local API key: {}", e))?
            } else {
                *local_api_key_ciphertext = None;
                tracing::error!(
                    "Warning: Could not get hardware UUID, storing Local API key unencrypted"
                );
                settings.local_api_key.clone()
            }
        };

        let mut connection = self.conn.lock();
        let conn = connection
            .transaction()
            .context("Failed to start settings transaction")?;
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
        self.write_value(&conn, KEY_SHORTCUT_BINDINGS, &settings.shortcut_bindings)?;
        self.write_value(&conn, KEY_TRANSCRIPTION_MODE, &settings.transcription_mode)?;
        self.write_value(&conn, KEY_LOCAL_MODEL, &settings.local_model)?;
        self.write_value(
            &conn,
            KEY_REMOTE_SPEECH_ENABLED,
            &settings.remote_speech_enabled,
        )?;
        self.write_value(
            &conn,
            KEY_REMOTE_SPEECH_PROVIDER,
            &settings.remote_speech_provider,
        )?;
        self.write_value(
            &conn,
            KEY_REMOTE_SPEECH_ENDPOINT,
            &settings.remote_speech_endpoint,
        )?;
        self.write_value(
            &conn,
            KEY_REMOTE_SPEECH_API_KEY,
            &stored_remote_speech_api_key,
        )?;
        self.write_value(
            &conn,
            KEY_REMOTE_SPEECH_MODEL,
            &settings.remote_speech_model,
        )?;
        self.write_value(&conn, KEY_MICROPHONE_DEVICE, &settings.microphone_device)?;
        self.write_value(&conn, KEY_LANGUAGE, &settings.language)?;
        self.write_value(&conn, KEY_APP_LOCALE, &stored_app_locale)?;
        self.write_value(&conn, KEY_THEME_MODE, &settings.theme_mode)?;

        self.write_value(&conn, KEY_LLM_ENABLED, &settings.llm_enabled)?;
        self.write_value(&conn, KEY_CLEANUP_ENABLED, &settings.cleanup_enabled)?;
        self.write_value(&conn, KEY_LLM_PROVIDER, &settings.llm_provider)?;
        self.write_value(&conn, KEY_LLM_ENDPOINT, &settings.llm_endpoint)?;
        self.write_value(&conn, KEY_LLM_API_KEY, &stored_key)?;

        self.write_value(&conn, KEY_LLM_MODEL, &settings.llm_model)?;
        self.write_value(
            &conn,
            KEY_PERSONALITIES_NOTES_SEEDED,
            &settings.personalities_notes_seeded,
        )?;
        self.write_value(&conn, KEY_DICTIONARY, &settings.dictionary)?;
        self.write_value(
            &conn,
            KEY_AUTO_DICTIONARY_ENABLED,
            &settings.auto_dictionary_enabled,
        )?;
        self.write_value(
            &conn,
            KEY_AUTO_DICTIONARY_IGNORED,
            &settings.auto_dictionary_ignored,
        )?;
        self.write_value(&conn, KEY_REPLACEMENTS, &settings.replacements)?;
        self.write_value(&conn, KEY_PERSONALITIES, &settings.personalities)?;
        self.write_value(&conn, KEY_EDIT_MODE_ENABLED, &settings.edit_mode_enabled)?;
        self.write_value(&conn, KEY_MEDIA_ACTION, &settings.media_action)?;
        self.write_value(
            &conn,
            KEY_AUTO_UPDATE_ENABLED,
            &settings.auto_update_enabled,
        )?;
        self.write_value(
            &conn,
            KEY_AUTO_LAUNCH_ENABLED,
            &settings.auto_launch_enabled,
        )?;
        self.write_value(
            &conn,
            KEY_START_IN_BACKGROUND,
            &settings.start_in_background,
        )?;
        self.write_value(&conn, KEY_AUTO_DELETE_TARGET, &settings.auto_delete_target)?;
        self.write_value(
            &conn,
            KEY_AUTO_DELETE_DURATION,
            &settings.auto_delete_duration,
        )?;
        self.write_value(&conn, KEY_ANALYTICS_ENABLED, &settings.analytics_enabled)?;
        self.write_value(
            &conn,
            KEY_ANALYTICS_INSTALL_ID,
            &settings.analytics_install_id,
        )?;
        self.write_value(&conn, KEY_LOCAL_API_KEY, &stored_local_api_key)?;
        self.write_value(&conn, KEY_LOCAL_API_PORT, &settings.local_api_port)?;
        self.write_value(&conn, KEY_LOCAL_API_MODEL, &settings.local_api_model)?;
        self.write_value(&conn, KEY_LOCAL_API_HOST, &settings.local_api_host)?;
        self.write_value(
            &conn,
            KEY_LOCAL_API_START_ON_LAUNCH,
            &settings.local_api_start_on_launch,
        )?;
        self.write_value(&conn, KEY_LOCAL_API_CORS, &settings.local_api_cors)?;
        conn.commit()
            .context("Failed to commit settings transaction")?;
        Ok(())
    }

    fn read_value<T>(&self, conn: &Connection, key: &str, default: T) -> Result<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        if let Some(raw) = self.read_optional_raw_value_from_conn(conn, key)? {
            serde_json::from_str(&raw).context("Malformed setting JSON in DB")
        } else {
            Ok(default)
        }
    }

    pub(crate) fn read_app_value<T: DeserializeOwned>(&self, key: &str, default: T) -> Result<T> {
        let conn = self.conn.lock();
        self.read_value(&conn, key, default)
    }

    pub(crate) fn write_app_value<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        let conn = self.conn.lock();
        self.write_value(&conn, key, value)
    }

    fn read_optional_value<T>(&self, conn: &Connection, key: &str) -> Result<Option<T>>
    where
        T: for<'de> Deserialize<'de>,
    {
        self.read_optional_raw_value_from_conn(conn, key)?
            .map(|raw| serde_json::from_str(&raw).context("Malformed setting JSON in DB"))
            .transpose()
    }

    fn read_optional_raw_value_from_conn(
        &self,
        conn: &Connection,
        key: &str,
    ) -> Result<Option<String>> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .context("Failed to read setting from DB")
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
    let dir = resolver
        .app_config_dir()
        .or_else(|_| resolver.app_data_dir())
        .context("Unable to resolve config directory")?;

    Ok(settings_db_path(dir))
}

fn cli_app_config_dir(app_identifier: &str) -> Result<PathBuf> {
    Ok(platform_config_dir()?.join(app_identifier))
}

/// Resolve the app data directory for headless CLI use (no Tauri app handle).
/// Mirrors the directory Tauri's `app_data_dir()` resolves to at runtime.
pub(crate) fn cli_data_dir(app_identifier: &str) -> Result<PathBuf> {
    cli_app_config_dir(app_identifier)
}

#[cfg(target_os = "macos")]
fn platform_config_dir() -> Result<PathBuf> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .context("Unable to resolve home directory")?;
    Ok(home.join("Library").join("Application Support"))
}

#[cfg(target_os = "windows")]
fn platform_config_dir() -> Result<PathBuf> {
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .context("Unable to resolve roaming app data directory")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_config_dir() -> Result<PathBuf> {
    if let Some(config_home) = env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(config_home));
    }
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .context("Unable to resolve home directory")?;
    Ok(home.join(".config"))
}

fn settings_db_path(mut dir: PathBuf) -> PathBuf {
    dir.push("Glimpse");
    dir.push(SETTINGS_DB_FILE_NAME);
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> SettingsStore {
        let store = SettingsStore {
            conn: Mutex::new(Connection::open_in_memory().expect("open in-memory sqlite DB")),
            llm_api_key_ciphertext: Mutex::new(None),
            remote_speech_api_key_ciphertext: Mutex::new(None),
            local_api_key_ciphertext: Mutex::new(None),
        };
        store.init_schema().expect("init settings schema");
        store
    }

    fn write_setting<T: Serialize>(store: &SettingsStore, key: &str, value: &T) {
        let conn = store.conn.lock();
        store
            .write_value(&conn, key, value)
            .expect("write test setting");
    }

    #[test]
    fn unreadable_encrypted_api_key_is_preserved_without_exposing_plaintext() {
        let store = test_store();
        let ciphertext = crate::crypto::encrypt("api-key-value", "different-hardware-id")
            .expect("encrypt fixture key");

        write_setting(&store, KEY_LLM_API_KEY, &ciphertext);
        write_setting(&store, KEY_TRANSCRIPTION_MODE, &TranscriptionMode::Cloud);
        write_setting(&store, KEY_PERSONALITIES_NOTES_SEEDED, &true);

        let loaded = store.load().expect("load settings");
        let conn = store.conn.lock();
        let stored_ciphertext = store
            .read_value(&conn, KEY_LLM_API_KEY, String::new())
            .expect("read stored ciphertext");

        assert!(loaded.llm_api_key.is_empty());
        assert_eq!(stored_ciphertext, ciphertext);
        assert_eq!(
            store.llm_api_key_ciphertext.lock().clone(),
            Some(ciphertext)
        );
    }

    #[test]
    fn decryptable_api_key_replaces_cached_ciphertext_after_reload() {
        let Some(hardware_uuid) = crate::crypto::get_hardware_uuid() else {
            return;
        };

        let store = test_store();
        let unreadable_ciphertext =
            crate::crypto::encrypt("api-key-value", "different-hardware-id")
                .expect("encrypt unreadable fixture");
        write_setting(&store, KEY_LLM_API_KEY, &unreadable_ciphertext);
        write_setting(&store, KEY_PERSONALITIES_NOTES_SEEDED, &true);

        let first = store.load().expect("first load");
        assert!(first.llm_api_key.is_empty());

        let readable_ciphertext = crate::crypto::encrypt("api-key-value", &hardware_uuid)
            .expect("encrypt readable fixture");
        write_setting(&store, KEY_LLM_API_KEY, &readable_ciphertext);
        write_setting(&store, KEY_PERSONALITIES_NOTES_SEEDED, &true);

        let second = store.load().expect("second load");

        assert_eq!(second.llm_api_key, "api-key-value");
        assert_eq!(store.llm_api_key_ciphertext.lock().clone(), None);
    }
}
