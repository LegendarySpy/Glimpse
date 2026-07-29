use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::{AppRuntime, AppState, license, notifications, settings::SettingsStore};

const SURVEY_URL: &str = "https://tryglimpse.cc/feedback";

const KEY_SURVEY_STATE: &str = "survey_state";
const EVENT_SURVEY_ELIGIBLE: &str = "survey:eligible";
const PROMPT_VERSION: u32 = 1;

const MIN_DICTATIONS: u64 = 25;
const MIN_DAYS_INSTALLED: i64 = 7;
const NOTICE_QUIET_DAYS: i64 = 3;

const OUTCOME_ANSWERED: &str = "answered";
const OUTCOME_DISMISSED: &str = "dismissed";
const OUTCOME_UNREADABLE: &str = "unreadable";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SurveyState {
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

impl Default for SurveyState {
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

impl SurveyState {
    fn load(store: &SettingsStore) -> Self {
        match store.read_app_value::<SurveyState>(KEY_SURVEY_STATE, SurveyState::default()) {
            Ok(state) if state.prompt_version < PROMPT_VERSION => state.migrated(),
            Ok(state) => state,
            Err(err) => {
                tracing::warn!("Unreadable survey state, treating as answered: {err}");
                SurveyState {
                    outcome: Some(OUTCOME_UNREADABLE.to_string()),
                    ..SurveyState::default()
                }
            }
        }
    }

    fn migrated(mut self) -> Self {
        if let Some(outcome) = self.outcome.take() {
            self.history.insert(self.prompt_version, outcome);
        }
        SurveyState {
            prompt_version: PROMPT_VERSION,
            history: self.history,
            ..SurveyState::default()
        }
    }

    fn save(&self, store: &SettingsStore) -> Result<(), String> {
        store
            .write_app_value(KEY_SURVEY_STATE, self)
            .map_err(|err| {
                tracing::error!("Failed to persist survey state: {err}");
                format!("Failed to save your choice: {err}")
            })
    }

    fn resolved(&self) -> bool {
        self.outcome.is_some()
    }
}

#[derive(Debug, Serialize)]
pub struct SurveyPrompt {
    pub show: bool,
}

pub fn evaluate_after_use(app: &AppHandle<AppRuntime>) {
    let store = app.state::<AppState>().settings_store.clone();
    let mut state = SurveyState::load(&store);

    if state.resolved() || state.eligible_at.is_some() {
        return;
    }

    let now = Utc::now();
    if !thresholds_met(app, &store, now) {
        return;
    }

    state.eligible_at = Some(now.to_rfc3339());
    if state.save(&store).is_err() {
        return;
    }
    crate::emit_event(app, EVENT_SURVEY_ELIGIBLE, ());
}

fn thresholds_met(app: &AppHandle<AppRuntime>, store: &SettingsStore, now: DateTime<Utc>) -> bool {
    let dictations = match app.state::<AppState>().storage().lifetime_stats() {
        Ok(stats) => stats.dictations,
        Err(err) => {
            tracing::warn!("Skipping survey check, lifetime stats unavailable: {err}");
            return false;
        }
    };
    if dictations < MIN_DICTATIONS {
        return false;
    }

    let Some(installed_at) = installed_at(store) else {
        return false;
    };
    if now < installed_at + Duration::days(MIN_DAYS_INSTALLED) {
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
        .map_err(|err| tracing::warn!("Skipping survey check, license state unavailable: {err}"))
        .ok()?;
    DateTime::parse_from_rfc3339(&license_state.trial_started_at)
        .ok()
        .map(|ts| ts.with_timezone(&Utc))
}

#[tauri::command]
pub fn get_survey_prompt(app: AppHandle<AppRuntime>) -> SurveyPrompt {
    let store = app.state::<AppState>().settings_store.clone();
    let state = SurveyState::load(&store);
    SurveyPrompt {
        show: state.eligible_at.is_some() && !state.resolved(),
    }
}

#[tauri::command]
pub fn mark_survey_prompt_seen(app: AppHandle<AppRuntime>) {
    let store = app.state::<AppState>().settings_store.clone();
    let mut state = SurveyState::load(&store);
    if state.eligible_at.is_none() || state.resolved() || state.shown_at.is_some() {
        return;
    }

    let now = Utc::now();
    state.shown_at = Some(now.to_rfc3339());
    if state.save(&store).is_err() {
        return;
    }
    crate::analytics::track_survey_prompt_shown(
        &app,
        dictation_bucket(&app),
        install_age_bucket(&store, now),
    );
}

#[tauri::command]
pub fn resolve_survey_prompt(app: AppHandle<AppRuntime>, action: String) -> Result<(), String> {
    let outcome = match action.as_str() {
        "answer" => OUTCOME_ANSWERED,
        "dismiss" => OUTCOME_DISMISSED,
        other => return Err(format!("Unknown survey action: {other}")),
    };

    let store = app.state::<AppState>().settings_store.clone();
    let mut state = SurveyState::load(&store);
    if state.resolved() {
        return Ok(());
    }

    if outcome == OUTCOME_ANSWERED {
        app.opener()
            .open_url(SURVEY_URL, None::<&str>)
            .map_err(|err| format!("Failed to open the form: {err}"))?;
    }

    state.outcome = Some(outcome.to_string());
    state.resolved_at = Some(Utc::now().to_rfc3339());
    state.save(&store)?;

    if outcome == OUTCOME_ANSWERED {
        crate::analytics::track_survey_prompt_opened(&app);
    } else {
        crate::analytics::track_survey_prompt_dismissed(&app);
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
