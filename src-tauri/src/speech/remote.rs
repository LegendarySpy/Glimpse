use std::path::Path;

use glimpse_speech::TimestampGranularity;
use glimpse_speech::provider::remote_config;
use glimpse_speech::remote::{RemoteEngine, RemoteError, RemoteErrorKind, RemoteRequestParams};
use reqwest::Client;
use tauri::AppHandle;

use crate::{
    AppRuntime, model_manager,
    settings::UserSettings,
    toast,
    transcription_api::{TranscriptionSuccess, normalize_transcript},
};

pub(crate) fn has_valid_config(settings: &UserSettings) -> bool {
    !settings.remote_speech_endpoint.trim().is_empty()
        && resolved_model_name(settings).is_some()
        && (!provider_requires_api_key(&settings.remote_speech_provider)
            || !settings.remote_speech_api_key.trim().is_empty())
}

pub(crate) fn is_configured(settings: &UserSettings) -> bool {
    settings.remote_speech_enabled && has_valid_config(settings)
}

pub(crate) fn resolved_endpoint(settings: &UserSettings) -> String {
    settings.remote_speech_endpoint.trim().to_string()
}

pub(crate) fn provider_default_model(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "openai" => Some("gpt-4o-mini-transcribe"),
        "groq" => Some("whisper-large-v3-turbo"),
        "mistral" => Some("voxtral-mini-latest"),
        "fireworks" => Some("whisper-v3"),
        "openrouter" => Some("openai/whisper-1"),
        "deepgram" => Some("nova-3"),
        "elevenlabs" => Some("scribe_v1"),
        "vllm" => Some("openai/whisper-large-v3-turbo"),
        "localai" | "whisper-cpp" | "llamaedge" | "litellm" => Some("whisper-1"),
        _ => None,
    }
}

pub(crate) fn provider_requires_api_key(provider: &str) -> bool {
    matches!(
        provider.trim().to_ascii_lowercase().as_str(),
        "openai" | "groq" | "mistral" | "fireworks" | "openrouter" | "deepgram" | "elevenlabs"
    )
}

pub(crate) fn resolve_model(provider: &str, model: &str) -> Option<String> {
    let model = model.trim();
    if !model.is_empty() && !model.eq_ignore_ascii_case("auto") {
        return Some(model.to_string());
    }
    provider_default_model(provider).map(str::to_string)
}

pub(crate) fn resolved_model_name(settings: &UserSettings) -> Option<String> {
    resolve_model(
        &settings.remote_speech_provider,
        &settings.remote_speech_model,
    )
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct TranscribeOptions {
    pub timestamps: bool,
    pub diarization: bool,
}

pub(crate) async fn transcribe_file(
    client: &Client,
    wav_path: &Path,
    settings: &UserSettings,
    options: TranscribeOptions,
) -> Result<RemoteTranscriptionSuccess, RemoteError> {
    let model = resolved_model_name(settings).unwrap_or_default();
    let language = settings.language.trim();
    let dictionary: Vec<String> = settings
        .dictionary
        .iter()
        .map(|term| term.trim().to_string())
        .filter(|term| !term.is_empty())
        .collect();
    let config = remote_config(
        resolved_endpoint(settings),
        settings.remote_speech_api_key.clone(),
        Some(model.clone()),
    );
    let engine = RemoteEngine::new(client.clone(), config);
    let params = RemoteRequestParams {
        model: &model,
        language: (!language.is_empty()).then_some(language),
        dictionary: &dictionary,
        prompt: None,
        timestamps: options.timestamps,
        timestamp_granularity: options.timestamps.then_some(TimestampGranularity::Segment),
    };
    let (response, diarized_segments) = if options.diarization {
        let response = engine.transcribe_file_diarized(wav_path, params).await?;
        (response.transcription, response.segments)
    } else {
        (engine.transcribe_file(wav_path, params).await?, None)
    };

    Ok(RemoteTranscriptionSuccess {
        transcription: TranscriptionSuccess {
            transcript: normalize_transcript(&response.text),
            speech_model: Some(speech_model_storage_label(
                settings,
                Some(response.model_id.as_str()),
            )),
            segments: response.segments,
            words: response.words,
        },
        diarized_segments,
    })
}

pub(crate) struct RemoteTranscriptionSuccess {
    pub transcription: TranscriptionSuccess,
    pub diarized_segments: Option<Vec<glimpse_speech::remote::DiarizedSegment>>,
}

pub(crate) enum RemoteAttempt {
    Success(RemoteTranscriptionSuccess),
    Cancelled,
    Fallback,
    Unavailable(String),
}

pub(crate) async fn attempt_remote(
    app: &AppHandle<AppRuntime>,
    client: &Client,
    settings: &UserSettings,
    wav_path: &Path,
    local_fallback_model: &str,
    options: TranscribeOptions,
    is_cancelled: impl Fn() -> bool,
) -> RemoteAttempt {
    match transcribe_file(client, wav_path, settings, options).await {
        Ok(result) => RemoteAttempt::Success(result),
        Err(_) if is_cancelled() => RemoteAttempt::Cancelled,
        Err(error) => {
            tracing::error!("Remote speech failed, falling back to local model: {error}");
            let remote_model = speech_model_storage_label(settings, None);
            let reason = remote_error_reason(&error);
            match model_manager::ensure_local_fallback_model(app, local_fallback_model) {
                Ok(ready) => {
                    let local_model = model_manager::model_label(&ready.key);
                    crate::analytics::track_transcription_fallback(
                        app,
                        &remote_model,
                        &local_model,
                        reason,
                        "used",
                    );
                    emit_fallback_toast(app, &error);
                    RemoteAttempt::Fallback
                }
                Err(_) => {
                    let local_model = model_manager::model_label(local_fallback_model);
                    crate::analytics::track_transcription_fallback(
                        app,
                        &remote_model,
                        &local_model,
                        reason,
                        "unavailable",
                    );
                    let message = fallback_unavailable_toast_message(&error);
                    emit_fallback_unavailable_toast_message(app, &message);
                    RemoteAttempt::Unavailable(message)
                }
            }
        }
    }
}

fn remote_error_reason(error: &RemoteError) -> &'static str {
    match error.kind {
        RemoteErrorKind::RateLimited => "rate_limited",
        RemoteErrorKind::QuotaExceeded => "quota_exceeded",
        RemoteErrorKind::Unauthorized => "unauthorized",
        RemoteErrorKind::InvalidRequest => "invalid_request",
        RemoteErrorKind::NotFound => "not_found",
        RemoteErrorKind::UpstreamUnavailable => "upstream_unavailable",
        RemoteErrorKind::Other => "unknown",
    }
}

pub(crate) const SPEECH_MODEL_REMOTE_PREFIX: &str = "remote:";

pub(crate) fn is_remote_model(value: &str) -> bool {
    value.trim().starts_with(SPEECH_MODEL_REMOTE_PREFIX)
}

pub(crate) fn speech_model_storage_label(
    settings: &UserSettings,
    model_used: Option<&str>,
) -> String {
    let provider = settings.remote_speech_provider.trim();
    let model = model_used
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| resolved_model_name(settings))
        .unwrap_or_default();
    if model.is_empty() {
        format!("{SPEECH_MODEL_REMOTE_PREFIX}{provider}")
    } else {
        format!("{SPEECH_MODEL_REMOTE_PREFIX}{provider}:{model}")
    }
}

pub(crate) fn fallback_toast_message(error: &RemoteError) -> String {
    let lead = remote_issue_message(error);
    format!("{lead} Defaulting to local model.")
}

pub(crate) fn fallback_unavailable_toast_message(error: &RemoteError) -> String {
    format!(
        "{} No local model is installed for fallback.",
        remote_issue_message(error)
    )
}

pub(crate) fn is_fallback_unavailable_message(message: &str) -> bool {
    message.contains("No local model is installed for fallback.")
}

pub(crate) fn emit_fallback_toast(app: &AppHandle<AppRuntime>, error: &RemoteError) {
    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "warning".to_string(),
            title: Some("Speech Provider".to_string()),
            message: fallback_toast_message(error),
            auto_dismiss: Some(true),
            duration: None,
            retry_id: None,
            mode: None,
            action: None,
            action_label: None,
            secondary_action: None,
            secondary_action_label: None,
        },
    );
}

pub(crate) fn emit_not_configured_toast(app: &AppHandle<AppRuntime>, settings: &UserSettings) {
    let mut missing: Vec<&str> = Vec::new();
    if settings.remote_speech_endpoint.trim().is_empty() {
        missing.push("an endpoint");
    }
    if resolved_model_name(settings).is_none() {
        missing.push("a model");
    }
    if provider_requires_api_key(&settings.remote_speech_provider)
        && settings.remote_speech_api_key.trim().is_empty()
    {
        missing.push("an API key");
    }
    let needed = match missing.as_slice() {
        [] => "the required settings".to_string(),
        [one] => one.to_string(),
        [first, second] => format!("{first} and {second}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    };
    let message = format!("Add {needed} in Settings before enabling a remote speech provider.");
    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "warning".to_string(),
            title: Some("Speech Provider".to_string()),
            message,
            auto_dismiss: Some(true),
            duration: None,
            retry_id: None,
            mode: None,
            action: None,
            action_label: None,
            secondary_action: None,
            secondary_action_label: None,
        },
    );
}

fn emit_fallback_unavailable_toast_message(app: &AppHandle<AppRuntime>, message: &str) {
    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "error".to_string(),
            title: Some("Speech Provider".to_string()),
            message: message.to_string(),
            auto_dismiss: Some(true),
            duration: None,
            retry_id: None,
            mode: None,
            action: None,
            action_label: None,
            secondary_action: None,
            secondary_action_label: None,
        },
    );
}

fn remote_issue_message(error: &RemoteError) -> String {
    match error.kind {
        RemoteErrorKind::RateLimited => {
            if let Some(retry_after) = error.retry_after {
                let seconds = retry_after.as_secs().max(1);
                format!(
                    "Speech provider rate limit reached (retry in about {seconds} second{}).",
                    if seconds == 1 { "" } else { "s" }
                )
            } else {
                "Speech provider rate limit reached.".to_string()
            }
        }
        RemoteErrorKind::QuotaExceeded => "Speech provider quota exceeded.".to_string(),
        RemoteErrorKind::Unauthorized => {
            "Speech provider API key is invalid or expired.".to_string()
        }
        RemoteErrorKind::InvalidRequest => {
            let detail = error.message.trim();
            if detail.is_empty() {
                "Speech provider rejected the request.".to_string()
            } else {
                const MAX_DETAIL_CHARS: usize = 160;
                let mut snippet: String = detail.chars().take(MAX_DETAIL_CHARS).collect();
                if detail.chars().count() > MAX_DETAIL_CHARS {
                    snippet.push('…');
                }
                format!("Speech provider rejected the request: {snippet}")
            }
        }
        RemoteErrorKind::NotFound => "Speech provider endpoint or model was not found.".to_string(),
        RemoteErrorKind::UpstreamUnavailable | RemoteErrorKind::Other => {
            "Speech provider unreachable.".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_model;

    #[test]
    fn concrete_model_is_passed_through() {
        assert_eq!(
            resolve_model("openai", "whisper-1").as_deref(),
            Some("whisper-1")
        );
    }

    #[test]
    fn auto_resolves_to_provider_default() {
        assert_eq!(
            resolve_model("groq", "auto").as_deref(),
            Some("whisper-large-v3-turbo")
        );
        assert_eq!(
            resolve_model("mistral", "  ").as_deref(),
            Some("voxtral-mini-latest")
        );
        assert_eq!(resolve_model("custom", "auto"), None);
    }

    #[test]
    fn unknown_provider_without_model_is_unresolved() {
        assert_eq!(resolve_model("nope", "auto"), None);
    }
}
