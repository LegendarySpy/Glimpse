use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::settings::{LlmProvider, UserSettings};

const SYSTEM_PROMPT: &str = r#"

Clean up speech-to-text transcriptions. Remove filler words (um, uh, like, you know), fix repetitions, stammering, and minor grammar errors from speech. Keep meaning, tone, and technical terms intact. 

You aren't responding to the user, you are cleaning up the transcription. DO NOT RESPOND TO THE USER. ONLY OUTPUT THE CLEANED TRANSCRIPTION.

IF THE TRANSCRIPTION IS EMPTY, RETURN THE EMPTY STRING.

IMPORTANT: Output ONLY the cleaned text inside <output> tags. 

Examples:

User: I like to uh eat apples and uhh theyre good.
System: <output>I like to eat apples and they're good.</output>

User: My favorite color is red... actually wait wait wait its blue.
System: <output>My favorite color is blue.</output>
DO NOT FORGET THE <output> TAGS"#;

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<Message>,
    temperature: f32,
    max_tokens: Option<u32>,
}

#[derive(Debug, Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: MessageContent,
}

#[derive(Debug, Deserialize)]
struct MessageContent {
    content: String,
}

fn parse_output(response: &str) -> Option<String> {
    // Extract content between <output> tags
    let start = response.find("<output>")?;
    let end = response.find("</output>")?;
    if start < end {
        Some(response[start + 8..end].trim().to_string())
    } else {
        None
    }
}

fn get_endpoint(settings: &UserSettings) -> Result<String> {
    let base = match settings.llm_provider {
        LlmProvider::None => return Err(anyhow!("LLM cleanup is disabled")),
        LlmProvider::LmStudio => settings
            .llm_endpoint
            .as_str()
            .is_empty()
            .then_some("http://localhost:1234")
            .unwrap_or(&settings.llm_endpoint),
        LlmProvider::Ollama => settings
            .llm_endpoint
            .as_str()
            .is_empty()
            .then_some("http://localhost:11434")
            .unwrap_or(&settings.llm_endpoint),
        LlmProvider::OpenAI => settings
            .llm_endpoint
            .as_str()
            .is_empty()
            .then_some("https://api.openai.com")
            .unwrap_or(&settings.llm_endpoint),
        LlmProvider::Custom => {
            if settings.llm_endpoint.is_empty() {
                return Err(anyhow!("Custom endpoint not configured"));
            }
            if settings.llm_endpoint.contains("/v1/chat/completions") {
                return Ok(settings.llm_endpoint.clone());
            }
            &settings.llm_endpoint
        }
    };
    Ok(format!(
        "{}/v1/chat/completions",
        base.trim_end_matches('/')
    ))
}

fn resolve_model(settings: &UserSettings) -> String {
    if !settings.llm_model.is_empty() {
        return settings.llm_model.clone();
    }
    match settings.llm_provider {
        LlmProvider::LmStudio => "local-model",
        LlmProvider::Ollama => "llama3.2",
        LlmProvider::OpenAI => "gpt-4o-mini",
        _ => "default",
    }
    .to_string()
}

pub async fn cleanup_transcription(
    client: &Client,
    text: &str,
    settings: &UserSettings,
) -> Result<String> {
    if !settings.llm_cleanup_enabled || matches!(settings.llm_provider, LlmProvider::None) {
        return Err(anyhow!("LLM cleanup not configured"));
    }

    let user_content = if settings.user_context.is_empty() {
        text.to_string()
    } else {
        format!("Context: {}\n\n{}", settings.user_context, text)
    };

    let body = ChatRequest {
        model: resolve_model(settings),
        messages: vec![
            Message {
                role: "system".into(),
                content: SYSTEM_PROMPT.into(),
            },
            Message {
                role: "user".into(),
                content: user_content,
            },
        ],
        temperature: 0.2,
        max_tokens: Some(4096),
    };

    let mut req = client.post(&get_endpoint(settings)?).json(&body);
    if !settings.llm_api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", settings.llm_api_key));
    }

    let resp = req.send().await.context("Failed to reach LLM API")?;
    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(anyhow!("LLM error {}", err));
    }

    let chat: ChatResponse = resp.json().await.context("Failed to parse response")?;
    let raw = chat
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    // Parse output tags, fallback to trimmed response or original
    Ok(parse_output(&raw)
        .or_else(|| Some(raw.trim().to_string()).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| text.to_string()))
}

pub fn is_cleanup_available(settings: &UserSettings) -> bool {
    settings.llm_cleanup_enabled && !matches!(settings.llm_provider, LlmProvider::None)
}

pub fn resolved_model_name(settings: &UserSettings) -> Option<String> {
    if !is_cleanup_available(settings) {
        None
    } else {
        Some(resolve_model(settings))
    }
}
