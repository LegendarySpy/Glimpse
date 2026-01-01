use crate::assistive::get_ax_context;
use crate::dictionary::add_dictionary_word;
use crate::{toast, AppRuntime, AppState};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const POLL_INTERVAL: Duration = Duration::from_millis(200);
const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(5);
const CORRECTION_THRESHOLD: u32 = 2;
const SESSION_TIMEOUT: Duration = Duration::from_secs(2 * 24 * 60 * 60);

pub struct CorrectionDetector {
    handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    counter: Arc<Mutex<Counter>>,
}

struct Counter {
    counts: HashMap<String, u32>,
    started: Instant,
}

impl Counter {
    fn new() -> Self {
        Self { counts: HashMap::new(), started: Instant::now() }
    }

    fn add(&mut self, word: &str, n: u32) -> u32 {
        if self.started.elapsed() >= SESSION_TIMEOUT {
            self.counts.clear();
            self.started = Instant::now();
        }
        let count = self.counts.entry(word.to_lowercase()).or_insert(0);
        *count += n;
        *count
    }

    fn remove(&mut self, word: &str) {
        self.counts.remove(&word.to_lowercase());
    }
}

impl CorrectionDetector {
    pub fn new() -> Self {
        Self {
            handle: Mutex::new(None),
            counter: Arc::new(Mutex::new(Counter::new())),
        }
    }

    pub fn remove_correction(&self, word: &str) {
        self.counter.lock().remove(word);
    }

    pub fn start_session(&self, app: AppHandle<AppRuntime>, _original: String) {
        if let Some(h) = self.handle.lock().take() {
            h.abort();
        }

        let counter = Arc::clone(&self.counter);
        let handle = tokio::spawn(async move {
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
                        process_corrections(&initial, &last_value, &counter, &app);
                    }
                    break;
                }
            }
        });

        *self.handle.lock() = Some(handle);
    }
}

fn word_freq(text: &str) -> HashMap<String, (i32, String)> {
    let mut freq: HashMap<String, (i32, String)> = HashMap::new();
    for word in text.split_whitespace() {
        let w = word.trim_matches(|c: char| c.is_ascii_punctuation());
        if !w.is_empty() {
            let key = w.to_lowercase();
            let entry = freq.entry(key).or_insert((0, w.to_string()));
            entry.0 += 1;
            // Keep the version with most capital letters (likely the intended form)
            if w.chars().filter(|c| c.is_uppercase()).count()
                > entry.1.chars().filter(|c| c.is_uppercase()).count()
            {
                entry.1 = w.to_string();
            }
        }
    }
    freq
}

fn process_corrections(
    initial: &str,
    final_text: &str,
    counter: &Arc<Mutex<Counter>>,
    app: &AppHandle<AppRuntime>,
) {
    let old_freq = word_freq(initial);
    let new_freq = word_freq(final_text);

    let old_word_count: i32 = old_freq.values().map(|(c, _)| *c).sum();
    let new_word_count: i32 = new_freq.values().map(|(c, _)| *c).sum();

    // Skip if text grew or shrank significantly (likely app output, not user edit)
    let diff = (new_word_count - old_word_count).abs();
    if diff > 9 {
        return;
    }

    for (key, (new_count, original)) in &new_freq {
        let old_count = old_freq.get(key).map(|(c, _)| *c).unwrap_or(0);
        let delta = new_count - old_count;
        if delta > 0 && delta <= 5 {
            let count = counter.lock().add(key, delta as u32);
            if count >= CORRECTION_THRESHOLD {
                let action = format!("add_to_dictionary:{}", original);
                toast::emit_toast(app, toast::Payload {
                    toast_type: "info".to_string(),
                    title: Some("New word learned".to_string()),
                    message: original.clone(),
                    auto_dismiss: Some(true),
                    duration: Some(8000),
                    retry_id: None,
                    mode: None,
                    action: Some(action),
                    action_label: Some("Add".to_string()),
                });
            }
        }
    }
}

#[tauri::command]
pub fn handle_dictionary_action(
    action: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let word = action
        .strip_prefix("add_to_dictionary:")
        .ok_or("Invalid action")?;

    add_dictionary_word(word, &app, state.clone())?;
    state.correction_detector.remove_correction(word);

    Ok(())
}
