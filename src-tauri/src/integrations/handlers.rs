//! In-app handlers for control-socket commands. Each handler reuses the app's
//! existing command logic so tray/menu/in-memory state stay consistent.

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use super::ipc::{Request, Response};
use crate::settings::Replacement;
use crate::tray::SettingsPage;
use crate::{AppRuntime, AppState};

pub(crate) fn dispatch(app: &AppHandle<AppRuntime>, request: &Request) -> Response {
    let result = match request.command.as_str() {
        "ping" => Ok(json!({ "pong": true })),
        "dictionary.add" => dictionary_add(app, &request.args),
        "dictionary.remove" => dictionary_remove(app, &request.args),
        "replacements.add" => replacements_add(app, &request.args),
        "replacements.remove" => replacements_remove(app, &request.args),
        "model.set" => model_set(app, &request.args),
        "open" => open(app, &request.args),
        "status" => status(app),
        "library.import" => library_import(app, &request.args),
        "api.start" => api_start(app, &request.args),
        "api.stop" => api_stop(app),
        "api.status" => api_status(app),
        "transcribe" => transcribe(app, &request.args),
        other => Err(format!("Unknown command: {other}")),
    };
    match result {
        Ok(data) => Response::ok(data),
        Err(message) => Response::error(message),
    }
}

/// Mutating CLI commands require an active license; reads stay free. Uses the
/// same `require_active_license` gate as the CLI installer and API server.
fn require_license(state: &AppState) -> Result<(), String> {
    crate::license::require_active_license(&state.settings_store, "the Glimpse CLI")
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing string argument `{key}`"))
}

fn arg_string_array(args: &Value, key: &str) -> Result<Vec<String>, String> {
    args.get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("missing array argument `{key}`"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("`{key}` must contain only strings"))
        })
        .collect()
}

fn dictionary_add(app: &AppHandle<AppRuntime>, args: &Value) -> Result<Value, String> {
    let additions = arg_string_array(args, "words")?;
    let state = app.state::<AppState>();
    require_license(&state)?;
    let mut words = state.current_settings_unmasked().dictionary;
    words.extend(additions);
    let saved = crate::dictionary::set_dictionary(words, state)?;
    Ok(json!({ "words": saved }))
}

fn dictionary_remove(app: &AppHandle<AppRuntime>, args: &Value) -> Result<Value, String> {
    let removals = arg_string_array(args, "words")?;
    let lowered: Vec<String> = removals.iter().map(|w| w.to_lowercase()).collect();
    let state = app.state::<AppState>();
    require_license(&state)?;
    let words: Vec<String> = state
        .current_settings_unmasked()
        .dictionary
        .into_iter()
        .filter(|word| !lowered.contains(&word.to_lowercase()))
        .collect();
    let saved = crate::dictionary::set_dictionary(words, state)?;
    Ok(json!({ "words": saved }))
}

fn replacements_add(app: &AppHandle<AppRuntime>, args: &Value) -> Result<Value, String> {
    let from = arg_str(args, "from")?;
    let to = arg_str(args, "to")?;
    let state = app.state::<AppState>();
    require_license(&state)?;
    let mut replacements = state.current_settings_unmasked().replacements;
    replacements.retain(|r| !r.from.eq_ignore_ascii_case(&from));
    replacements.push(Replacement { from, to });
    let saved = crate::dictionary::set_replacements(replacements, state)?;
    Ok(json!({ "replacements": saved }))
}

fn replacements_remove(app: &AppHandle<AppRuntime>, args: &Value) -> Result<Value, String> {
    let from = arg_str(args, "from")?;
    let state = app.state::<AppState>();
    require_license(&state)?;
    let replacements: Vec<Replacement> = state
        .current_settings_unmasked()
        .replacements
        .into_iter()
        .filter(|r| !r.from.eq_ignore_ascii_case(&from))
        .collect();
    let saved = crate::dictionary::set_replacements(replacements, state)?;
    Ok(json!({ "replacements": saved }))
}

fn model_set(app: &AppHandle<AppRuntime>, args: &Value) -> Result<Value, String> {
    require_license(&app.state::<AppState>())?;
    let target = arg_str(args, "target")?;
    match target.as_str() {
        "remote" => crate::speech::menu::cli_enable_remote(app)?,
        "local" => {
            let model = arg_str(args, "model")?;
            crate::speech::menu::cli_set_local_model(app, &model)?;
        }
        other => return Err(format!("Unknown model target: {other}")),
    }
    let settings = app.state::<AppState>().current_settings_unmasked();
    Ok(json!({
        "active": active_model(&settings),
        "remote_enabled": settings.remote_speech_enabled,
    }))
}

fn open(app: &AppHandle<AppRuntime>, args: &Value) -> Result<Value, String> {
    let target = args
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("settings");
    let tab = args.get("tab").and_then(Value::as_str);

    let page = match (target, tab) {
        ("home", _) | ("history", _) | ("settings", Some("history")) => Some(SettingsPage::History),
        ("dictionary", _) => Some(SettingsPage::Dictionary),
        ("personalization", _) => Some(SettingsPage::Personalization),
        ("library", _) => Some(SettingsPage::Library),
        ("models", _) | ("settings", Some("models")) => Some(SettingsPage::Models),
        ("settings", Some("about")) => Some(SettingsPage::About),
        ("settings", Some("account")) => Some(SettingsPage::Account),
        _ => None,
    };
    let result = match page {
        Some(page) => crate::tray::open_settings_page(app, page),
        None => crate::tray::toggle_settings_window(app),
    };
    result.map_err(|err| err.to_string())?;
    Ok(json!({ "opened": target }))
}

fn status(app: &AppHandle<AppRuntime>) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let settings = state.current_settings_unmasked();
    let pill = serde_json::to_value(state.pill().status()).unwrap_or(Value::Null);
    let api = state.local_api.status();
    Ok(json!({
        "app_running": true,
        "pill": pill,
        "local_api": {
            "running": api.running,
            "host": api.host,
            "port": api.port,
        },
        "active_model": active_model(&settings),
        "remote_enabled": settings.remote_speech_enabled,
    }))
}

fn library_import(app: &AppHandle<AppRuntime>, args: &Value) -> Result<Value, String> {
    let path = arg_str(args, "path")?;
    let state = app.state::<AppState>();
    require_license(&state)?;
    let settings = state.current_settings_unmasked();

    let options = crate::library::LibraryImportOptions {
        store_original: args
            .get("store_original")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        model_key: args
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| settings.local_model.clone()),
        llm_cleanup_enabled: args
            .get("llm_cleanup")
            .and_then(Value::as_bool)
            .unwrap_or(settings.cleanup_enabled),
        show_timestamps: args
            .get("show_timestamps")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        detect_speakers: args
            .get("detect_speakers")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };

    let item = crate::library::commands::create_library_item(path, options, app.clone(), state)?;
    Ok(json!({
        "id": item.id,
        "name": item.name,
        "source_path": item.source_path,
        "status": "pending",
    }))
}

fn api_start(app: &AppHandle<AppRuntime>, overrides: &Value) -> Result<Value, String> {
    let state = app.state::<AppState>();
    crate::license::require_active_license(&state.settings_store, "the API server")?;
    let settings = state.current_settings_unmasked();
    // Each field falls back to the saved setting when the caller omits it.
    let args = crate::local_api::StartLocalApiArgs {
        host: overrides
            .get("host")
            .and_then(Value::as_str)
            .map(crate::settings::canonicalize_local_api_host)
            .unwrap_or_else(|| settings.local_api_host.clone()),
        port: overrides
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .unwrap_or(settings.local_api_port),
        model: overrides
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| settings.local_api_model.clone()),
        api_key: overrides
            .get("api_key")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| settings.local_api_key.clone()),
        cors: overrides
            .get("cors")
            .and_then(Value::as_bool)
            .unwrap_or(settings.local_api_cors),
    };
    let controller = std::sync::Arc::clone(&state.local_api);
    let status = tauri::async_runtime::block_on(controller.start(app.clone(), args))?;
    Ok(api_status_json(&status))
}

fn api_stop(app: &AppHandle<AppRuntime>) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let status = tauri::async_runtime::block_on(state.local_api.stop(app))?;
    Ok(api_status_json(&status))
}

fn api_status(app: &AppHandle<AppRuntime>) -> Result<Value, String> {
    let status = app.state::<AppState>().local_api.status();
    Ok(api_status_json(&status))
}

fn api_status_json(status: &crate::local_api::LocalApiStatus) -> Value {
    json!({
        "running": status.running,
        "host": status.host,
        "port": status.port,
        "model": status.model,
        "loaded_model": status.loaded_model,
        "api_key_required": status.api_key_required,
    })
}

fn transcribe(app: &AppHandle<AppRuntime>, args: &Value) -> Result<Value, String> {
    let path = arg_str(args, "path")?;
    let state = app.state::<AppState>();
    require_license(&state)?;
    let settings = state.current_settings_unmasked();

    let model_id = args
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| settings.local_model.clone());
    let language = args
        .get("language")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| settings.language.clone());

    let ready = crate::speech::install::ensure_model_ready(app, &model_id)
        .map_err(|err| format!("Failed to load model {model_id}: {err}"))?;
    let (samples, sample_rate) = decode_audio(&path)?;
    let dictionary = crate::dictionary::dictionary_entries_for_model(&ready, &settings);

    let success = state
        .local_transcriber()
        .transcribe_with_segments(&ready, &samples, sample_rate, &dictionary, Some(&language))
        .map_err(|err| format!("Transcription failed: {err}"))?;

    let mut text =
        crate::dictionary::apply_replacements(&success.transcript, &settings.replacements);

    let want_cleanup = args
        .get("cleanup")
        .and_then(Value::as_bool)
        .unwrap_or(settings.cleanup_enabled);
    let mut llm_cleaned = false;
    if want_cleanup && crate::llm_cleanup::is_llm_available(&settings) {
        let http = state.http();
        match tauri::async_runtime::block_on(crate::llm_cleanup::cleanup_transcription(
            &http, &text, &settings, None,
        )) {
            Ok(cleaned) => {
                text = cleaned;
                llm_cleaned = true;
            }
            Err(err) => tracing::warn!("CLI transcribe cleanup skipped: {err}"),
        }
    }

    let duration_seconds = if sample_rate > 0 {
        samples.len() as f64 / sample_rate as f64
    } else {
        0.0
    };

    Ok(json!({
        "text": text,
        "speech_model": success.speech_model,
        "llm_cleaned": llm_cleaned,
        "word_count": text.split_whitespace().count(),
        "duration_seconds": duration_seconds,
    }))
}

static NEXT_DECODE_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn decode_audio(path: &str) -> Result<(Vec<i16>, u32), String> {
    let source = std::path::PathBuf::from(path);
    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "wav" {
        return crate::transcribe::load_audio_for_transcription(&source)
            .map_err(|err| format!("Failed to decode audio: {err}"));
    }

    let temp = std::env::temp_dir().join(format!(
        "glimpse-transcribe-{}-{}.wav",
        std::process::id(),
        NEXT_DECODE_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let result = crate::library::convert_to_wav(&source, &temp, &ext, None, None, None)
        .map_err(|err| format!("Failed to decode audio: {err}"))
        .and_then(|()| {
            crate::transcribe::load_audio_for_transcription(&temp)
                .map_err(|err| format!("Failed to decode audio: {err}"))
        });
    let _ = std::fs::remove_file(&temp);
    result
}

fn active_model(settings: &crate::settings::UserSettings) -> String {
    if settings.remote_speech_enabled {
        "remote".to_string()
    } else {
        settings.local_model.clone()
    }
}
