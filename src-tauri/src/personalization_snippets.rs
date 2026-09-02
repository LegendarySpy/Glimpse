use std::env;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::OnceLock;

use chrono::{Datelike, Local};

use crate::accessibility_context::ActiveContext;

const MAX_DYNAMIC_TEXT_LEN: usize = 20_000;

#[derive(Debug, Clone, Default)]
pub struct SnippetContext {
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub website: Option<String>,
    pub url: Option<String>,
}

impl SnippetContext {
    pub fn from_active_context(context: &ActiveContext) -> Self {
        Self {
            app_name: non_empty(context.app_name.trim()),
            window_title: non_empty(context.window_title.trim()),
            website: context
                .url
                .as_deref()
                .and_then(extract_host)
                .or_else(|| extract_host(&context.window_title)),
            url: context.url.as_deref().and_then(non_empty),
        }
    }
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

pub(crate) fn extract_host(candidate: &str) -> Option<String> {
    let mut value = candidate.trim().to_lowercase();
    if value.is_empty() {
        return None;
    }

    if let Some(index) = value.find("://") {
        value = value[(index + 3)..].to_string();
    }

    let end_index = value
        .find(|ch: char| ch == '/' || ch == '?' || ch == '#' || ch.is_whitespace())
        .unwrap_or(value.len());
    let host_port = &value[..end_index];
    let host_port = host_port.split('@').next_back().unwrap_or(host_port);
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        rest.find(']')
            .map(|end| &rest[..end])
            .unwrap_or_else(|| host_port.split(':').next().unwrap_or(host_port))
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };
    let host = host.trim_start_matches("www.");

    non_empty(host)
}

fn snippet_value(name: &str, context: Option<&SnippetContext>) -> Option<String> {
    let now = Local::now();
    match name.trim().to_ascii_lowercase().as_str() {
        "date" => Some(now.format("%B %-d, %Y").to_string()),
        "tomorrow" => Some(
            (now + chrono::Duration::days(1))
                .format("%B %-d, %Y")
                .to_string(),
        ),
        "yesterday" => Some(
            (now - chrono::Duration::days(1))
                .format("%B %-d, %Y")
                .to_string(),
        ),
        "day" => Some(now.format("%A").to_string()),
        "day_short" => Some(now.format("%a").to_string()),
        "month" => Some(now.format("%B").to_string()),
        "year" => Some(now.year().to_string()),
        "time" => Some(now.format("%-I:%M %p").to_string()),
        "time_24" => Some(now.format("%H:%M").to_string()),
        "datetime" | "date_time" => Some(now.format("%B %-d, %Y at %-I:%M %p").to_string()),
        "timezone" => Some(now.format("%Z").to_string()),
        "app" | "application" | "app_name" => context.and_then(|context| context.app_name.clone()),
        "window" | "window_title" | "title" => {
            context.and_then(|context| context.window_title.clone())
        }
        "site" | "website" | "domain" => context.and_then(|context| context.website.clone()),
        "url" => context.and_then(|context| context.url.clone()),
        "browser" => context
            .and_then(|context| context.app_name.as_deref())
            .and_then(normalize_browser_name),
        "user_name" => user_name(),
        "first_name" => {
            user_name().and_then(|name| name.split_whitespace().next().map(str::to_string))
        }
        "language" => language(),
        _ => None,
    }
}

pub fn expand_personalization_snippets(text: &str, context: Option<&SnippetContext>) -> String {
    static SNIPPET_RE: OnceLock<regex::Regex> = OnceLock::new();
    let re =
        SNIPPET_RE.get_or_init(|| regex::Regex::new(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}").unwrap());

    re.replace_all(text, |captures: &regex::Captures| {
        snippet_value(&captures[1], context).unwrap_or_else(|| captures[0].to_string())
    })
    .to_string()
}

fn truncate_dynamic_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.chars().take(MAX_DYNAMIC_TEXT_LEN).collect())
}

#[cfg(target_os = "macos")]
fn run_command(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .and_then(truncate_dynamic_text)
}

fn normalize_browser_name(app_name: &str) -> Option<String> {
    let normalized = app_name
        .trim()
        .trim_end_matches(".exe")
        .to_ascii_lowercase();
    match normalized.as_str() {
        "safari" => Some("Safari".to_string()),
        "google chrome" | "chrome" => Some("Chrome".to_string()),
        "microsoft edge" | "edge" => Some("Edge".to_string()),
        "firefox" | "mozilla firefox" => Some("Firefox".to_string()),
        "arc" => Some("Arc".to_string()),
        "brave browser" | "brave" => Some("Brave".to_string()),
        "opera" | "opera browser" => Some("Opera".to_string()),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn user_name() -> Option<String> {
    run_command("id", &["-F"]).or_else(|| env::var("USER").ok().and_then(truncate_dynamic_text))
}

#[cfg(not(target_os = "macos"))]
fn user_name() -> Option<String> {
    env::var("USERNAME")
        .or_else(|_| env::var("USER"))
        .ok()
        .and_then(truncate_dynamic_text)
}

fn language() -> Option<String> {
    env::var("LC_ALL")
        .or_else(|_| env::var("LC_MESSAGES"))
        .or_else(|_| env::var("LANG"))
        .ok()
        .and_then(|value| {
            let locale = value.split('.').next().unwrap_or(&value).trim();
            let code = locale.split(['_', '-']).next().unwrap_or(locale);
            language_name(code)
        })
}

fn language_name(code: &str) -> Option<String> {
    let normalized = code.trim().to_ascii_lowercase();
    let name = match normalized.as_str() {
        "ar" => "Arabic",
        "de" => "German",
        "en" => "English",
        "es" => "Spanish",
        "fr" => "French",
        "hi" => "Hindi",
        "it" => "Italian",
        "ja" => "Japanese",
        "ko" => "Korean",
        "nl" => "Dutch",
        "pt" => "Portuguese",
        "ru" => "Russian",
        "zh" => "Chinese",
        _ => return non_empty(code),
    };
    Some(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_context_snippets_case_insensitively() {
        let context = SnippetContext {
            app_name: Some("Mail".to_string()),
            window_title: Some("Inbox".to_string()),
            website: Some("example.com".to_string()),
            url: Some("https://example.com/inbox".to_string()),
        };

        assert_eq!(
            expand_personalization_snippets(
                "Use {{app}} for {{ WINDOW_TITLE }} on {{Website}} at {{url}}.",
                Some(&context),
            ),
            "Use Mail for Inbox on example.com at https://example.com/inbox."
        );
    }

    #[test]
    fn expands_date_parts_and_browser() {
        let context = SnippetContext {
            app_name: Some("Google Chrome".to_string()),
            ..Default::default()
        };

        let expanded = expand_personalization_snippets(
            "{{day}} {{month}} {{year}} {{browser}}",
            Some(&context),
        );

        assert!(expanded.contains("Chrome"));
        assert!(!expanded.contains("{{day}}"));
        assert!(!expanded.contains("{{month}}"));
        assert!(!expanded.contains("{{year}}"));
    }

    #[test]
    fn expands_adjacent_snippets_without_spaces() {
        let expanded = expand_personalization_snippets("{{day}}{{time_24}}", None);

        assert!(!expanded.contains("{{day}}"));
        assert!(!expanded.contains("{{time_24}}"));
    }

    #[test]
    fn resolves_language_names_from_codes() {
        assert_eq!(language_name("en").as_deref(), Some("English"));
        assert_eq!(language_name("es").as_deref(), Some("Spanish"));
        assert_eq!(language_name("custom").as_deref(), Some("custom"));
    }

    #[test]
    fn leaves_unknown_or_unavailable_snippets_unchanged() {
        assert!(
            expand_personalization_snippets("Today: {{date}} {{missing}} {{app}}", None)
                .contains("{{missing}} {{app}}")
        );
    }

    #[test]
    fn extracts_host_from_active_context() {
        let context = ActiveContext {
            app_name: "Safari".to_string(),
            window_title: "https://www.example.com/path".to_string(),
            url: None,
        };

        let snippets = SnippetContext::from_active_context(&context);
        assert_eq!(snippets.website.as_deref(), Some("example.com"));
    }
}
