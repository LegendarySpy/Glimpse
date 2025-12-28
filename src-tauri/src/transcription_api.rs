use std::fs;

use anyhow::{anyhow, Context, Result};
use reqwest::{multipart, Client};
use serde::Deserialize;

use crate::recorder::RecordingSaved;

/// Maximum audio file size 25MB
const MAX_AUDIO_SIZE_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct TranscriptionConfig {
    pub endpoint: String,
    pub api_key: String,
    pub include_word_timestamps: bool,
    pub auto_paste: bool,
}

impl TranscriptionConfig {
    pub fn from_env() -> Self {
        dotenvy::dotenv().ok();
        Self {
            endpoint: std::env::var("GLIMPSE_API_URL")
                .or_else(|_| std::env::var("GLIMPSE_API_ENDPOINT"))
                .unwrap_or_else(|_| "http://127.0.0.1:9001".into()),
            api_key: std::env::var("GLIMPSE_API_KEY").unwrap_or_else(|_| "local-dev-key".into()),
            include_word_timestamps: env_flag("GLIMPSE_INCLUDE_WORD_TIMESTAMPS", false),
            auto_paste: env_flag("GLIMPSE_AUTO_PASTE", true),
        }
    }

    pub fn from_settings(_settings: &crate::settings::UserSettings) -> Self {
        Self::from_env()
    }

    pub fn endpoint_url(&self) -> String {
        format!("{}/transcribe", self.endpoint.trim_end_matches('/'))
    }
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct CloudTranscriptionConfig {
    pub function_url: String,
    pub jwt: String,
    pub llm_cleanup: bool,
    pub user_context: Option<String>,
    pub selected_text: Option<String>,
    pub auto_paste: bool,
    pub history_sync_enabled: bool,
}

impl CloudTranscriptionConfig {
    pub fn new(
        function_url: String,
        jwt: String,
        llm_cleanup: bool,
        user_context: Option<String>,
        history_sync_enabled: bool,
    ) -> Self {
        Self {
            function_url,
            jwt,
            llm_cleanup,
            user_context,
            selected_text: None,
            auto_paste: env_flag("GLIMPSE_AUTO_PASTE", true),
            history_sync_enabled,
        }
    }

    pub fn with_selected_text(mut self, text: Option<String>) -> Self {
        self.selected_text = text;
        self
    }
}

fn env_flag(key: &str, default: bool) -> bool {
    std::env::var(key)
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(default)
}

#[derive(Debug, Deserialize)]
pub struct TranscriptionSuccess {
    pub transcript: String,
    pub speech_model: Option<String>,
}

pub fn normalize_transcript(input: &str) -> String {
    input
        .lines()
        .map(|line| {
            let mut normalized = String::with_capacity(line.len());
            let mut had_space = false;
            for ch in line.chars() {
                if ch == ' ' || ch == '\t' {
                    if !normalized.is_empty() && !had_space {
                        normalized.push(' ');
                    }
                    had_space = true;
                } else {
                    normalized.push(ch);
                    had_space = false;
                }
            }
            normalized.trim_end().to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

#[derive(Debug, Deserialize)]
struct ApiResponse {
    transcript: String,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiErrorResponse {
    error: String,
}

pub async fn request_transcription(
    client: &Client,
    saved: &RecordingSaved,
    config: &TranscriptionConfig,
) -> Result<TranscriptionSuccess> {
    let metadata = fs::metadata(&saved.path)
        .with_context(|| format!("Failed to read file metadata at {}", saved.path.display()))?;
    if metadata.len() > MAX_AUDIO_SIZE_BYTES {
        return Err(anyhow!(
            "Audio file too large ({:.1}MB, max {}MB)",
            metadata.len() as f64 / 1024.0 / 1024.0,
            MAX_AUDIO_SIZE_BYTES / 1024 / 1024
        ));
    }

    let bytes = fs::read(&saved.path)
        .with_context(|| format!("Failed to read recording at {}", saved.path.display()))?;
    let file_name = saved
        .path
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "recording.mp3".to_string());
    let mime = mime_guess::from_path(&saved.path).first_or_octet_stream();

    let part = multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(mime.as_ref())?;

    let form = multipart::Form::new().part("file", part);

    let request = client
        .post(config.endpoint_url())
        .query(&[("include_word_timestamps", config.include_word_timestamps)])
        .multipart(form);

    let request = if config.api_key.is_empty() {
        request
    } else {
        request.header("x-api-key", &config.api_key)
    };

    let response = request
        .send()
        .await
        .context("Failed to reach transcription API")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if status.is_success() {
        let parsed: ApiResponse = serde_json::from_str(&text)
            .with_context(|| format!("Unexpected transcription response: {text}"))?;
        return Ok(TranscriptionSuccess {
            transcript: normalize_transcript(&parsed.transcript),
            speech_model: parsed.model,
        });
    }

    if let Ok(parsed) = serde_json::from_str::<ApiErrorResponse>(&text) {
        Err(anyhow!(parsed.error))
    } else if text.is_empty() {
        Err(anyhow!(format!(
            "Transcription API returned status {status}"
        )))
    } else {
        Err(anyhow!(text))
    }
}

#[derive(Debug, Deserialize)]
pub struct CloudTranscriptionResponse {
    pub transcript: String,
    pub raw_text: Option<String>,
    pub model: String,
    pub llm_cleaned: bool,
    pub llm_model: Option<String>,
    #[serde(default)]
    pub audio_file_id: Option<String>,
    #[serde(default)]
    pub transcription_id: Option<String>,
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct CloudTranscriptionSuccess {
    pub transcript: String,
    pub raw_text: Option<String>,
    pub speech_model: String,
    pub llm_cleaned: bool,
    pub llm_model: Option<String>,
    pub audio_file_id: Option<String>,
    pub transcription_id: Option<String>,
}

pub async fn request_cloud_transcription(
    client: &Client,
    saved: &RecordingSaved,
    config: &CloudTranscriptionConfig,
) -> Result<CloudTranscriptionSuccess> {
    let metadata = fs::metadata(&saved.path)
        .with_context(|| format!("Failed to read file metadata at {}", saved.path.display()))?;
    if metadata.len() > MAX_AUDIO_SIZE_BYTES {
        return Err(anyhow!(
            "Audio file too large ({:.1}MB, max {}MB)",
            metadata.len() as f64 / 1024.0 / 1024.0,
            MAX_AUDIO_SIZE_BYTES / 1024 / 1024
        ));
    }

    let bytes = fs::read(&saved.path)
        .with_context(|| format!("Failed to read recording at {}", saved.path.display()))?;

    let mut url = config.function_url.clone();
    let mut query_parts = Vec::new();

    if !config.llm_cleanup {
        query_parts.push("llm_cleanup=false".to_string());
    }
    if let Some(ref ctx) = config.user_context {
        query_parts.push(format!("user_context={}", urlencoding::encode(ctx)));
    }

    if !query_parts.is_empty() {
        url = format!("{}?{}", url, query_parts.join("&"));
    }

    eprintln!(
        "[cloud_transcription] POST {} (audio size: {} bytes, edit_mode: {})",
        url,
        bytes.len(),
        config.selected_text.is_some()
    );

    let mut request = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", &config.jwt))
        .header("Content-Type", "audio/mpeg")
        .header(
            "X-History-Sync-Enabled",
            if config.history_sync_enabled {
                "true"
            } else {
                "false"
            },
        );

    if let Some(ref selected) = config.selected_text {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(selected.as_bytes());
        request = request.header("X-Selected-Text", encoded);
    }

    let response = request
        .body(bytes)
        .send()
        .await
        .context("Failed to reach cloud transcription API")?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    eprintln!(
        "[cloud_transcription] Response status={} body_len={}",
        status,
        text.len()
    );
    if !status.is_success() {
        eprintln!("[cloud_transcription] Error response: {} chars", text.len());
    }

    if status.is_success() {
        let parsed: CloudTranscriptionResponse =
            serde_json::from_str(&text).context("Failed to parse cloud transcription response")?;
        return Ok(CloudTranscriptionSuccess {
            transcript: normalize_transcript(&parsed.transcript),
            raw_text: parsed.raw_text.map(|t| normalize_transcript(&t)),
            speech_model: parsed.model,
            llm_cleaned: parsed.llm_cleaned,
            llm_model: parsed.llm_model,
            audio_file_id: parsed.audio_file_id,
            transcription_id: parsed.transcription_id,
        });
    }

    if let Ok(parsed) = serde_json::from_str::<ApiErrorResponse>(&text) {
        Err(anyhow!(parsed.error))
    } else if text.is_empty() {
        Err(anyhow!(format!(
            "Cloud transcription API returned status {status}"
        )))
    } else {
        Err(anyhow!(text))
    }
}
