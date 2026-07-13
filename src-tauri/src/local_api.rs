use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use glimpse_speech::api::{ApiConfig, ApiEvent, ApiEventSink};
use glimpse_speech::service::{SpeechConfig, SpeechService};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::AppRuntime;

const EVENT_LOCAL_API_LOG: &str = "local-api:log";
const EVENT_LOCAL_API_STATUS: &str = "local-api:status";
const LOCAL_API_READY_PREFIX: &str = "Local API listening on ";
const TRANSCRIBE_REQUEST_LOG: &str = "POST /v1/audio/transcriptions";
const MAX_LOGS: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct LocalApiLogEntry {
    pub id: u64,
    pub timestamp_ms: u128,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalApiStatus {
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub model: String,
    pub loaded_model: Option<String>,
    pub api_key_required: bool,
    pub config_id: Option<u64>,
    pub cors: bool,
    pub requests_total: u64,
    pub logs: Vec<LocalApiLogEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLocalApiArgs {
    pub host: String,
    pub port: u16,
    pub model: String,
    pub api_key: String,
    pub cors: bool,
}

#[derive(Default)]
pub struct LocalApiController {
    inner: parking_lot::Mutex<LocalApiState>,
    next_log_id: AtomicU64,
    next_config_id: AtomicU64,
}

#[derive(Default)]
struct LocalApiState {
    running: Option<RunningLocalApi>,
    starting: bool,
    logs: VecDeque<LocalApiLogEntry>,
}

struct StartingGuard<'a> {
    inner: &'a parking_lot::Mutex<LocalApiState>,
}

impl Drop for StartingGuard<'_> {
    fn drop(&mut self) {
        self.inner.lock().starting = false;
    }
}

struct RunningLocalApi {
    host: String,
    port: u16,
    model: String,
    loaded_model: Option<String>,
    api_key_required: bool,
    config_id: u64,
    cors: bool,
    requests_total: u64,
    shutdown: Option<oneshot::Sender<()>>,
    stopped: Option<oneshot::Receiver<()>>,
}

impl LocalApiController {
    pub fn status(&self) -> LocalApiStatus {
        let state = self.inner.lock();
        status_from_state(&state)
    }

    pub async fn start(
        self: &Arc<Self>,
        app: AppHandle<AppRuntime>,
        args: StartLocalApiArgs,
    ) -> Result<LocalApiStatus, String> {
        if args.port == 0 {
            return Err("Port must be between 1 and 65535".to_string());
        }
        let model = if args.model.trim().is_empty() {
            "auto".to_string()
        } else {
            args.model.trim().to_string()
        };
        let warm_model = (model != "auto").then_some(model.clone());
        let api_key = Some(args.api_key.trim().to_string()).filter(|value| !value.is_empty());
        let host = crate::settings::canonicalize_local_api_host(&args.host);
        if host == "0.0.0.0" && api_key.is_none() {
            return Err("An API key is required when listening on LAN".to_string());
        }
        {
            let mut state = self.inner.lock();
            if state.running.is_some() || state.starting {
                return Err("Local API is already running".to_string());
            }
            state.starting = true;
        }
        let _starting_guard = StartingGuard { inner: &self.inner };
        let model_cache_dir =
            crate::model_manager::model_cache_dir(&app).map_err(|err| err.to_string())?;
        let api_models_dir = model_cache_dir.clone();
        let service = Arc::new(SpeechService::new(SpeechConfig {
            model_cache_dir,
            resolver: crate::model_manager::local_resolver(),
        }));
        if let Some(warm_id) = warm_model.as_deref() {
            let warm = Arc::clone(&service);
            let warm_id = warm_id.to_string();
            tokio::task::spawn_blocking(move || warm.preload_and_warm(&warm_id))
                .await
                .map_err(|err| format!("warm model task failed: {err}"))?
                .map_err(|err| err.to_string())?;
        }
        let config_id = self.next_config_id.fetch_add(1, Ordering::Relaxed) + 1;

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let (stopped_tx, stopped_rx) = oneshot::channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let ready_signal = Arc::new(parking_lot::Mutex::new(Some(ready_tx)));
        {
            let mut state = self.inner.lock();
            if state.running.is_some() {
                return Err("Local API is already running".to_string());
            }
            state.running = Some(RunningLocalApi {
                host: host.clone(),
                port: args.port,
                model: model.clone(),
                loaded_model: None,
                api_key_required: api_key.is_some(),
                config_id,
                cors: args.cors,
                requests_total: 0,
                shutdown: Some(shutdown_tx),
                stopped: Some(stopped_rx),
            });
        }

        self.push_log(
            &app,
            "info",
            format!("Starting local API on http://{host}:{}", args.port),
        );

        let controller = Arc::clone(self);
        let sink_app = app.clone();
        let ready_from_event = Arc::clone(&ready_signal);
        let event_sink: ApiEventSink = Arc::new(move |event: ApiEvent| {
            if let Some(model_id) = event.model_id.as_deref() {
                controller.set_loaded_model(&sink_app, model_id);
            }
            if event.level == "info"
                && event.message.starts_with(LOCAL_API_READY_PREFIX)
                && let Some(sender) = ready_from_event.lock().take()
            {
                let _ = sender.send(Ok(()));
            }
            if event.message.starts_with(TRANSCRIBE_REQUEST_LOG) {
                controller.note_request(&sink_app);
            }
            controller.push_log(&sink_app, event.level, event.message);
        });

        let controller = Arc::clone(self);
        let task_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let app = task_app;
            let result = glimpse_speech::api::serve_with_shutdown(
                ApiConfig {
                    host,
                    port: args.port,
                    service,
                    api_key,
                    event_sink: Some(event_sink),
                    cors: args.cors,
                    transcription_provider: None,
                    local_models: crate::model_manager::api_model_infos(),
                    local_model_source: Some(Arc::new(move || {
                        crate::model_manager::installed_api_model_infos(&api_models_dir)
                    })),
                },
                async {
                    let _ = shutdown_rx.await;
                },
            )
            .await;

            match result {
                Ok(()) => controller.push_log(&app, "info", "Local API stopped".to_string()),
                Err(err) => {
                    let message = format!("Local API error: {err}");
                    controller.push_log(&app, "error", message.clone());
                    controller.mark_stopped(&app);
                    let _ = stopped_tx.send(());
                    if let Some(sender) = ready_signal.lock().take() {
                        let _ = sender.send(Err(message));
                    }
                    return;
                }
            }
            controller.mark_stopped(&app);
            let _ = stopped_tx.send(());
            if let Some(sender) = ready_signal.lock().take() {
                let _ = sender.send(Err("Local API stopped before it was ready".to_string()));
            }
        });

        match ready_rx.await {
            Ok(Ok(())) => {
                let status = self.status();
                self.emit_status(&app);
                Ok(status)
            }
            Ok(Err(err)) => Err(err),
            Err(_) => Err("Local API stopped before it was ready".to_string()),
        }
    }

    pub async fn stop(&self, app: &AppHandle<AppRuntime>) -> Result<LocalApiStatus, String> {
        let (shutdown, stopped) = {
            let mut state = self.inner.lock();
            match state.running.as_mut() {
                Some(running) => (running.shutdown.take(), running.stopped.take()),
                None => return Ok(status_from_state(&state)),
            }
        };

        let Some(shutdown) = shutdown else {
            return Ok(self.status());
        };

        self.push_log(app, "info", "Stopping local API".to_string());
        let _ = shutdown.send(());
        if let Some(stopped) = stopped {
            let _ = stopped.await;
        }
        Ok(self.status())
    }

    pub fn clear_logs(&self) -> LocalApiStatus {
        self.inner.lock().logs.clear();
        self.status()
    }

    fn mark_stopped(&self, app: &AppHandle<AppRuntime>) {
        let was_running = {
            let mut state = self.inner.lock();
            state.running.take().is_some()
        };
        if was_running {
            self.emit_status(app);
        }
    }

    fn note_request(&self, app: &AppHandle<AppRuntime>) {
        let counted = {
            let mut state = self.inner.lock();
            match state.running.as_mut() {
                Some(running) => {
                    running.requests_total += 1;
                    true
                }
                None => false,
            }
        };
        if counted {
            self.emit_status(app);
        }
    }

    fn set_loaded_model(&self, app: &AppHandle<AppRuntime>, model_id: &str) {
        if let Some(running) = self.inner.lock().running.as_mut() {
            running.loaded_model = Some(model_id.to_string());
        }
        self.emit_status(app);
    }

    fn push_log(&self, app: &AppHandle<AppRuntime>, level: &str, message: String) {
        let entry = LocalApiLogEntry {
            id: self.next_log_id.fetch_add(1, Ordering::Relaxed) + 1,
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default(),
            level: level.to_string(),
            message,
        };

        {
            let mut state = self.inner.lock();
            state.logs.push_back(entry.clone());
            while state.logs.len() > MAX_LOGS {
                state.logs.pop_front();
            }
        }

        let _ = app.emit(EVENT_LOCAL_API_LOG, entry);
    }

    fn emit_status(&self, app: &AppHandle<AppRuntime>) {
        let _ = app.emit(EVENT_LOCAL_API_STATUS, self.status());
    }
}

fn status_from_state(state: &LocalApiState) -> LocalApiStatus {
    let logs = state.logs.iter().cloned().collect();
    if let Some(running) = &state.running {
        LocalApiStatus {
            running: true,
            host: running.host.clone(),
            port: running.port,
            model: running.model.clone(),
            loaded_model: running.loaded_model.clone(),
            api_key_required: running.api_key_required,
            config_id: Some(running.config_id),
            cors: running.cors,
            requests_total: running.requests_total,
            logs,
        }
    } else {
        LocalApiStatus {
            running: false,
            host: "127.0.0.1".to_string(),
            port: 0,
            model: "auto".to_string(),
            loaded_model: None,
            api_key_required: false,
            config_id: None,
            cors: crate::settings::default_local_api_cors(),
            requests_total: 0,
            logs,
        }
    }
}

#[tauri::command]
pub fn get_local_api_status(
    state: tauri::State<crate::AppState>,
) -> Result<LocalApiStatus, String> {
    Ok(state.local_api.status())
}

#[tauri::command]
pub async fn start_local_api(
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, crate::AppState>,
    args: StartLocalApiArgs,
) -> Result<LocalApiStatus, String> {
    crate::license::require_active_license(&state.settings_store, "the API server")?;
    let controller: Arc<LocalApiController> = Arc::clone(&state.local_api);
    controller.start(app, args).await
}

#[tauri::command]
pub async fn stop_local_api(
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<LocalApiStatus, String> {
    state.local_api.stop(&app).await
}

#[tauri::command]
pub fn clear_local_api_logs(
    state: tauri::State<crate::AppState>,
) -> Result<LocalApiStatus, String> {
    Ok(state.local_api.clear_logs())
}

pub fn start_from_settings(app: &AppHandle<AppRuntime>, settings: &crate::settings::UserSettings) {
    if !settings.local_api_start_on_launch {
        return;
    }

    let state = app.state::<crate::AppState>();
    if !crate::license::active_license_gate(&state.settings_store) {
        state.local_api.push_log(
            app,
            "warn",
            "API server start-on-launch skipped; an active Glimpse license is required."
                .to_string(),
        );
        return;
    }

    let args = StartLocalApiArgs {
        host: settings.local_api_host.clone(),
        port: settings.local_api_port,
        model: settings.local_api_model.clone(),
        api_key: settings.local_api_key.clone(),
        cors: settings.local_api_cors,
    };
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let state = app.state::<crate::AppState>();
        if let Err(err) = state.local_api.start(app.clone(), args).await {
            state
                .local_api
                .push_log(&app, "error", format!("Failed to start local API: {err}"));
        }
    });
}
