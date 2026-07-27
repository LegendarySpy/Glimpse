use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager};

use crate::{AppRuntime, AppState, license, settings::SettingsStore, toast};

const KEY_NOTICE_STATE: &str = "notification_state";

const NOTICE_TRIAL_ENDING_SOON: &str = "trial_ending_soon";
const NOTICE_TRIAL_EXPIRED: &str = "trial_expired";
const NOTICE_LICENSE_INACTIVE: &str = "license_inactive";

const ENDING_SOON_DAYS: i64 = 2;
const QUIET_PERIOD_DAYS: i64 = 1;
const LIFETIME_TOAST_BUDGET: u32 = 3;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct NoticeRecord {
    #[serde(default)]
    shown_count: u32,
    #[serde(default)]
    last_shown_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct NoticeState {
    #[serde(default)]
    notices: BTreeMap<String, NoticeRecord>,
}

impl NoticeState {
    fn load(store: &SettingsStore) -> Self {
        store
            .read_app_value(KEY_NOTICE_STATE, NoticeState::default())
            .unwrap_or_else(|err| {
                tracing::warn!("Failed to read notice state, starting empty: {err}");
                NoticeState::default()
            })
    }

    fn save(&self, store: &SettingsStore) {
        if let Err(err) = store.write_app_value(KEY_NOTICE_STATE, self) {
            tracing::error!("Failed to persist notice state: {err}");
        }
    }

    fn has_shown(&self, id: &str) -> bool {
        self.notices.get(id).is_some_and(|r| r.shown_count > 0)
    }

    fn total_shown(&self) -> u32 {
        self.notices.values().map(|r| r.shown_count).sum()
    }

    fn last_shown_any(&self) -> Option<DateTime<Utc>> {
        self.notices
            .values()
            .filter_map(|r| r.last_shown_at.as_deref())
            .filter_map(parse_timestamp)
            .max()
    }

    fn mark_shown(&mut self, id: &str, now: DateTime<Utc>) {
        let record = self.notices.entry(id.to_string()).or_default();
        record.shown_count += 1;
        record.last_shown_at = Some(now.to_rfc3339());
    }

    fn clear(&mut self, id: &str) -> bool {
        self.notices.remove(id).is_some()
    }
}

fn parse_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|ts| ts.with_timezone(&Utc))
}

pub fn evaluate_after_use(app: &AppHandle<AppRuntime>) {
    if license::developer_license_bypass_active() {
        return;
    }

    let store = app.state::<AppState>().settings_store.clone();

    let license_state = match license::get_license_state(&store) {
        Ok(state) => state,
        Err(err) => {
            tracing::warn!("Skipping trial notices, license state unavailable: {err}");
            return;
        }
    };

    let now = Utc::now();
    let mut state = NoticeState::load(&store);

    if license_state.status == license::LicenseStatus::Active {
        if state.clear(NOTICE_LICENSE_INACTIVE) {
            state.save(&store);
        }
        return;
    }

    let Some(notice) = due_notice(&license_state, &state, now) else {
        return;
    };

    if !budget_allows(&state, &license_state, now) {
        return;
    }

    let (message, action_label) = notice_copy(notice, license_state.trial_days_remaining);
    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "info".to_string(),
            title: None,
            message,
            auto_dismiss: Some(true),
            duration: Some(9000),
            retry_id: None,
            mode: None,
            action: Some("open_account_page".to_string()),
            action_label: Some(action_label.to_string()),
            secondary_action: None,
            secondary_action_label: None,
        },
    );

    state.mark_shown(notice, now);
    state.save(&store);
}

fn due_notice(
    license_state: &license::LicenseState,
    state: &NoticeState,
    now: DateTime<Utc>,
) -> Option<&'static str> {
    if !license_state.trial_active {
        let notice = if license_state.display_key.is_some() {
            if !license_lapsed(license_state, now) {
                return None;
            }
            NOTICE_LICENSE_INACTIVE
        } else {
            NOTICE_TRIAL_EXPIRED
        };
        if !state.has_shown(notice) {
            return Some(notice);
        }
    }

    if license_state.trial_active
        && license_state.trial_days_remaining <= ENDING_SOON_DAYS
        && !state.has_shown(NOTICE_TRIAL_ENDING_SOON)
    {
        return Some(NOTICE_TRIAL_ENDING_SOON);
    }

    None
}

fn license_lapsed(license_state: &license::LicenseState, now: DateTime<Utc>) -> bool {
    if license_state.status == license::LicenseStatus::Invalid {
        return true;
    }

    license_state
        .expires_at
        .as_deref()
        .and_then(parse_timestamp)
        .is_some_and(|expires_at| expires_at <= now)
}

fn budget_allows(
    state: &NoticeState,
    license_state: &license::LicenseState,
    now: DateTime<Utc>,
) -> bool {
    if state.total_shown() >= LIFETIME_TOAST_BUDGET {
        return false;
    }

    if let Some(started_at) = parse_timestamp(&license_state.trial_started_at)
        && now < started_at + Duration::days(QUIET_PERIOD_DAYS)
    {
        return false;
    }

    if let Some(last) = state.last_shown_any()
        && now < last + Duration::days(1)
    {
        return false;
    }

    true
}

fn notice_copy(notice: &str, days_remaining: i64) -> (String, &'static str) {
    match notice {
        NOTICE_LICENSE_INACTIVE => (
            "Your license is inactive. Dictation stays free. Some features need \
             an active license."
                .to_string(),
            "Manage license",
        ),
        NOTICE_TRIAL_EXPIRED => (
            "Your trial ended. Dictation stays free. Some features need a license.".to_string(),
            "See options",
        ),
        _ => {
            let message = if days_remaining <= 1 {
                "Last day of your trial. Dictation stays free. Some features need \
                 a license."
                    .to_string()
            } else {
                format!(
                    "{days_remaining} days left in your trial. Dictation stays free. \
                     Some features need a license."
                )
            };
            (message, "See options")
        }
    }
}
