use crate::settings::{Personality, UserSettings};
use crate::{accessibility_context, permissions};

#[derive(Debug, Clone)]
pub struct ModeContextMode {
    pub name: String,
    pub instructions: Vec<String>,
}

const MODE_PROMPT_PREAMBLE: &str = "You transform text according to the instructions below.\n- Follow the mode instructions exactly.\n- Preserve meaning unless the instructions require otherwise.\n- Output only the transformed text.";

fn extract_host(candidate: &str) -> Option<String> {
    let mut value = candidate.trim().to_lowercase();
    if value.is_empty() {
        return None;
    }

    if let Some(index) = value.find("://") {
        value = value[(index + 3)..].to_string();
    }

    let slash_index = value.find('/').unwrap_or(value.len());
    let host_port = &value[..slash_index];
    let host_port = host_port.split('@').last().unwrap_or(host_port);
    let host = host_port.split(':').next().unwrap_or(host_port);

    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

fn token_match(haystack: &str, needle: &str) -> bool {
    let haystack = haystack.to_lowercase();
    let needle = needle.to_lowercase();
    if haystack.is_empty() || needle.is_empty() {
        return false;
    }

    let pattern = format!(r"(^|[^a-z0-9]){}([^a-z0-9]|$)", regex::escape(&needle));
    match regex::Regex::new(&pattern) {
        Ok(regex) => regex.is_match(&haystack),
        Err(_) => false,
    }
}

fn site_matches(haystack: &str, site: &str) -> bool {
    let site = site.trim().to_lowercase();
    if site.is_empty() {
        return false;
    }

    let target = if haystack.contains("://") {
        extract_host(haystack).unwrap_or_else(|| haystack.to_string())
    } else {
        haystack.to_string()
    };

    if token_match(&target, &site) {
        return true;
    }

    let mut labels = site.split('.');
    if let Some(label) = labels.next() {
        if label != site && label.len() >= 4 {
            return token_match(&target, label);
        }
    }

    false
}

fn app_matches(app_name: &str, entry: &str) -> bool {
    let app_name = app_name.trim();
    let entry = entry.trim();
    if app_name.is_empty() || entry.is_empty() {
        return false;
    }

    app_name.eq_ignore_ascii_case(entry) || token_match(app_name, entry)
}

fn mode_matches(mode: &Personality, context: &accessibility_context::ActiveContext) -> bool {
    let app_match = mode
        .apps
        .iter()
        .any(|app| app_matches(&context.app_name, app));
    let site_match_from_url = context
        .url
        .as_ref()
        .map(|url| mode.websites.iter().any(|site| site_matches(url, site)))
        .unwrap_or(false);
    let site_match_from_title = mode
        .websites
        .iter()
        .any(|site| site_matches(&context.window_title, site));

    app_match || site_match_from_url || site_match_from_title
}

fn resolve_mode_context(settings: &UserSettings) -> Option<Vec<ModeContextMode>> {
    if !permissions::check_accessibility_permission() {
        return None;
    }

    let context = accessibility_context::get_active_context()?;
    let modes: Vec<ModeContextMode> = settings
        .personalities
        .iter()
        .filter(|mode| mode.enabled)
        .filter(|mode| mode_matches(mode, &context))
        .map(|mode| ModeContextMode {
            name: mode.name.clone(),
            instructions: mode.instructions.clone(),
        })
        .collect();

    if modes.is_empty() {
        return None;
    }

    Some(modes)
}

pub fn format_mode_context(modes: &[ModeContextMode]) -> String {
    let mut lines = Vec::new();
    for mode in modes {
        lines.push(format!("Mode: {}", mode.name));
        for instruction in &mode.instructions {
            lines.push(format!("- {}", instruction));
        }
    }

    lines.join("\n")
}

pub fn build_mode_prompt(settings: &UserSettings) -> Option<String> {
    let modes = resolve_mode_context(settings)?;
    let instructions = format_mode_context(&modes);
    if instructions.is_empty() {
        return None;
    }

    let mut prompt = MODE_PROMPT_PREAMBLE.to_string();
    if !settings.user_name.trim().is_empty() {
        prompt.push_str(&format!("\n- User name: {}", settings.user_name.trim()));
    }
    prompt.push_str("\n\n");
    prompt.push_str(&instructions);
    Some(prompt)
}
