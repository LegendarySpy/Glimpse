use crate::personalization_snippets::extract_host;
use crate::settings::{Personality, UserSettings};
use crate::{
    accessibility_context, permissions,
    personalization_snippets::{SnippetContext, expand_personalization_snippets},
};

#[derive(Debug, Clone)]
pub struct ModeContextMode {
    pub name: String,
    pub instructions: Vec<String>,
}

fn site_matches(url: &str, site: &str) -> bool {
    let Some(host) = extract_host(url) else {
        return false;
    };
    let Some(site_host) = extract_host(site) else {
        return false;
    };

    host == site_host || host.ends_with(&format!(".{site_host}"))
}

fn app_tokens(value: &str) -> Vec<String> {
    value
        .trim()
        .trim_end_matches(".exe")
        .to_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn tokens_contain_all(haystack: &[String], needles: &[String]) -> bool {
    !needles.is_empty() && needles.iter().all(|needle| haystack.contains(needle))
}

fn app_matches(active_app_name: &str, configured_app_name: &str) -> bool {
    let active_tokens = app_tokens(active_app_name);
    let configured_tokens = app_tokens(configured_app_name);
    if active_tokens.is_empty() || configured_tokens.is_empty() {
        return false;
    }

    active_tokens == configured_tokens
        || tokens_contain_all(&configured_tokens, &active_tokens)
        || tokens_contain_all(&active_tokens, &configured_tokens)
}

fn mode_matches(mode: &Personality, context: &accessibility_context::ActiveContext) -> bool {
    let app_match = mode
        .apps
        .iter()
        .any(|app| app_matches(&context.app_name, app));
    let site_match = if let Some(url) = context.url.as_ref() {
        mode.websites.iter().any(|site| site_matches(url, site))
    } else {
        mode.websites.iter().any(|site| {
            site_matches(&context.window_title, site) || site_matches(&context.app_name, site)
        })
    };

    app_match || site_match
}

fn format_mode_context_with_snippets(
    modes: &[ModeContextMode],
    snippet_context: Option<&SnippetContext>,
) -> String {
    let mut lines = Vec::new();
    for mode in modes {
        let normalized_instructions: Vec<String> = mode
            .instructions
            .iter()
            .filter_map(|instruction| {
                let normalized = instruction.trim().trim_start_matches('-').trim();
                if normalized.is_empty() {
                    return None;
                }
                let expanded = expand_personalization_snippets(normalized, snippet_context);
                Some(format!("- {}", expanded))
            })
            .collect();

        if normalized_instructions.is_empty() {
            continue;
        }

        lines.push(format!("Mode: {}", mode.name));
        lines.extend(normalized_instructions);
    }

    lines.join("\n")
}

pub fn format_active_cleanup_style_guidance(settings: &UserSettings) -> Option<String> {
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

    let snippet_context = SnippetContext::from_active_context(&context);
    let instructions = format_mode_context_with_snippets(&modes, Some(&snippet_context));
    if instructions.is_empty() {
        None
    } else {
        Some(instructions)
    }
}

pub fn format_cleanup_style_guidance_for_personality(personality: &Personality) -> Option<String> {
    let snippet_context = if permissions::check_accessibility_permission() {
        accessibility_context::get_active_context()
            .as_ref()
            .map(SnippetContext::from_active_context)
    } else {
        None
    };
    let mode = ModeContextMode {
        name: personality.name.clone(),
        instructions: personality.instructions.clone(),
    };
    let instructions = format_mode_context_with_snippets(&[mode], snippet_context.as_ref());
    if instructions.is_empty() {
        None
    } else {
        Some(instructions)
    }
}

pub fn resolve_active_personality(settings: &UserSettings) -> Option<Personality> {
    if !permissions::check_accessibility_permission() {
        return None;
    }

    let context = accessibility_context::get_active_context()?;

    settings
        .personalities
        .iter()
        .filter(|mode| mode.enabled)
        .find(|mode| mode_matches(mode, &context))
        .cloned()
}
