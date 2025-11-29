use std::fs;

use anyhow::{anyhow, Context, Result};
use reqwest::{multipart, Client};
use serde::Deserialize;

use crate::recorder::RecordingSaved;

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

fn env_flag(key: &str, default: bool) -> bool {
    std::env::var(key)
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(default)
}

#[derive(Debug, Deserialize)]
pub struct TranscriptionSuccess {
    pub transcript: String,
    pub confidence: Option<f32>,
}

pub fn normalize_transcript(input: &str) -> String {
    let mut normalized = String::with_capacity(input.len());
    let mut seen_non_space = false;
    let mut had_space = false;

    for ch in input.chars() {
        if ch.is_whitespace() {
            if seen_non_space && !had_space {
                normalized.push(' ');
            }
            had_space = true;
        } else {
            normalized.push(ch);
            had_space = false;
            seen_non_space = true;
        }
    }

    normalized.trim().to_string()
}

#[derive(Debug, Deserialize)]
struct ApiResponse {
    transcript: String,
    confidence: Option<f32>,
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
            confidence: parsed.confidence,
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
