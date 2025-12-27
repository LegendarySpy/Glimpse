use crate::{settings::TranscriptionMode, toast, AppRuntime, AppState};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use parking_lot::Mutex;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

pub const EVENT_AUTH_ERROR: &str = "cloud:auth-error";

#[derive(Clone, Default)]
pub struct CloudCredentials {
    pub jwt: String,
    pub function_url: String,
    pub is_subscriber: bool,
}

#[derive(Debug, Clone)]
pub enum CloudError {
    NoCredentials,
    NotSubscriber,
    JwtExpired,
    JwtInvalid,
}

impl CloudError {
    pub fn user_message(&self) -> &'static str {
        match self {
            CloudError::NoCredentials => "Sign in to use cloud transcription",
            CloudError::NotSubscriber => "Upgrade to use cloud transcription",
            CloudError::JwtExpired => "Session expired. Please sign in again",
            CloudError::JwtInvalid => "Authentication error. Please sign in again",
        }
    }
}

pub struct CloudManager {
    credentials: Mutex<Option<CloudCredentials>>,
}

impl CloudManager {
    pub fn new() -> Self {
        Self {
            credentials: Mutex::new(None),
        }
    }

    pub fn set_credentials(&self, jwt: String, function_url: String, is_subscriber: bool) {
        *self.credentials.lock() = Some(CloudCredentials {
            jwt,
            function_url,
            is_subscriber,
        });
    }

    pub fn clear_credentials(&self) {
        *self.credentials.lock() = None;
    }

    pub fn get_credentials(&self) -> Option<CloudCredentials> {
        self.credentials.lock().clone()
    }

    pub fn has_credentials(&self) -> bool {
        self.credentials.lock().is_some()
    }
}

#[derive(Deserialize)]
struct JwtPayload {
    exp: Option<u64>,
}

fn decode_jwt_payload(jwt: &str) -> Option<JwtPayload> {
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() != 3 {
        return None;
    }

    let payload_b64 = parts[1];
    let decoded = STANDARD_NO_PAD.decode(payload_b64).ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn validate_jwt_expiry(jwt: &str) -> Result<(), CloudError> {
    let payload = decode_jwt_payload(jwt).ok_or(CloudError::JwtInvalid)?;

    if let Some(exp) = payload.exp {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if now + 30 >= exp {
            return Err(CloudError::JwtExpired);
        }
    }

    Ok(())
}

pub fn check_cloud_ready(app: &AppHandle<AppRuntime>) -> Result<(), CloudError> {
    let state = app.state::<AppState>();
    let settings = state.current_settings();

    if matches!(settings.transcription_mode, TranscriptionMode::Local) {
        return Ok(());
    }

    let creds = state.cloud_manager().get_credentials();
    match creds {
        None => Err(CloudError::NoCredentials),
        Some(c) => {
            validate_jwt_expiry(&c.jwt)?;
            if !c.is_subscriber {
                return Err(CloudError::NotSubscriber);
            }
            Ok(())
        }
    }
}

pub fn emit_auth_error(app: &AppHandle<AppRuntime>) {
    let _ = app.emit(EVENT_AUTH_ERROR, ());
}

pub fn show_sign_in_required(app: &AppHandle<AppRuntime>, error: &CloudError) {
    match error {
        CloudError::NotSubscriber => {
            show_upgrade_required(app, error);
        }
        _ => {
            toast::show_with_action(
                app,
                "error",
                Some("Sign In Required"),
                error.user_message(),
                "open_sign_in",
                "Sign In",
            );
            emit_auth_error(app);
        }
    }
}

pub fn show_upgrade_required(app: &AppHandle<AppRuntime>, error: &CloudError) {
    toast::show_with_action(
        app,
        "error",
        Some("Upgrade Required"),
        error.user_message(),
        "open_checkout",
        "Upgrade",
    );
}

// Tauri commands

#[tauri::command]
pub fn set_cloud_credentials(
    jwt: String,
    function_url: String,
    is_subscriber: bool,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    state
        .cloud_manager()
        .set_credentials(jwt, function_url, is_subscriber);
    Ok(())
}

#[tauri::command]
pub fn clear_cloud_credentials(state: tauri::State<AppState>) -> Result<(), String> {
    state.cloud_manager().clear_credentials();
    Ok(())
}

#[tauri::command]
pub fn open_sign_in(app: AppHandle<AppRuntime>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    }
    app.emit("navigate:sign-in", ())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_checkout(app: AppHandle<AppRuntime>) -> Result<(), String> {
    dotenvy::dotenv().ok();
    let checkout_url = std::env::var("VITE_CHECKOUT_URL").unwrap_or_else(|_| {
        "https://glimpse-app.lemonsqueezy.com/buy/16bdbd7d-2aa4-4c4e-a101-482386083ea7".to_string()
    });

    app.opener()
        .open_url(&checkout_url, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}
