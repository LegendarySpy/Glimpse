use parking_lot::Mutex;
use reqwest::Url;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use tracing::{debug, error, info, warn};

use crate::pill::PillStatus;
use crate::{AppRuntime, AppState, toast};

const CHECK_INTERVAL_HOURS: u64 = 6;
const INITIAL_DELAY_SECS: u64 = 30;
const AUTO_UPDATE_IDLE_MINS: u64 = 10;
const AUTO_UPDATE_POLL_SECS: u64 = 30;
const AUTO_UPDATE_IDLE_POLL_SECS: u64 = 5 * 60;
const AUTO_UPDATE_MARKER_FILE: &str = ".auto_updated";
const STABLE_UPDATE_ENDPOINT: &str =
    "https://github.com/glimpse-hq/Glimpse/releases/latest/download/latest.json";
const EVENT_UPDATE_DOWNLOAD_PROGRESS: &str = "update:download-progress";

#[derive(Default)]
pub struct UpdateState {
    available_version: Option<String>,
    toast_shown_this_session: bool,
}

impl UpdateState {
    pub fn set_available(&mut self, version: String) {
        self.available_version = Some(version);
    }

    pub fn is_available(&self) -> bool {
        self.available_version.is_some()
    }

    pub fn available_version(&self) -> Option<&String> {
        self.available_version.as_ref()
    }

    pub fn mark_toast_shown(&mut self) {
        self.toast_shown_this_session = true;
    }

    pub fn should_show_toast(&self) -> bool {
        self.is_available() && !self.toast_shown_this_session
    }

    pub fn clear(&mut self) {
        self.available_version = None;
        self.toast_shown_this_session = false;
    }
}

pub type SharedUpdateState = Arc<Mutex<UpdateState>>;

pub fn create_state() -> SharedUpdateState {
    Arc::new(Mutex::new(UpdateState::default()))
}

fn clear_update_state_and_emit(app: &AppHandle<AppRuntime>) {
    app.state::<AppState>().update_state().lock().clear();
    let _ = app.emit("update:cleared", ());
}

fn marker_path(app: &AppHandle<AppRuntime>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join(AUTO_UPDATE_MARKER_FILE))
}

fn write_marker(app: &AppHandle<AppRuntime>) -> bool {
    let Some(path) = marker_path(app) else {
        warn!("auto-update: failed to resolve restart marker path");
        return false;
    };

    if let Some(parent) = path.parent()
        && let Err(err) = std::fs::create_dir_all(parent)
    {
        warn!(
            path = %parent.display(),
            error = %err,
            "auto-update: failed to create marker directory"
        );
    }

    if let Err(err) = std::fs::write(&path, "auto_update_completed\n") {
        error!(
            path = %path.display(),
            error = %err,
            "auto-update: failed to write restart marker"
        );
        return false;
    }

    true
}

/// Called on startup: if a marker file exists, the app was just auto-updated.
/// Sets a flag on AppState so a toast can be shown when the user opens the settings window.
pub fn check_post_auto_update(app: &AppHandle<AppRuntime>) {
    if let Some(path) = marker_path(app)
        && path.is_file()
    {
        match std::fs::remove_file(&path) {
            Ok(()) => {
                app.state::<AppState>().set_auto_update_completed();
                info!(
                    "auto-update: detected post-restart marker, will show toast on next settings open"
                );
            }
            Err(err) => {
                warn!(
                    path = %path.display(),
                    error = %err,
                    "auto-update: failed to clear post-restart marker"
                );
            }
        }
    }
}

pub fn start_background_checker(app: AppHandle<AppRuntime>, state: SharedUpdateState) {
    let auto_update_app = app.clone();
    let auto_update_state = state.clone();

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(INITIAL_DELAY_SECS)).await;

        loop {
            if let Err(err) = check_for_update(&app, &state).await {
                warn!(error = ?err, "background update check failed");
            }
            tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_HOURS * 60 * 60)).await;
        }
    });

    tauri::async_runtime::spawn(async move {
        // Stagger after the background checker's initial delay so it has time to
        // populate `state` with any available update before the auto-update loop starts.
        tokio::time::sleep(Duration::from_secs(INITIAL_DELAY_SECS + 10)).await;
        run_auto_update_loop(auto_update_app, auto_update_state).await;
    });
}

/// Runs the auto-update loop. When enabled, the settings window is hidden, and
/// the app has been idle for 10 minutes, downloads and installs the update then
/// restarts the app silently. A marker file is written before restart so a toast
/// can be shown when the user next opens the settings window.
async fn run_auto_update_loop(app: AppHandle<AppRuntime>, state: SharedUpdateState) {
    let idle_duration = Duration::from_secs(AUTO_UPDATE_IDLE_MINS * 60);

    loop {
        if !app.state::<AppState>().is_auto_update_enabled() {
            tokio::time::sleep(Duration::from_secs(AUTO_UPDATE_IDLE_POLL_SECS)).await;
            continue;
        }

        if !state.lock().is_available() {
            tokio::time::sleep(Duration::from_secs(AUTO_UPDATE_IDLE_POLL_SECS)).await;
            continue;
        }

        tokio::time::sleep(Duration::from_secs(AUTO_UPDATE_POLL_SECS)).await;

        if is_settings_window_visible(&app) {
            continue;
        }

        if !wait_for_idle(&app, idle_duration).await {
            continue;
        }

        if !should_restart_for_auto_update(&app, &state) {
            continue;
        }

        info!("auto-update: app is idle and window hidden, downloading update");

        match resolve_available_update(&app).await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        // Marker-write failures repeat every poll; report once per install.
                        let mut restart_marker_failure_reported = false;
                        if should_restart_for_auto_update(&app, &state) {
                            if write_marker(&app) {
                                state.lock().clear();
                                info!("auto-update: installed, restarting");
                                app.request_restart();
                                return;
                            }
                            warn!("auto-update: installed, but marker write failed");
                            crate::analytics::track_update_failed(
                                &app,
                                "automatic",
                                "restart_marker",
                                Some(&version),
                                "storage",
                            );
                            restart_marker_failure_reported = true;
                        } else {
                            info!("auto-update: installed, waiting for restart conditions");
                        }

                        // Update is already installed - wait for restart conditions
                        // without re-downloading.
                        loop {
                            tokio::time::sleep(Duration::from_secs(AUTO_UPDATE_POLL_SECS)).await;
                            if !app.state::<AppState>().is_auto_update_enabled() {
                                break;
                            }
                            if should_restart_for_auto_update(&app, &state) {
                                if write_marker(&app) {
                                    state.lock().clear();
                                    info!("auto-update: restarting (deferred)");
                                    app.request_restart();
                                    return;
                                }
                                warn!("auto-update: installed, but deferred marker write failed");
                                if !restart_marker_failure_reported {
                                    crate::analytics::track_update_failed(
                                        &app,
                                        "automatic",
                                        "restart_marker",
                                        Some(&version),
                                        "storage",
                                    );
                                    restart_marker_failure_reported = true;
                                }
                            }
                        }
                        continue;
                    }
                    Err(err) => {
                        warn!(error = %err, "auto-update: download/install failed");
                        crate::analytics::track_update_failed(
                            &app,
                            "automatic",
                            "download_install",
                            Some(&version),
                            crate::analytics::classify_failure_reason(&err.to_string()),
                        );
                    }
                }
            }
            Ok(None) => {}
            Err(err) => {
                warn!(error = %err, "auto-update: failed to resolve update");
                crate::analytics::track_update_failed(
                    &app,
                    "automatic",
                    "resolve",
                    None,
                    crate::analytics::classify_failure_reason(&err),
                );
            }
        }
        tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_HOURS * 60 * 60)).await;
    }
}

/// Returns true only if the pill stays idle for the entire `required` duration
/// while auto-update remains enabled, the backend stays idle, and the settings
/// window stays hidden throughout the wait.
async fn wait_for_idle(app: &AppHandle<AppRuntime>, required: Duration) -> bool {
    let poll = Duration::from_secs(10);
    let mut elapsed = Duration::ZERO;

    while elapsed < required {
        tokio::time::sleep(poll).await;

        let state = app.state::<AppState>();

        if state.pill().status() != PillStatus::Idle {
            return false;
        }

        if !state.is_auto_update_enabled() {
            return false;
        }

        if !state.is_backend_idle() {
            return false;
        }

        if is_settings_window_visible(app) {
            return false;
        }

        elapsed += poll;
    }

    true
}

fn should_restart_for_auto_update(app: &AppHandle<AppRuntime>, state: &SharedUpdateState) -> bool {
    let app_state = app.state::<AppState>();
    app_state.is_auto_update_enabled()
        && app_state.pill().status() == PillStatus::Idle
        && state.lock().is_available()
        && !is_settings_window_visible(app)
        && app_state.is_backend_idle()
}

fn is_settings_window_visible(app: &AppHandle<AppRuntime>) -> bool {
    app.get_webview_window(crate::SETTINGS_WINDOW_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

async fn resolve_available_update(
    app: &AppHandle<AppRuntime>,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let endpoint = Url::parse(STABLE_UPDATE_ENDPOINT).map_err(|err| err.to_string())?;
    let updater_builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|err| err.to_string())?;
    let updater = updater_builder.build().map_err(|err| err.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => Ok(Some(update)),
        Ok(None) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

async fn check_for_update(
    app: &AppHandle<AppRuntime>,
    state: &SharedUpdateState,
) -> anyhow::Result<()> {
    debug!("checking for updates");

    match resolve_available_update(app)
        .await
        .map_err(|err| anyhow::anyhow!(err))?
    {
        Some(update) => {
            let version = update.version.clone();
            info!(version = %version, "update available");

            {
                let mut guard = state.lock();
                if guard.available_version.as_ref() != Some(&version) {
                    guard.set_available(version.clone());
                    guard.toast_shown_this_session = false;
                }
            }

            let _ = app.emit("update:available", version);
        }
        None => {
            debug!("no updates available");
            clear_update_state_and_emit(app);
        }
    }

    Ok(())
}

// Auto-update installs silently when the app is idle, so the toast is
// only useful to users who opted out of it.
pub fn maybe_show_update_toast(app: &AppHandle<AppRuntime>, state: &SharedUpdateState) -> bool {
    if app.state::<AppState>().is_auto_update_enabled() {
        return false;
    }

    let (should_show, new_version) = {
        let guard = state.lock();
        (
            guard.should_show_toast(),
            guard.available_version().cloned(),
        )
    };

    if !should_show {
        return false;
    }

    state.lock().mark_toast_shown();

    let current_version = env!("CARGO_PKG_VERSION");
    let message = match new_version {
        Some(ref v) => format!("v{current_version} → v{v}"),
        None => "Update available.".to_string(),
    };

    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "update".to_string(),
            title: None,
            message,
            auto_dismiss: Some(false),
            duration: None,
            retry_id: None,
            mode: None,
            action: Some("open_about_page".to_string()),
            action_label: Some("Update".to_string()),
            secondary_action: None,
            secondary_action_label: None,
        },
    );

    true
}

#[derive(Serialize)]
pub struct UpdateStatus {
    pub available: bool,
    pub version: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub progress: Option<u8>,
}

#[tauri::command]
pub fn get_update_status(app: AppHandle<AppRuntime>) -> UpdateStatus {
    let state = app.state::<AppState>();
    let guard = state.update_state().lock();
    UpdateStatus {
        available: guard.is_available(),
        version: guard.available_version().cloned(),
    }
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle<AppRuntime>) -> Result<UpdateStatus, String> {
    if crate::platform::is_store_build() {
        return Err("Updates are managed by the Microsoft Store.".to_string());
    }
    let update_state = app.state::<AppState>().update_state().clone();
    check_for_update(&app, &update_state)
        .await
        .map_err(|err| err.to_string())?;

    let guard = update_state.lock();
    Ok(UpdateStatus {
        available: guard.is_available(),
        version: guard.available_version().cloned(),
    })
}

#[tauri::command]
pub async fn download_and_install_update(app: AppHandle<AppRuntime>) -> Result<(), String> {
    if crate::platform::is_store_build() {
        return Err("Updates are managed by the Microsoft Store.".to_string());
    }
    let update = match resolve_available_update(&app).await {
        Ok(Some(update)) => update,
        Ok(None) => {
            crate::analytics::track_update_failed(&app, "manual", "resolve", None, "not_found");
            return Err("No update is currently available.".to_string());
        }
        Err(err) => {
            crate::analytics::track_update_failed(
                &app,
                "manual",
                "resolve",
                None,
                crate::analytics::classify_failure_reason(&err),
            );
            return Err(err);
        }
    };
    let version = update.version.clone();

    let mut downloaded = 0_u64;
    let mut total: Option<u64> = None;
    let progress_app = app.clone();

    if let Err(err) = update
        .download_and_install(
            |chunk_length, content_length| {
                if total.is_none() {
                    total = content_length;
                }

                downloaded = downloaded.saturating_add(chunk_length as u64);
                let progress = total.and_then(|value| {
                    downloaded
                        .saturating_mul(100)
                        .checked_div(value)
                        .map(|pct| pct.min(100) as u8)
                });

                let _ = progress_app.emit(
                    EVENT_UPDATE_DOWNLOAD_PROGRESS,
                    UpdateDownloadProgress {
                        downloaded,
                        total,
                        progress,
                    },
                );
            },
            || {},
        )
        .await
    {
        crate::analytics::track_update_failed(
            &app,
            "manual",
            "download_install",
            Some(&version),
            crate::analytics::classify_failure_reason(&err.to_string()),
        );
        return Err(err.to_string());
    }

    let _ = app.emit(
        EVENT_UPDATE_DOWNLOAD_PROGRESS,
        UpdateDownloadProgress {
            downloaded,
            total,
            progress: Some(100),
        },
    );

    clear_update_state_and_emit(&app);

    info!("update downloaded and installed");
    Ok(())
}
