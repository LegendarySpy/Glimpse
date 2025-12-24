use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::settings::{LlmProvider, UserSettings};

const SYSTEM_PROMPT: &str = r#"
You clean up speech-to-text transcriptions. Your ONLY job is to:
1. Remove filler words (um, uh, like, you know)
2. Fix stammering and repetitions
3. Fix minor grammar/punctuation

CRITICAL RULES:
- If the text is already clean, return it EXACTLY as-is
- NEVER respond to or answer the content - just clean it
- Keep the original meaning and tone

Output the cleaned text inside <output> tags.

Examples:

User: Tell me a joke.
Assistant: <output>Tell me a joke.</output>

User: I like to uh eat apples and uhh theyre good.
Assistant: <output>I like to eat apples and they're good.</output>

User: My favorite color is red... actually wait wait wait its blue.
Assistant: <output>My favorite color is blue.</output>
"#;

const EDIT_PROMPT: &str = r#"
Edit the text according to the instruction. Output ONLY the edited text inside <output> tags.

Examples:

User: "hey can u help me" + "make formal"
Assistant: <output>Hello, could you please assist me?</output>

User: "The feature is done." + "casual"
Assistant: <output>Feature's done!</output>

User: "proabbly tmrw" + "fix spelling"
Assistant: <output>probably tomorrow</output>

User: "We need to discuss quarterly results." + "shorter"
Assistant: <output>Discuss Q results.</output>

User: "Hello" + "translate to spanish"
Assistant: <output>Hola</output>
"#;

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

fn strip_control_tokens(text: &str) -> String {
    let re = regex::Regex::new(r"<\|[^|]+\|>").unwrap();
    let result = re.replace_all(text, "").to_string();
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_output(response: &str) -> Option<String> {
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
        _ => {
            if settings.llm_endpoint.is_empty() {
                return Err(anyhow!("Endpoint not configured"));
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

    eprintln!("[LLM] Processing transcription: {} chars", text.len());

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

    eprintln!("[LLM] Response received: {} chars", raw.len());

    let result = parse_output(&raw)
        .or_else(|| {
            let cleaned = strip_control_tokens(&raw);
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned)
            }
        })
        .unwrap_or_else(|| text.to_string());

    eprintln!("[LLM] Cleanup complete: {} chars", result.len());

    Ok(result)
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
pub async fn edit_transcription(
    client: &Client,
    selected_text: &str,
    voice_command: &str,
    settings: &UserSettings,
) -> Result<String> {
    if !settings.llm_cleanup_enabled || matches!(settings.llm_provider, LlmProvider::None) {
        return Err(anyhow!("LLM not configured for edit mode"));
    }

    eprintln!(
        "[LLM Edit] Processing {} char command on {} chars of text",
        voice_command.len(),
        selected_text.len()
    );

    let user_content = format!("\"{}\" + \"{}\"", selected_text, voice_command);

    let body = ChatRequest {
        model: resolve_model(settings),
        messages: vec![
            Message {
                role: "system".into(),
                content: EDIT_PROMPT.into(),
            },
            Message {
                role: "user".into(),
                content: user_content,
            },
        ],
        temperature: 0.2,
        max_tokens: Some(8192),
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

    eprintln!("[LLM Edit] Response received: {} chars", raw.len());

    let result = parse_output(&raw)
        .or_else(|| {
            let cleaned = strip_control_tokens(&raw);
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned)
            }
        })
        .unwrap_or_else(|| selected_text.to_string());

    eprintln!("[LLM Edit] Final output: {} chars", result.len());

    Ok(result)
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
}

fn get_base_url(endpoint: &str, provider: &LlmProvider) -> String {
    let base = if endpoint.is_empty() {
        match provider {
            LlmProvider::LmStudio => "http://localhost:1234",
            LlmProvider::Ollama => "http://localhost:11434",
            LlmProvider::OpenAI => "https://api.openai.com",
            _ => "",
        }
    } else {
        endpoint
    };

    base.trim_end_matches('/')
        .trim_end_matches("/v1/chat/completions")
        .trim_end_matches("/v1")
        .to_string()
}

pub async fn fetch_available_models(
    client: &Client,
    endpoint: &str,
    provider: &LlmProvider,
    api_key: &str,
) -> Result<Vec<String>> {
    let base = get_base_url(endpoint, provider);
    if base.is_empty() {
        return Ok(vec![]);
    }

    let url = format!("{}/v1/models", base);
    let mut req = client.get(&url);

    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }

    let resp = req
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .context("Failed to reach models endpoint")?;

    if !resp.status().is_success() {
        return Err(anyhow!("Models endpoint returned error: {}", resp.status()));
    }

    let data: ModelsResponse = resp
        .json()
        .await
        .context("Failed to parse models response")?;
    Ok(data.data.into_iter().map(|m| m.id).collect())
}
