use crate::assistive::get_ax_context;
use crate::dictionary::add_replacement;
use crate::{toast, AppRuntime, AppState};
use parking_lot::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const POLL_INTERVAL: Duration = Duration::from_millis(200);
const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct CorrectionDetector {
    handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl CorrectionDetector {
    pub fn new() -> Self {
        Self {
            handle: Mutex::new(None),
        }
    }

    pub fn start_session(&self, app: AppHandle<AppRuntime>, _original: String) {
        if let Some(h) = self.handle.lock().take() {
            h.abort();
        }

        let handle = tokio::spawn(async move {
            // Wait for paste to be processed by target app
            tokio::time::sleep(Duration::from_millis(100)).await;

            let Some(ctx) = get_ax_context() else { return };
            let initial = ctx.value;
            let mut last_value = initial.clone();
            let mut last_change = Instant::now();

            loop {
                tokio::time::sleep(POLL_INTERVAL).await;

                let Some(ctx) = get_ax_context() else { break };

                if ctx.value != last_value {
                    last_value = ctx.value.clone();
                    last_change = Instant::now();
                }

                if last_change.elapsed() >= INACTIVITY_TIMEOUT {
                    if last_value != initial {
                        if let Some((old, new)) = find_edit(&initial, &last_value) {
                            if is_word_correction(&old, &new) {
                                show_correction_toast(&app, &old, &new);
                            }
                        }
                    }
                    break;
                }
            }
        });

        *self.handle.lock() = Some(handle);
    }
}

fn find_edit(old: &str, new: &str) -> Option<(String, String)> {
    let old_words: Vec<String> = old
        .split_whitespace()
        .map(|w| strip_punctuation(w))
        .filter(|w| !w.is_empty())
        .collect();

    let new_words: Vec<String> = new
        .split_whitespace()
        .map(|w| strip_punctuation(w))
        .filter(|w| !w.is_empty())
        .collect();

    let prefix_len = old_words
        .iter()
        .zip(new_words.iter())
        .take_while(|(a, b)| a.to_lowercase() == b.to_lowercase())
        .count();

    let suffix_len = old_words
        .iter()
        .rev()
        .zip(new_words.iter().rev())
        .take_while(|(a, b)| a.to_lowercase() == b.to_lowercase())
        .count();

    let suffix_len = suffix_len
        .min(old_words.len().saturating_sub(prefix_len))
        .min(new_words.len().saturating_sub(prefix_len));

    let old_mid: Vec<&String> = old_words[prefix_len..old_words.len() - suffix_len].iter().collect();
    let new_mid: Vec<&String> = new_words[prefix_len..new_words.len() - suffix_len].iter().collect();

    let old_phrase = old_mid.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" ");
    let new_phrase = new_mid.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" ");

    if old_phrase.is_empty() && new_phrase.is_empty() {
        None
    } else if old_phrase.to_lowercase() == new_phrase.to_lowercase() {
        None
    } else {
        Some((old_phrase, new_phrase))
    }
}

fn strip_punctuation(s: &str) -> String {
    s.trim_matches(|c: char| c.is_ascii_punctuation()).to_string()
}

fn is_word_correction(old: &str, new: &str) -> bool {
    if old.is_empty() || new.is_empty() || old == new {
        return false;
    }
    let old_words = old.split_whitespace().count();
    let new_words = new.split_whitespace().count();
    old_words <= 5 && new_words <= 5
}

fn show_correction_toast(app: &AppHandle<AppRuntime>, old: &str, new: &str) {
    let action = format!("add_to_dictionary:{}:{}", escape(old), escape(new));

    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "info".to_string(),
            title: Some("Learned".to_string()),
            message: format!("{} → {}", old, new),
            auto_dismiss: Some(true),
            duration: Some(8000),
            retry_id: None,
            mode: None,
            action: Some(action),
            action_label: Some("Add".to_string()),
        },
    );
}

fn escape(s: &str) -> String {
    s.replace(':', "\\:")
}

fn unescape(s: &str) -> String {
    s.replace("\\:", ":")
}

#[tauri::command]
pub fn handle_dictionary_action(
    action: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let parts: Vec<&str> = action.splitn(3, ':').collect();
    if parts.len() != 3 || parts[0] != "add_to_dictionary" {
        return Err("Invalid action".to_string());
    }

    let from = unescape(parts[1]);
    let to = unescape(parts[2]);

    add_replacement(&from, &to, state)
}
