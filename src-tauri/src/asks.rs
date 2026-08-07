use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::{AppRuntime, AppState, license, notifications, platform, settings::SettingsStore};

const SURVEY_URL: &str = "https://tryglimpse.cc/feedback";
const REPO_URL: &str = "https://github.com/glimpse-hq/Glimpse";
const STORE_PRODUCT_ID: &str = "9PJWF4W8V4WG";

const EVENT_ASK_ELIGIBLE: &str = "ask:eligible";
const PROMPT_VERSION: u32 = 1;

const NOTICE_QUIET_DAYS: i64 = 3;
const BETWEEN_ASKS_DAYS: i64 = 30;

const OUTCOME_ANSWERED: &str = "answered";
const OUTCOME_DISMISSED: &str = "dismissed";
const OUTCOME_UNREADABLE: &str = "unreadable";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ask {
    Survey,
    Review,
    Star,
}

const ASKS: [Ask; 3] = [Ask::Survey, Ask::Review, Ask::Star];

impl Ask {
    fn storage_key(self) -> &'static str {
        match self {
            Ask::Survey => "survey_state",
            Ask::Review => "review_state",
            Ask::Star => "star_state",
        }
    }

    fn min_dictations(self) -> u64 {
        match self {
            Ask::Survey => 25,
            Ask::Review => 100,
            Ask::Star => 50,
        }
    }

    fn min_days_installed(self) -> i64 {
        match self {
            Ask::Survey => 7,
            Ask::Review => 21,
            Ask::Star => 14,
        }
    }

    fn available(self, store: &SettingsStore) -> bool {
        match self {
            Ask::Survey => true,
            Ask::Review => platform::is_store_build(),
            Ask::Star => !platform::is_store_build() && developer_signal(store),
        }
    }

    fn url(self) -> String {
        match self {
            Ask::Survey => SURVEY_URL.to_string(),
            Ask::Review => format!("ms-windows-store://review/?ProductId={STORE_PRODUCT_ID}"),
            Ask::Star => REPO_URL.to_string(),
        }
    }

    fn analytics_kind(self) -> &'static str {
        match self {
            Ask::Survey => "survey",
            Ask::Review => "review",
            Ask::Star => "star",
        }
    }
}

fn developer_signal(store: &SettingsStore) -> bool {
    if crate::cli_install::cli_install_status().installed {
        return true;
    }
    store
        .load()
        .map(|settings| settings.local_api_start_on_launch)
        .unwrap_or(false)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AskState {
    #[serde(default)]
    prompt_version: u32,
    #[serde(default)]
    eligible_at: Option<String>,
    #[serde(default)]
    shown_at: Option<String>,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    resolved_at: Option<String>,
    #[serde(default)]
    history: BTreeMap<u32, String>,
}

impl Default for AskState {
    fn default() -> Self {
        Self {
            prompt_version: PROMPT_VERSION,
            eligible_at: None,
            shown_at: None,
            outcome: None,
            resolved_at: None,
            history: BTreeMap::new(),
        }
    }
}

impl AskState {
    fn load(store: &SettingsStore, ask: Ask) -> Self {
        match store.read_app_value::<AskState>(ask.storage_key(), AskState::default()) {
            Ok(state) if state.prompt_version < PROMPT_VERSION => state.migrated(),
            Ok(state) => state,
            Err(err) => {
                tracing::warn!("Unreadable ask state, treating as answered: {err}");
                AskState {
                    outcome: Some(OUTCOME_UNREADABLE.to_string()),
                    ..AskState::default()
                }
            }
        }
    }

    fn migrated(mut self) -> Self {
        if let Some(outcome) = self.outcome.take() {
            self.history.insert(self.prompt_version, outcome);
        }
        AskState {
            prompt_version: PROMPT_VERSION,
            history: self.history,
            ..AskState::default()
        }
    }

    fn save(&self, store: &SettingsStore, ask: Ask) -> Result<(), String> {
        store
            .write_app_value(ask.storage_key(), self)
            .map_err(|err| {
                tracing::error!("Failed to persist ask state: {err}");
                format!("Failed to save your choice: {err}")
            })
    }

    fn resolved(&self) -> bool {
        self.outcome.is_some()
    }

    fn pending(&self) -> bool {
        self.eligible_at.is_some() && !self.resolved()
    }

    fn resolved_at(&self) -> Option<DateTime<Utc>> {
        self.resolved_at.as_deref().and_then(parse_timestamp)
    }
}

fn parse_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|ts| ts.with_timezone(&Utc))
}

#[derive(Debug, Serialize)]
pub struct AskPrompt {
    pub kind: Option<Ask>,
}

fn load_all(store: &SettingsStore) -> Vec<(Ask, AskState)> {
    ASKS.iter()
        .map(|&ask| (ask, AskState::load(store, ask)))
        .collect()
}

fn pending_ask(store: &SettingsStore) -> Option<(Ask, AskState)> {
    load_all(store).into_iter().find(|(_, s)| s.pending())
}

pub fn evaluate_after_use(app: &AppHandle<AppRuntime>) {
    let store = app.state::<AppState>().settings_store.clone();
    let states = load_all(&store);

    if states.iter().any(|(_, state)| state.pending()) {
        return;
    }

    let now = Utc::now();
    let last_resolved = states.iter().filter_map(|(_, s)| s.resolved_at()).max();
    if let Some(last) = last_resolved
        && now < last + Duration::days(BETWEEN_ASKS_DAYS)
    {
        return;
    }

    for (ask, mut state) in states {
        if state.resolved() || !ask.available(&store) || !thresholds_met(app, &store, ask, now) {
            continue;
        }

        state.eligible_at = Some(now.to_rfc3339());
        if state.save(&store, ask).is_err() {
            return;
        }
        crate::emit_event(app, EVENT_ASK_ELIGIBLE, ());
        return;
    }
}

fn thresholds_met(
    app: &AppHandle<AppRuntime>,
    store: &SettingsStore,
    ask: Ask,
    now: DateTime<Utc>,
) -> bool {
    let dictations = match app.state::<AppState>().storage().lifetime_stats() {
        Ok(stats) => stats.dictations,
        Err(err) => {
            tracing::warn!("Skipping ask check, lifetime stats unavailable: {err}");
            return false;
        }
    };
    if dictations < ask.min_dictations() {
        return false;
    }

    let Some(installed_at) = installed_at(store) else {
        return false;
    };
    if now < installed_at + Duration::days(ask.min_days_installed()) {
        return false;
    }

    if let Some(last_notice) = notifications::last_notice_shown_at(store)
        && now < last_notice + Duration::days(NOTICE_QUIET_DAYS)
    {
        return false;
    }

    true
}

fn installed_at(store: &SettingsStore) -> Option<DateTime<Utc>> {
    let license_state = license::get_license_state(store)
        .map_err(|err| tracing::warn!("Skipping ask check, license state unavailable: {err}"))
        .ok()?;
    DateTime::parse_from_rfc3339(&license_state.trial_started_at)
        .ok()
        .map(|ts| ts.with_timezone(&Utc))
}

#[tauri::command]
pub fn get_ask_prompt(app: AppHandle<AppRuntime>) -> AskPrompt {
    let store = app.state::<AppState>().settings_store.clone();
    AskPrompt {
        kind: pending_ask(&store).map(|(ask, _)| ask),
    }
}

#[tauri::command]
pub fn mark_ask_prompt_seen(app: AppHandle<AppRuntime>) {
    let store = app.state::<AppState>().settings_store.clone();
    let Some((ask, mut state)) = pending_ask(&store) else {
        return;
    };
    if state.shown_at.is_some() {
        return;
    }

    let now = Utc::now();
    state.shown_at = Some(now.to_rfc3339());
    if state.save(&store, ask).is_err() {
        return;
    }
    crate::analytics::track_ask_prompt_shown(
        &app,
        ask.analytics_kind(),
        dictation_bucket(&app),
        install_age_bucket(&store, now),
    );
}

#[tauri::command]
pub fn resolve_ask_prompt(app: AppHandle<AppRuntime>, action: String) -> Result<(), String> {
    let outcome = match action.as_str() {
        "answer" => OUTCOME_ANSWERED,
        "dismiss" => OUTCOME_DISMISSED,
        other => return Err(format!("Unknown ask action: {other}")),
    };

    let store = app.state::<AppState>().settings_store.clone();
    let Some((ask, mut state)) = pending_ask(&store) else {
        return Ok(());
    };

    let unresolved = state.clone();
    state.outcome = Some(outcome.to_string());
    state.resolved_at = Some(Utc::now().to_rfc3339());
    state.save(&store, ask)?;

    if outcome == OUTCOME_ANSWERED {
        if let Err(err) = app.opener().open_url(ask.url(), None::<&str>) {
            let _ = unresolved.save(&store, ask);
            return Err(format!("Failed to open the link: {err}"));
        }
        crate::analytics::track_ask_prompt_opened(&app, ask.analytics_kind());
    } else {
        crate::analytics::track_ask_prompt_dismissed(&app, ask.analytics_kind());
    }
    Ok(())
}

fn dictation_bucket(app: &AppHandle<AppRuntime>) -> &'static str {
    let Ok(stats) = app.state::<AppState>().storage().lifetime_stats() else {
        return "unknown";
    };

    match stats.dictations {
        ..=24 => "under_25",
        25..=49 => "25_49",
        50..=99 => "50_99",
        100..=499 => "100_499",
        _ => "500_plus",
    }
}

fn install_age_bucket(store: &SettingsStore, now: DateTime<Utc>) -> &'static str {
    let Some(installed_at) = installed_at(store) else {
        return "unknown";
    };

    match (now - installed_at).num_days() {
        ..=6 => "under_7",
        7..=13 => "7_13",
        14..=29 => "14_29",
        30..=89 => "30_89",
        _ => "90_plus",
    }
}
