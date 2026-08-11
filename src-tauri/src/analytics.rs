// Anonymous, opt-out usage analytics. You are a random UUID, never your
// identity, and your transcripts/audio are never sent. Every function below
// notes in plain English exactly what it records.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

use serde_json::json;
use tauri::Manager;

use crate::{AppRuntime, AppState, settings::UserSettings};

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const POSTHOG_API_KEY: Option<&str> = option_env!("POSTHOG_API_KEY");
const POSTHOG_HOST: Option<&str> = option_env!("POSTHOG_HOST");
const CRASH_PHASES: [&str; 13] = [
    "startup",
    "setup_start",
    "logging",
    "crash_handler",
    "settings_load",
    "app_state",
    "services",
    "tray_shortcuts",
    "background_tasks",
    "analytics_init",
    "recording_recovery",
    "running",
    "shutdown",
];
static CRASH_PHASE: AtomicU8 = AtomicU8::new(0);

/// Debug builds stay out of the production project, so `tauri dev` never reports.
fn credentials() -> Option<(&'static str, &'static str)> {
    if cfg!(debug_assertions) {
        return None;
    }
    match (POSTHOG_API_KEY, POSTHOG_HOST) {
        (Some(key), Some(host)) if !key.is_empty() && !host.is_empty() => Some((key, host)),
        _ => None,
    }
}

pub fn set_crash_phase(phase: &'static str) {
    let Some(next) = CRASH_PHASES
        .iter()
        .position(|candidate| *candidate == phase)
    else {
        return;
    };
    let next = next as u8;
    let mut current = CRASH_PHASE.load(Ordering::Relaxed);
    while next > current {
        match CRASH_PHASE.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed)
        {
            Ok(_) => return,
            Err(updated) => current = updated,
        }
    }
}

pub(crate) fn crash_phase() -> &'static str {
    CRASH_PHASES
        .get(usize::from(CRASH_PHASE.load(Ordering::Relaxed)))
        .copied()
        .unwrap_or("unknown")
}

/// Starts analytics and records your app version, OS, install type, and (once) install date.
pub async fn init(app: &tauri::AppHandle<AppRuntime>) {
    let Some((api_key, host)) = credentials() else {
        return;
    };

    let (enabled, distinct_id) = app.state::<AppState>().analytics_state();
    if !enabled || distinct_id.is_empty() {
        return;
    }

    let options = match posthog_rs::ClientOptionsBuilder::default()
        .api_key(api_key.to_string())
        .host(host)
        .build()
    {
        Ok(opts) => opts,
        Err(err) => {
            tracing::error!("Failed to build PostHog client options: {err}");
            return;
        }
    };

    if let Err(err) = posthog_rs::init_global(options).await {
        tracing::error!("Failed to init PostHog: {err}");
        return;
    }

    let mut identify = posthog_rs::Event::new("$identify", &distinct_id);
    let _ = identify.insert_prop(
        "$set",
        json!({
            "app_version": APP_VERSION,
            "platform": std::env::consts::OS,
            "install_type": crate::platform::install_type(),
            "arch": std::env::consts::ARCH,
        }),
    );
    let _ = identify.insert_prop(
        "$set_once",
        json!({ "install_date": chrono::Utc::now().to_rfc3339() }),
    );
    posthog_rs::capture(identify);
}

fn build_event(
    app: &tauri::AppHandle<AppRuntime>,
    event_name: &str,
    props: serde_json::Value,
    require_enabled: bool,
) -> Option<posthog_rs::Event> {
    credentials()?;

    let (enabled, distinct_id) = app.state::<AppState>().analytics_state();
    if (require_enabled && !enabled) || distinct_id.is_empty() {
        return None;
    }

    let mut event = posthog_rs::Event::new(event_name, &distinct_id);
    let _ = event.insert_prop("app_version", APP_VERSION);
    let _ = event.insert_prop("platform", std::env::consts::OS);
    let _ = event.insert_prop("install_type", crate::platform::install_type());
    if let Some(license) = app.state::<AppState>().license_snapshot() {
        let _ = event.insert_prop("license_status", license.status);
        if let Some(edition) = license.edition {
            let _ = event.insert_prop("license_edition", edition);
        }
    }
    if let Some(obj) = props.as_object() {
        for (key, value) in obj {
            let _ = event.insert_prop(key.as_str(), value.clone());
        }
    }
    Some(event)
}

fn capture_event(app: &tauri::AppHandle<AppRuntime>, event_name: &str, props: serde_json::Value) {
    if let Some(event) = build_event(app, event_name, props, true) {
        posthog_rs::capture(event);
    }
}

fn capture_exception(
    app: &tauri::AppHandle<AppRuntime>,
    exception_type: &str,
    value: &str,
    mechanism: &str,
    fingerprint: &str,
    frame: Option<serde_json::Value>,
    extra: serde_json::Value,
) {
    let Some(mut event) = build_event(app, "$exception", extra, true) else {
        return;
    };
    let mut item = json!({
        "type": exception_type,
        "value": value,
        "mechanism": { "type": mechanism, "handled": false, "synthetic": false },
    });
    if let Some(frame) = frame {
        item["stacktrace"] = json!({ "type": "raw", "frames": [frame] });
    }
    let _ = event.insert_prop("$exception_list", json!([item]));
    let _ = event.insert_prop("$exception_level", "error");
    let _ = event.insert_prop("$exception_fingerprint", fingerprint);
    posthog_rs::capture(event);
}

fn crash_context(
    app: &tauri::AppHandle<AppRuntime>,
    marker_payload: &serde_json::Value,
) -> serde_json::Value {
    let settings = app.state::<AppState>().current_settings();
    let selected_model = crate::speech::selected_model(&settings);
    let selected_model_kind = if crate::remote_speech::is_remote_model(&selected_model) {
        "remote"
    } else {
        "local"
    };
    let local_manifest = crate::model_manager::definition(&settings.local_model);
    let marker_phase = marker_payload
        .get("crash_phase")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| crash_phase().to_string());

    json!({
        "crash_report_schema": 2,
        "crash_phase": marker_phase,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "cpu_features": cpu_features(),
        "speech_model_kind": selected_model_kind,
        "speech_model": selected_model,
        "local_model": settings.local_model,
        "local_model_engine": local_manifest.map(|manifest| format!("{:?}", manifest.engine)),
        "local_model_family": local_manifest.map(|manifest| manifest.family),
        "remote_speech_provider": if settings.remote_speech_enabled {
            Some(settings.remote_speech_provider.trim())
        } else {
            None
        },
        "remote_speech_enabled": settings.remote_speech_enabled,
        "llm_enabled": settings.llm_enabled,
    })
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn cpu_features() -> Vec<&'static str> {
    let mut features = Vec::new();
    if std::arch::is_x86_feature_detected!("sse4.2") {
        features.push("sse4.2");
    }
    if std::arch::is_x86_feature_detected!("avx") {
        features.push("avx");
    }
    if std::arch::is_x86_feature_detected!("avx2") {
        features.push("avx2");
    }
    if std::arch::is_x86_feature_detected!("fma") {
        features.push("fma");
    }
    if std::arch::is_x86_feature_detected!("avx512f") {
        features.push("avx512f");
    }
    features
}

#[cfg(target_arch = "aarch64")]
fn cpu_features() -> Vec<&'static str> {
    vec!["neon"]
}

#[cfg(not(any(target_arch = "x86", target_arch = "x86_64", target_arch = "aarch64")))]
fn cpu_features() -> Vec<&'static str> {
    Vec::new()
}

/// Records, only on the opt-out click, that this install opted out.
/// Final event sent; bypasses the enabled check since the setting is already off.
pub fn track_analytics_opt_out(app: &tauri::AppHandle<AppRuntime>) {
    if let Some(event) = build_event(app, "analytics_opt_out", json!({}), false) {
        posthog_rs::capture(event);
    }
}

/// Records that you opened the app (fires on every launch).
pub fn track_app_started(app: &tauri::AppHandle<AppRuntime>) {
    capture_event(app, "app_started", json!({}));
}

/// Records the very first time you ever run the app, once per install.
pub fn track_app_installed(app: &tauri::AppHandle<AppRuntime>) {
    capture_event(app, "app_installed", json!({}));
}

/// Records that a transcription succeeded: local vs remote, the model, whether
/// LLM cleanup ran, audio source, audio and processing duration, and word count.
/// The transcribed text itself is never included.
#[allow(clippy::too_many_arguments)]
pub fn track_transcription_completed(
    app: &tauri::AppHandle<AppRuntime>,
    mode: &str,
    model: Option<&str>,
    llm_cleaned: bool,
    audio_duration_seconds: f32,
    transcription_duration_seconds: f32,
    word_count: u32,
    audio_source: &str,
) {
    capture_event(
        app,
        "transcription_completed",
        json!({
            "mode": mode,
            "model": model.unwrap_or("unknown"),
            "llm_cleaned": llm_cleaned,
            "audio_duration_seconds": audio_duration_seconds,
            "transcription_duration_seconds": transcription_duration_seconds,
            "word_count": word_count,
            "audio_source": audio_source,
        }),
    );
}

/// Records that a transcription failed: stage, mode, speech model, bounded
/// reason, audio source, and audio duration.
pub fn track_transcription_failed(
    app: &tauri::AppHandle<AppRuntime>,
    stage: &str,
    mode: &str,
    model: &str,
    reason: &str,
    audio_duration_seconds: Option<f32>,
    audio_source: &str,
) {
    capture_event(
        app,
        "transcription_failed",
        json!({
            "stage": stage,
            "mode": mode,
            "model": model,
            "reason": reason,
            "audio_duration_seconds": audio_duration_seconds,
            "audio_source": audio_source,
        }),
    );
}

/// Records a dictation the app threw away before it reached you, as a bounded
/// reason code. Never records audio, timings, or transcript content.
pub fn track_dictation_discarded(app: &tauri::AppHandle<AppRuntime>, reason: &str) {
    capture_event(app, "dictation_discarded", json!({ "reason": reason }));
}

/// Records a bounded onboarding screen identifier without form contents.
#[tauri::command]
pub fn track_onboarding_step_viewed(app: tauri::AppHandle<AppRuntime>, step: String) {
    let step = match step.as_str() {
        "welcome" | "import" | "model" | "model_downloading" | "permissions" | "done"
        | "practice" => step.as_str(),
        _ => "unknown",
    };
    capture_event(&app, "onboarding_step_viewed", json!({ "step": step }));
}

/// Records that a one-time ask appeared, with usage as coarse
/// buckets rather than exact counts. Never records any answer.
pub fn track_ask_prompt_shown(
    app: &tauri::AppHandle<AppRuntime>,
    kind: &str,
    dictations: &str,
    days_installed: &str,
) {
    capture_event(
        app,
        &format!("{kind}_prompt_shown"),
        json!({ "dictations": dictations, "days_installed": days_installed }),
    );
}

/// Records that an ask sent someone to its destination. The form itself
/// is anonymous and carries nothing from the app.
pub fn track_ask_prompt_opened(app: &tauri::AppHandle<AppRuntime>, kind: &str) {
    capture_event(app, &format!("{kind}_prompt_opened"), json!({}));
}

/// Records that an ask was declined.
pub fn track_ask_prompt_dismissed(app: &tauri::AppHandle<AppRuntime>, kind: &str) {
    capture_event(app, &format!("{kind}_prompt_dismissed"), json!({}));
}

/// Records that the trial ran out, once per install.
pub fn track_trial_expired(app: &tauri::AppHandle<AppRuntime>) {
    capture_event(app, "trial_expired", json!({}));
}

/// Records that a license was activated, and which edition it granted.
/// The key itself is never recorded.
pub fn track_license_activated(app: &tauri::AppHandle<AppRuntime>, edition: Option<&str>) {
    capture_event(
        app,
        "license_activated",
        json!({ "edition": edition.unwrap_or("unknown") }),
    );
}

/// Records that an activation attempt failed, as a bounded reason.
/// The key that was typed is never recorded.
pub fn track_license_activation_failed(app: &tauri::AppHandle<AppRuntime>, message: &str) {
    capture_event(
        app,
        "license_activation_failed",
        json!({ "reason": classify_activation_failure(message) }),
    );
}

/// Maps an activation error onto a fixed set, so a typed key can never
/// reach analytics through the message.
fn classify_activation_failure(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    if lower.contains("device limit") {
        "device_limit"
    } else if lower.contains("was not found") {
        "not_found"
    } else if lower.contains("not valid for this app") {
        "wrong_product"
    } else if lower.contains("no longer active") {
        "revoked"
    } else if lower.contains("could not reach") {
        "network"
    } else if lower.contains("unreadable") {
        "bad_response"
    } else if lower.contains("enter your glimpse activation code") {
        "empty_key"
    } else {
        "other"
    }
}

/// Records that a locked feature was shown, and where.
#[tauri::command]
pub fn track_paywall_shown(app: tauri::AppHandle<AppRuntime>, source: String) {
    capture_event(&app, "paywall_shown", json!({ "source": source }));
}

/// Records that a locked feature was clicked, and where.
#[tauri::command]
pub fn track_paywall_clicked(app: tauri::AppHandle<AppRuntime>, source: String) {
    capture_event(&app, "paywall_clicked", json!({ "source": source }));
}

/// Records selected product-setting toggles after settings persist.
pub fn track_setting_changed(
    app: &tauri::AppHandle<AppRuntime>,
    setting: &str,
    from_value: bool,
    to_value: bool,
) {
    capture_event(
        app,
        "settings_changed",
        json!({
            "setting": setting,
            "from_value": from_value,
            "to_value": to_value,
        }),
    );
}

/// Compares persisted settings and records changes to product-feature toggles.
pub fn track_settings_changes(
    app: &tauri::AppHandle<AppRuntime>,
    previous: &UserSettings,
    next: &UserSettings,
) {
    for (setting, from_value, to_value) in [
        (
            "shortcut_cleanup_enabled",
            previous.shortcut_bindings.any_cleanup_enabled(),
            next.shortcut_bindings.any_cleanup_enabled(),
        ),
        (
            "remote_speech_enabled",
            previous.remote_speech_enabled,
            next.remote_speech_enabled,
        ),
        (
            "auto_dictionary_enabled",
            previous.auto_dictionary_enabled,
            next.auto_dictionary_enabled,
        ),
    ] {
        if from_value != to_value {
            track_setting_changed(app, setting, from_value, to_value);
        }
    }
}

/// Records the recording phase, a bounded failure reason, and whether the
/// default or a selected microphone was requested. Never records its name.
pub fn track_recording_failed(
    app: &tauri::AppHandle<AppRuntime>,
    stage: &str,
    reason: &str,
    input: &str,
) {
    capture_event(
        app,
        "recording_failed",
        json!({ "stage": stage, "reason": reason, "input": input }),
    );
}

/// Records when remote speech falls back to a local model, including the
/// bounded provider failure reason and whether fallback was available.
pub fn track_transcription_fallback(
    app: &tauri::AppHandle<AppRuntime>,
    remote_model: &str,
    local_model: &str,
    reason: &str,
    outcome: &str,
) {
    capture_event(
        app,
        "transcription_fallback",
        json!({
            "remote_model": remote_model,
            "local_model": local_model,
            "reason": reason,
            "outcome": outcome,
        }),
    );
}

/// Records the name of a speech model you downloaded.
pub fn track_model_downloaded(app: &tauri::AppHandle<AppRuntime>, model: &str) {
    capture_event(app, "model_downloaded", json!({ "model": model }));
}

/// Records a model download/install phase and bounded failure reason.
pub fn track_model_download_failed(
    app: &tauri::AppHandle<AppRuntime>,
    model: &str,
    stage: &str,
    reason: &str,
) {
    capture_event(
        app,
        "model_download_failed",
        json!({ "model": model, "stage": stage, "reason": reason }),
    );
}

/// Records a manual or automatic update phase and bounded failure reason.
pub fn track_update_failed(
    app: &tauri::AppHandle<AppRuntime>,
    source: &str,
    stage: &str,
    version: Option<&str>,
    reason: &str,
) {
    capture_event(
        app,
        "update_failed",
        json!({
            "source": source,
            "stage": stage,
            "version": version.unwrap_or("unknown"),
            "reason": reason,
        }),
    );
}

/// Records a frontend failure using only bounded fields and a local hash. The
/// exception message and stack never cross the command boundary.
#[tauri::command]
pub fn report_frontend_crash(
    app: tauri::AppHandle<AppRuntime>,
    window_label: String,
    source: String,
    error_kind: String,
    fingerprint: String,
    reason_code: String,
) {
    let window_label = match window_label.as_str() {
        "main" | "toast" | "settings" => window_label.as_str(),
        _ => "unknown",
    };
    let source = match source.as_str() {
        "render" | "window_error" | "unhandled_rejection" => source.as_str(),
        _ => "unknown",
    };
    let error_kind = match error_kind.as_str() {
        "Error" | "TypeError" | "RangeError" | "ReferenceError" | "SyntaxError" => {
            error_kind.as_str()
        }
        _ => "unknown",
    };
    let fingerprint = if fingerprint.len() <= 16
        && fingerprint
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        fingerprint.as_str()
    } else {
        "unknown"
    };
    // Must stay in sync with REASON_RULES in main.tsx.
    let reason_code = match reason_code.as_str() {
        "undefined_access" | "cancelled" | "permission" | "network" | "timeout" | "not_found" => {
            reason_code.as_str()
        }
        _ => "unknown",
    };
    let diagnostics_marker = json!({ "crash_phase": "frontend" });
    capture_exception(
        &app,
        error_kind,
        &format!("{source}:{reason_code}"),
        &format!("frontend_{source}"),
        fingerprint,
        None,
        json!({
            "window": window_label,
            "source": source,
            "error_kind": error_kind,
            "reason_code": reason_code,
            "fingerprint": fingerprint,
            "diagnostics": crash_context(&app, &diagnostics_marker),
        }),
    );
}

/// Maps a raw error message to a bounded, non-identifying reason code. Rules are
/// checked in order, so earlier (more specific) categories win.
pub fn classify_failure_reason(message: &str) -> &'static str {
    const RULES: &[(&str, &[&str])] = &[
        ("cancelled", &["cancel"]),
        (
            "permission",
            &["permission", "not allowed", "access denied"],
        ),
        (
            "unauthorized",
            &["unauthorized", "authentication", "api key"],
        ),
        ("rate_limited", &["rate limit", "too many requests"]),
        ("quota_exceeded", &["quota", "billing"]),
        ("timeout", &["timeout", "timed out"]),
        ("network", &["network", "connect", "dns"]),
        ("not_found", &["not found", "no such file"]),
        ("no_speech", &["no speech", "empty"]),
        ("model_error", &["model"]),
        ("decode", &["decode", "ffmpeg"]),
        ("verification", &["checksum", "verify"]),
        ("storage", &["disk", "write", "save", "storage"]),
        ("task_failed", &["task", "join"]),
    ];
    let message = message.to_ascii_lowercase();
    RULES
        .iter()
        .find(|(_, needles)| needles.iter().any(|needle| message.contains(needle)))
        .map_or("unknown", |(reason, _)| *reason)
}

/// Classifies an error, falling back to the full cause chain when the outermost
/// message alone yields nothing. `anyhow`'s plain Display shows only the
/// outermost context, so the matchable text is often in the chain.
pub fn classify_error(err: &anyhow::Error) -> &'static str {
    match classify_failure_reason(&err.to_string()) {
        "unknown" => classify_failure_reason(&format!("{err:#}")),
        reason => reason,
    }
}

/// Reduces a shortcut to its canonical parsed form so only values the parser
/// can produce reach analytics.
pub fn canonical_shortcut(shortcut: &str) -> String {
    crate::core::hotkeys::parse_shortcut(shortcut)
        .map(|hotkey| hotkey.to_string())
        .unwrap_or_else(|_| "invalid".to_string())
}

/// Records that you finished the first-run setup, and which dictation shortcut
/// you ended up on.
pub fn track_onboarding_completed(app: &tauri::AppHandle<AppRuntime>, smart_shortcut: &str) {
    capture_event(
        app,
        "onboarding_completed",
        json!({ "smart_shortcut": smart_shortcut }),
    );
}

/// Flushes PostHog's global worker on app exit; `capture` only enqueues.
pub fn track_app_exited(
    app: &tauri::AppHandle<AppRuntime>,
    uptime_seconds: f64,
    transcription_count: u32,
) {
    if let Some(event) = build_event(
        app,
        "app_exited",
        json!({
            "uptime_seconds": uptime_seconds,
            "transcription_count": transcription_count,
        }),
        true,
    ) {
        posthog_rs::capture(event);
    }
    let _ = tauri::async_runtime::block_on(async {
        tokio::time::timeout(std::time::Duration::from_secs(2), posthog_rs::shutdown()).await
    });
}

pub fn install_crash_handler(marker_path: PathBuf, crash_log_path: Option<PathBuf>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str));
        let when = chrono::Local::now().to_rfc3339();
        write_panic_artifacts(
            &marker_path,
            crash_log_path.as_deref(),
            &location,
            message,
            &when,
        );
        previous(info);
    }));
}

fn write_panic_artifacts(
    marker_path: &Path,
    crash_log_path: Option<&Path>,
    location: &str,
    message: Option<&str>,
    when: &str,
) {
    let crash_type = classify_panic(message);
    write_marker_atomically(
        marker_path,
        &format!(
            "{APP_VERSION}\n{location}\n{crash_type}\ncrash_phase={}\n",
            crash_phase()
        ),
    );
    if let Some(path) = crash_log_path {
        let detail: String = message
            .unwrap_or("<non-string panic payload>")
            .chars()
            .take(2000)
            .collect();
        let _ = std::fs::write(
            path,
            format!(
                "Glimpse {APP_VERSION} crashed\n\
                 # Stays on your device. May contain text you typed or file paths; review before sharing.\n\
                 time: {when}\nlocation: {location}\ntype: {crash_type}\nmessage: {detail}\n"
            ),
        );
    }
}

/// Temp-then-rename so a crash mid-write can't leave a truncated marker.
pub(crate) fn write_marker_atomically(marker_path: &Path, body: &str) {
    let temp_path = marker_path.with_extension("tmp");
    if std::fs::write(&temp_path, body).is_ok() {
        let _ = std::fs::rename(&temp_path, marker_path);
    }
}

fn classify_panic(message: Option<&str>) -> &'static str {
    let Some(message) = message else {
        return "non_string_panic";
    };
    const RULES: &[(&str, &[&str])] = &[
        ("out_of_memory", &["memory allocation", "out of memory"]),
        ("assertion", &["assertion"]),
        ("unwrap_or_expect", &["unwrap()", "expect("]),
        ("bounds_check", &["index out of bounds"]),
    ];
    let message = message.to_ascii_lowercase();
    RULES
        .iter()
        .find(|(_, needles)| needles.iter().any(|needle| message.contains(needle)))
        .map_or("string_panic", |(reason, _)| *reason)
}

pub fn report_pending_crash(app: &tauri::AppHandle<AppRuntime>, marker_path: &Path) {
    // A leftover temp file means a crash died mid-marker-write; drop it.
    let _ = std::fs::remove_file(marker_path.with_extension("tmp"));
    let Ok(contents) = std::fs::read_to_string(marker_path) else {
        return;
    };
    let _ = std::fs::remove_file(marker_path);
    let payload = parse_crash_marker(&contents);
    // Every writer fills the type line, so "unknown" means the marker was
    // cut short (e.g. the process died mid-write). Group those separately.
    let crash_type = match payload["crash_type"].as_str() {
        None | Some("unknown") => "truncated_marker".to_string(),
        Some(value) => value.to_string(),
    };
    let location = payload["location"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let location_key = sanitized_crash_location(&location, &crash_type);
    let (mechanism, fingerprint) = if crash_type == "native" {
        // Offsets are ASLR-randomized, so group on module + exception code.
        (
            "native_crash",
            format!(
                "native:{}:{}",
                payload["faulting_module"].as_str().unwrap_or("unknown"),
                payload["exception_code"].as_str().unwrap_or("unknown"),
            ),
        )
    } else {
        ("rust_panic", format!("{crash_type}:{location_key}"))
    };
    let diagnostics = crash_context(app, &payload);
    let extra = merge_json_objects(
        payload,
        json!({
            "location": location_key,
            "location_hash": stable_hash(&location_key),
            "raw_location_kind": if location == location_key { "unchanged" } else { "sanitized" },
            "diagnostics": diagnostics,
        }),
    );
    capture_exception(
        app,
        &crash_type,
        &location_key,
        mechanism,
        &fingerprint,
        Some(crash_frame(&location_key, &crash_type)),
        extra,
    );
}

fn merge_json_objects(mut base: serde_json::Value, extra: serde_json::Value) -> serde_json::Value {
    let Some(base_object) = base.as_object_mut() else {
        return extra;
    };
    if let Some(extra_object) = extra.as_object() {
        for (key, value) in extra_object {
            base_object.insert(key.clone(), value.clone());
        }
    }
    base
}

fn sanitized_crash_location(location: &str, crash_type: &str) -> String {
    if crash_type == "native" {
        return location.to_string();
    }
    let Some((path, line)) = location.rsplit_once(':') else {
        return path_tail(location);
    };
    if line.parse::<u32>().is_ok() {
        format!("{}:{line}", path_tail(path))
    } else {
        path_tail(location)
    }
}

fn path_tail(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn stable_hash(value: &str) -> String {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}

fn crash_frame(location: &str, crash_type: &str) -> serde_json::Value {
    if crash_type == "native" {
        return json!({
            "filename": location,
            "function": "<native>",
            "lang": "native",
            "platform": "native",
            "in_app": true,
            "synthetic": true,
            "resolved": false,
        });
    }
    let (filename, line_no) = location
        .rsplit_once(':')
        .and_then(|(file, line)| line.parse::<u32>().ok().map(|n| (file, Some(n))))
        .unwrap_or((location, None));
    let mut frame = json!({
        "filename": filename,
        "function": crash_type,
        "lang": "rust",
        "platform": "rust",
        "in_app": true,
        "synthetic": true,
        "resolved": true,
    });
    if let Some(line_no) = line_no {
        frame["lineno"] = json!(line_no);
    }
    frame
}

// First three lines are version/location/type; native handlers append
// key=value lines that fold into the payload.
fn parse_crash_marker(contents: &str) -> serde_json::Value {
    let mut lines = contents.lines();
    let crashed_version = lines.next().unwrap_or("unknown");
    let location = lines.next().unwrap_or("unknown");
    let crash_type = lines.next().unwrap_or("unknown");
    let mut payload = serde_json::Map::new();
    payload.insert("crashed_version".into(), json!(crashed_version));
    payload.insert("location".into(), json!(location));
    payload.insert("crash_type".into(), json!(crash_type));
    for line in lines {
        if let Some((key, value)) = line.split_once('=') {
            payload.insert(key.trim().to_string(), json!(value.trim()));
        }
    }
    serde_json::Value::Object(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_panic_marker_into_base_fields() {
        let parsed =
            parse_crash_marker("1.2.3\nsrc/lib.rs:42\nunwrap_or_expect\ncrash_phase=setup\n");
        assert_eq!(parsed["crashed_version"], "1.2.3");
        assert_eq!(parsed["location"], "src/lib.rs:42");
        assert_eq!(parsed["crash_type"], "unwrap_or_expect");
        assert_eq!(parsed["crash_phase"], "setup");
        assert!(parsed.get("faulting_module").is_none());
    }

    #[test]
    fn parses_native_marker_with_extra_fields() {
        // Exactly what platform::windows::crash emits.
        let marker = "1.0.0\nnvcuda.dll+0x7ffd1234\nnative\nexception_code=0xc0000005\nfaulting_module=nvcuda.dll\nminidump=crash.dmp\n";
        let parsed = parse_crash_marker(marker);
        assert_eq!(parsed["crash_type"], "native");
        assert_eq!(parsed["location"], "nvcuda.dll+0x7ffd1234");
        assert_eq!(parsed["exception_code"], "0xc0000005");
        assert_eq!(parsed["faulting_module"], "nvcuda.dll");
        assert_eq!(parsed["minidump"], "crash.dmp");
    }

    #[test]
    fn parses_truncated_marker_without_panicking() {
        let parsed = parse_crash_marker("1.0.0");
        assert_eq!(parsed["crashed_version"], "1.0.0");
        assert_eq!(parsed["location"], "unknown");
        assert_eq!(parsed["crash_type"], "unknown");
    }

    #[test]
    fn writes_marker_and_crash_log_then_parses_back() {
        let dir = std::env::temp_dir().join(format!("glimpse-crash-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let marker = dir.join("last_crash.txt");
        let log = dir.join("crash.log");

        write_panic_artifacts(
            &marker,
            Some(&log),
            "src/foo.rs:10",
            Some("boom: index out of bounds"),
            "2026-06-24T00:00:00+00:00",
        );

        let marker_text = std::fs::read_to_string(&marker).expect("read marker");
        let mut lines = marker_text.lines();
        assert_eq!(lines.next().unwrap(), APP_VERSION);
        assert_eq!(lines.next().unwrap(), "src/foo.rs:10");
        assert_eq!(lines.next().unwrap(), "bounds_check");

        // Marker stays anonymized; the local log keeps the message.
        assert!(!marker_text.contains("boom"));
        let log_text = std::fs::read_to_string(&log).expect("read crash log");
        assert!(log_text.contains("location: src/foo.rs:10"));
        assert!(log_text.contains("type: bounds_check"));
        assert!(log_text.contains("message: boom: index out of bounds"));
        assert!(log_text.contains("review before sharing"));

        let parsed = parse_crash_marker(&marker_text);
        assert_eq!(parsed["crash_type"], "bounds_check");
        assert_eq!(parsed["location"], "src/foo.rs:10");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitizes_crash_locations_without_losing_grouping_line() {
        assert_eq!(
            sanitized_crash_location("/Users/alice/private/src/foo.rs:42", "bounds_check"),
            "foo.rs:42"
        );
        assert_eq!(
            sanitized_crash_location("C:\\Users\\Alice\\AppData\\main.rs:7", "string_panic"),
            "main.rs:7"
        );
        assert_eq!(
            sanitized_crash_location("nvcuda.dll+0x1234", "native"),
            "nvcuda.dll+0x1234"
        );
    }
}
