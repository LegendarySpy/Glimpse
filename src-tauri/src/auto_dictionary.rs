use std::{
    collections::HashSet,
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::{
    AppRuntime, AppState, EVENT_SETTINGS_CHANGED,
    assistive::{self, FocusedTextSnapshot},
    dictionary, toast,
};

const START_GRACE: Duration = Duration::from_millis(500);
const POLL_INTERVAL: Duration = Duration::from_millis(300);
const IDLE_DEBOUNCE: Duration = Duration::from_secs(2);
const HARD_CAP: Duration = Duration::from_secs(30);
const MAX_CANDIDATE_LEN: usize = 160;
const MAX_CHANGED_TOKENS: usize = 4;
const MAX_DICTIONARY_ENTRIES: usize = 64;
const MAX_IGNORED_SUGGESTIONS: usize = 128;

static PENDING_SUGGESTION: OnceLock<Mutex<Option<PendingSuggestion>>> = OnceLock::new();
static IGNORED_SUGGESTIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Clone)]
struct PendingSuggestion {
    value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Token {
    text: String,
    start: usize,
    end: usize,
}

pub(crate) fn start_after_paste(
    app: AppHandle<AppRuntime>,
    pre_paste: FocusedTextSnapshot,
    inserted_text: String,
    dictionary_entries: Vec<String>,
    ignored_entries: Vec<String>,
) {
    if inserted_text.trim().is_empty() {
        return;
    }
    let dictionary_entries = dictionary::sanitize_dictionary_entries(&dictionary_entries);
    if dictionary_entries.len() >= MAX_DICTIONARY_ENTRIES {
        return;
    }
    hydrate_ignored_suggestions(&ignored_entries);
    sync_ignored_dictionary_entries(&dictionary_entries);

    thread::spawn(move || {
        thread::sleep(START_GRACE);

        let started = Instant::now();
        let mut last_value = pre_paste.value.clone();
        let mut last_changed = Instant::now();
        let mut last_analyzed: Option<String> = None;

        while started.elapsed() < HARD_CAP {
            thread::sleep(POLL_INTERVAL);

            let Some(snapshot) = assistive::focused_text_snapshot() else {
                return;
            };
            if !same_target(&pre_paste, &snapshot) {
                return;
            }

            if snapshot.value != last_value {
                last_value = snapshot.value.clone();
                last_changed = Instant::now();
            }

            if last_value == pre_paste.value || last_changed.elapsed() < IDLE_DEBOUNCE {
                continue;
            }
            if last_analyzed.as_ref() == Some(&last_value) {
                continue;
            }
            last_analyzed = Some(last_value.clone());

            if let Some(candidate) = detect_candidate(
                &pre_paste.value,
                &inserted_text,
                &last_value,
                &dictionary_entries,
            ) {
                if is_ignored_suggestion(&candidate) {
                    return;
                }

                set_pending_suggestion(candidate.clone());
                toast::emit_toast(
                    &app,
                    toast::Payload {
                        toast_type: "info".to_string(),
                        title: None,
                        message: format!("Add \"{candidate}\" to dictionary?"),
                        auto_dismiss: Some(false),
                        duration: None,
                        retry_id: Some(candidate.clone()),
                        mode: None,
                        action: Some("accept_auto_dictionary_suggestion".to_string()),
                        action_label: Some("Add".to_string()),
                        secondary_action: Some("reject_auto_dictionary_suggestion".to_string()),
                        secondary_action_label: Some("Never".to_string()),
                    },
                );
                return;
            }
        }
    });
}

#[tauri::command]
pub(crate) fn accept_auto_dictionary_suggestion(
    suggestion: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<Vec<String>, String> {
    let suggestion = suggestion.trim().to_string();
    if suggestion.is_empty() {
        return Ok(state.current_settings().dictionary);
    }

    let mut settings = state.current_settings();
    settings.dictionary.push(suggestion.clone());
    settings.dictionary = dictionary::sanitize_dictionary_entries(&settings.dictionary);
    settings.auto_dictionary_ignored = remove_dictionary_entries_from_ignored(
        settings.auto_dictionary_ignored,
        &settings.dictionary,
    );
    let saved = state
        .persist_settings(settings)
        .map_err(|err| err.to_string())?;
    clear_ignored_suggestion(&suggestion);
    clear_pending_suggestion_value(&suggestion);

    if let Err(err) = app.emit(EVENT_SETTINGS_CHANGED, &saved) {
        tracing::error!("Failed to emit settings change: {err}");
    }

    Ok(saved.dictionary)
}

#[tauri::command]
pub(crate) fn reject_auto_dictionary_suggestion(
    suggestion: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<Vec<String>, String> {
    let suggestion = suggestion.trim().to_string();
    if suggestion.is_empty() {
        return Ok(state.current_settings().auto_dictionary_ignored);
    }

    let mut settings = state.current_settings();
    settings.auto_dictionary_ignored.push(suggestion.clone());
    settings.auto_dictionary_ignored =
        sanitize_ignored_suggestions(&settings.auto_dictionary_ignored);
    let saved = state
        .persist_settings(settings)
        .map_err(|err| err.to_string())?;
    remember_ignored_suggestion(&suggestion);
    clear_pending_suggestion_value(&suggestion);

    if let Err(err) = app.emit(EVENT_SETTINGS_CHANGED, &saved) {
        tracing::error!("Failed to emit settings change: {err}");
    }

    Ok(saved.auto_dictionary_ignored)
}

pub(crate) fn clear_pending_suggestion() {
    let _ = take_pending_suggestion();
}

pub(crate) fn sync_ignored_dictionary_entries(dictionary_entries: &[String]) {
    let mut ignored = ignored_suggestions().lock();
    for entry in dictionary_entries {
        ignored.remove(&suggestion_key(entry));
    }
}

pub(crate) fn remove_dictionary_entries_from_ignored(
    ignored_entries: Vec<String>,
    dictionary_entries: &[String],
) -> Vec<String> {
    let dictionary_keys: HashSet<String> = dictionary_entries
        .iter()
        .map(|entry| suggestion_key(entry))
        .collect();

    sanitize_ignored_suggestions(
        &ignored_entries
            .into_iter()
            .filter(|entry| !dictionary_keys.contains(&suggestion_key(entry)))
            .collect::<Vec<_>>(),
    )
}

fn same_target(initial: &FocusedTextSnapshot, current: &FocusedTextSnapshot) -> bool {
    initial.pid == current.pid
        && initial.role == current.role
        && initial.subrole == current.subrole
        && frames_match(initial.frame, current.frame)
}

fn frames_match(
    initial: Option<(f64, f64, f64, f64)>,
    current: Option<(f64, f64, f64, f64)>,
) -> bool {
    match (initial, current) {
        (Some(initial), Some(current)) => {
            (initial.0 - current.0).abs() < 2.0
                && (initial.1 - current.1).abs() < 2.0
                && (initial.2 - current.2).abs() < 2.0
        }
        _ => true,
    }
}

fn pending_suggestion() -> &'static Mutex<Option<PendingSuggestion>> {
    PENDING_SUGGESTION.get_or_init(|| Mutex::new(None))
}

fn set_pending_suggestion(value: String) {
    *pending_suggestion().lock() = Some(PendingSuggestion { value });
}

fn take_pending_suggestion() -> Option<PendingSuggestion> {
    pending_suggestion().lock().take()
}

fn clear_pending_suggestion_value(value: &str) {
    let mut pending = pending_suggestion().lock();
    if pending
        .as_ref()
        .is_some_and(|suggestion| suggestion.value == value)
    {
        *pending = None;
    }
}

fn ignored_suggestions() -> &'static Mutex<HashSet<String>> {
    IGNORED_SUGGESTIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn hydrate_ignored_suggestions(values: &[String]) {
    let mut ignored = ignored_suggestions().lock();
    ignored.clear();
    for value in sanitize_ignored_suggestions(values) {
        ignored.insert(suggestion_key(&value));
    }
}

fn remember_ignored_suggestion(value: &str) {
    ignored_suggestions().lock().insert(suggestion_key(value));
}

fn clear_ignored_suggestion(value: &str) {
    ignored_suggestions().lock().remove(&suggestion_key(value));
}

fn is_ignored_suggestion(value: &str) -> bool {
    ignored_suggestions()
        .lock()
        .contains(&suggestion_key(value))
}

fn sanitize_ignored_suggestions(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();

    for value in values {
        let Some(value) = canonicalize_candidate(value) else {
            continue;
        };
        if seen.insert(suggestion_key(&value)) {
            cleaned.push(value);
        }
        if cleaned.len() >= MAX_IGNORED_SUGGESTIONS {
            break;
        }
    }

    cleaned
}

fn suggestion_key(value: &str) -> String {
    value.trim().to_lowercase()
}

fn detect_candidate(
    pre_value: &str,
    inserted_text: &str,
    current_value: &str,
    dictionary_entries: &[String],
) -> Option<String> {
    let current_span = changed_current_span(pre_value, current_value)?;
    if current_span == inserted_text {
        return None;
    }
    if current_span.chars().count() > inserted_text.chars().count() + 80 {
        return None;
    }

    let old_tokens = tokenize(inserted_text);
    let new_tokens = tokenize(current_span);
    if old_tokens.is_empty() || new_tokens.is_empty() {
        return None;
    }

    let mut prefix = 0;
    while prefix < old_tokens.len()
        && prefix < new_tokens.len()
        && old_tokens[prefix].text == new_tokens[prefix].text
    {
        prefix += 1;
    }

    let mut suffix = 0;
    while suffix + prefix < old_tokens.len()
        && suffix + prefix < new_tokens.len()
        && old_tokens[old_tokens.len() - 1 - suffix].text
            == new_tokens[new_tokens.len() - 1 - suffix].text
    {
        suffix += 1;
    }

    let old_changed = &old_tokens[prefix..old_tokens.len().saturating_sub(suffix)];
    let new_changed = &new_tokens[prefix..new_tokens.len().saturating_sub(suffix)];
    if old_changed.is_empty() || new_changed.is_empty() {
        return None;
    }
    if old_changed.len() > MAX_CHANGED_TOKENS || new_changed.len() > MAX_CHANGED_TOKENS {
        return None;
    }

    let start = new_changed.first()?.start;
    let end = new_changed.last()?.end;
    let candidate = current_span.get(start..end)?.trim();
    let candidate = canonicalize_candidate(candidate)?;
    let candidate_tokens = tokenize(&candidate);
    if !is_valid_candidate(&candidate, &candidate_tokens, dictionary_entries) {
        return None;
    }

    Some(candidate)
}

fn changed_current_span<'a>(pre_value: &str, current_value: &'a str) -> Option<&'a str> {
    if pre_value == current_value {
        return None;
    }

    let prefix_len = common_prefix_len(pre_value, current_value);
    let suffix_len = common_suffix_len(&pre_value[prefix_len..], &current_value[prefix_len..]);
    let end = current_value.len().checked_sub(suffix_len)?;
    current_value.get(prefix_len..end)
}

fn common_prefix_len(a: &str, b: &str) -> usize {
    let mut len = 0;
    for ((a_idx, a_ch), (b_idx, b_ch)) in a.char_indices().zip(b.char_indices()) {
        if a_ch != b_ch {
            break;
        }
        len = a_idx + a_ch.len_utf8();
        debug_assert_eq!(len, b_idx + b_ch.len_utf8());
    }
    len
}

fn common_suffix_len(a: &str, b: &str) -> usize {
    let mut len = 0;
    for (a_ch, b_ch) in a.chars().rev().zip(b.chars().rev()) {
        if a_ch != b_ch {
            break;
        }
        len += a_ch.len_utf8();
    }
    len
}

fn tokenize(value: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut start: Option<usize> = None;

    for (idx, ch) in value.char_indices() {
        if is_token_char(ch) {
            start.get_or_insert(idx);
            continue;
        }

        if let Some(token_start) = start.take() {
            push_token(value, token_start, idx, &mut tokens);
        }
    }

    if let Some(token_start) = start {
        push_token(value, token_start, value.len(), &mut tokens);
    }

    tokens
}

fn push_token(value: &str, start: usize, end: usize, tokens: &mut Vec<Token>) {
    let raw = &value[start..end];
    let trimmed = raw.trim_matches(|ch: char| is_trimmed_token_edge(ch));
    if trimmed.is_empty() {
        return;
    }

    let offset_start = raw.find(trimmed).unwrap_or(0);
    tokens.push(Token {
        text: trimmed.to_string(),
        start: start + offset_start,
        end: start + offset_start + trimmed.len(),
    });
}

fn is_token_char(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '\'' | '’' | '-' | '.' | '+' | '#' | '_' | '&')
}

fn is_trimmed_token_edge(ch: char) -> bool {
    ch == '.'
}

fn canonicalize_candidate(candidate: &str) -> Option<String> {
    let mut value = candidate
        .trim()
        .trim_matches(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '"' | '“'
                        | '”'
                        | '‘'
                        | '’'
                        | '.'
                        | ','
                        | ':'
                        | ';'
                        | '!'
                        | '?'
                        | '('
                        | ')'
                        | '['
                        | ']'
                )
        })
        .to_string();
    if value.is_empty() {
        return None;
    }

    let chars: Vec<char> = value.chars().collect();
    if chars.len() > 2
        && matches!(chars.get(chars.len() - 2), Some('\'' | '’'))
        && matches!(chars.last(), Some('s' | 'S'))
    {
        value = chars[..chars.len() - 2].iter().collect();
    } else if matches!(chars.last(), Some('\'' | '’')) && chars.len() > 3 {
        let without_apostrophe = value.trim_end_matches(['\'', '’']);
        if without_apostrophe.ends_with(['s', 'S']) {
            value = without_apostrophe.to_string();
        }
    }

    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn is_valid_candidate(candidate: &str, tokens: &[Token], dictionary_entries: &[String]) -> bool {
    let trimmed = candidate.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_CANDIDATE_LEN {
        return false;
    }
    if !trimmed.chars().all(is_allowed_candidate_char) {
        return false;
    }

    if dictionary_entries
        .iter()
        .any(|entry| entry.trim().eq_ignore_ascii_case(trimmed))
    {
        return false;
    }

    let token_texts: Vec<&str> = tokens.iter().map(|token| token.text.as_str()).collect();
    if token_texts.is_empty() {
        return false;
    }
    if token_texts
        .iter()
        .all(|token| is_common_word_or_stretched_common_word(token))
    {
        return false;
    }
    if is_all_caps_plain_phrase(&token_texts) {
        return false;
    }

    token_texts
        .iter()
        .enumerate()
        .all(|(idx, token)| is_name_like_token(token) || is_allowed_particle(idx, token))
}

fn is_allowed_candidate_char(ch: char) -> bool {
    ch.is_alphanumeric()
        || ch.is_whitespace()
        || matches!(ch, '\'' | '’' | '-' | '.' | '+' | '#' | '_' | '&')
}

fn is_name_like_token(token: &str) -> bool {
    if token.chars().count() < 2 && !is_symbolic_technical_token(token) {
        return false;
    }
    is_acronym(token)
        || is_title_like(token)
        || is_mixed_brand(token)
        || is_symbolic_technical_token(token)
}

fn is_acronym(token: &str) -> bool {
    let mut has_upper = false;
    let mut has_alpha = false;
    for ch in token.chars() {
        if ch.is_alphabetic() {
            has_alpha = true;
            if ch.is_uppercase() {
                has_upper = true;
            } else {
                return false;
            }
        } else if !ch.is_numeric() && !matches!(ch, '-' | '.' | '_' | '&') {
            return false;
        }
    }
    has_alpha && has_upper && token.chars().count() >= 2
}

fn is_title_like(token: &str) -> bool {
    let mut chars = token.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_uppercase() {
        return false;
    }
    chars.all(|ch| ch.is_alphanumeric() || matches!(ch, '\'' | '’' | '-' | '.' | '_' | '&'))
}

fn is_mixed_brand(token: &str) -> bool {
    let has_lower = token.chars().any(|ch| ch.is_lowercase());
    let has_upper = token.chars().any(|ch| ch.is_uppercase());
    has_lower && has_upper
}

fn is_symbolic_technical_token(token: &str) -> bool {
    let has_alpha = token.chars().any(|ch| ch.is_alphabetic());
    let has_symbol = token
        .chars()
        .any(|ch| matches!(ch, '+' | '#' | '.' | '_' | '&'));
    has_alpha && has_symbol
}

fn is_all_caps_plain_phrase(tokens: &[&str]) -> bool {
    if tokens.is_empty() {
        return false;
    }
    let mut alpha_token_count = 0;
    for token in tokens {
        if token
            .chars()
            .any(|ch| ch.is_numeric() || matches!(ch, '-' | '.' | '+' | '#' | '_' | '&'))
        {
            return false;
        }
        let alpha_chars: Vec<char> = token.chars().filter(|ch| ch.is_alphabetic()).collect();
        if alpha_chars.is_empty() {
            return false;
        }
        if !alpha_chars.iter().all(|ch| ch.is_uppercase()) {
            return false;
        }
        alpha_token_count += 1;
    }

    alpha_token_count > 1 || tokens.iter().any(|token| token.chars().count() > 6)
}

fn is_allowed_particle(index: usize, token: &str) -> bool {
    index > 0
        && matches!(
            token.to_lowercase().as_str(),
            "al" | "bin" | "da" | "de" | "del" | "der" | "di" | "du" | "la" | "le" | "van" | "von"
        )
}

fn is_common_word_or_stretched_common_word(value: &str) -> bool {
    let normalized = value.to_lowercase();
    is_common_word(&normalized) || is_common_word(&collapse_repeated_chars(&normalized))
}

fn collapse_repeated_chars(value: &str) -> String {
    let mut collapsed = String::new();
    let mut previous = None;

    for ch in value.chars() {
        if Some(ch) == previous {
            continue;
        }
        collapsed.push(ch);
        previous = Some(ch);
    }

    collapsed
}

fn is_common_word(value: &str) -> bool {
    matches!(
        value,
        "a" | "about"
            | "after"
            | "again"
            | "all"
            | "also"
            | "an"
            | "and"
            | "any"
            | "are"
            | "as"
            | "at"
            | "back"
            | "be"
            | "because"
            | "been"
            | "but"
            | "by"
            | "can"
            | "could"
            | "did"
            | "do"
            | "does"
            | "done"
            | "for"
            | "from"
            | "get"
            | "go"
            | "guys"
            | "had"
            | "has"
            | "have"
            | "he"
            | "hello"
            | "her"
            | "here"
            | "hey"
            | "him"
            | "his"
            | "how"
            | "i"
            | "if"
            | "important"
            | "in"
            | "is"
            | "it"
            | "its"
            | "it's"
            | "just"
            | "know"
            | "lets"
            | "let's"
            | "like"
            | "make"
            | "me"
            | "my"
            | "no"
            | "not"
            | "now"
            | "of"
            | "okay"
            | "on"
            | "or"
            | "our"
            | "please"
            | "she"
            | "so"
            | "that"
            | "the"
            | "their"
            | "then"
            | "there"
            | "they"
            | "this"
            | "today"
            | "tomorrow"
            | "to"
            | "uh"
            | "um"
            | "urgent"
            | "was"
            | "we"
            | "were"
            | "what"
            | "when"
            | "with"
            | "would"
            | "yeah"
            | "yes"
            | "you"
            | "your"
    )
}

#[cfg(test)]
mod tests {
    use super::detect_candidate;

    fn detect(inserted: &str, current: &str) -> Option<String> {
        detect_candidate("", inserted, current, &[])
    }

    #[test]
    fn suggests_corrected_capitalized_last_name() {
        assert_eq!(
            detect("I met Mackenzie today.", "I met McKenzie today.").as_deref(),
            Some("McKenzie")
        );
    }

    #[test]
    fn suggests_corrected_name_phrase() {
        assert_eq!(
            detect("I met john smith today.", "I met John Smith today.").as_deref(),
            Some("John Smith")
        );
    }

    #[test]
    fn suggests_corrected_brand_casing() {
        assert_eq!(
            detect("Open fig jam now.", "Open FigJam now.").as_deref(),
            Some("FigJam")
        );
    }

    #[test]
    fn suggests_hyphenated_product_names() {
        assert_eq!(
            detect(
                "Use glimpse speech for this.",
                "Use Glimpse-Speech for this."
            )
            .as_deref(),
            Some("Glimpse-Speech")
        );
    }

    #[test]
    fn suggests_symbolic_technical_terms() {
        assert_eq!(
            detect("Open node js docs.", "Open Node.js docs.").as_deref(),
            Some("Node.js")
        );
        assert_eq!(
            detect("Use c plus plus.", "Use C++."),
            Some("C++".to_string())
        );
    }

    #[test]
    fn suggests_acronyms_with_digits() {
        assert_eq!(
            detect("Ship gpt 5 today.", "Ship GPT-5 today.").as_deref(),
            Some("GPT-5")
        );
    }

    #[test]
    fn strips_straight_possessive_suffix() {
        assert_eq!(
            detect("I saw Mike today.", "I saw Mike's today.").as_deref(),
            Some("Mike")
        );
    }

    #[test]
    fn strips_curly_possessive_suffix() {
        assert_eq!(
            detect("I saw Mike today.", "I saw Mike’s today.").as_deref(),
            Some("Mike")
        );
    }

    #[test]
    fn keeps_internal_apostrophe_names() {
        assert_eq!(
            detect("I met Oneill today.", "I met O'Neill today.").as_deref(),
            Some("O'Neill")
        );
    }

    #[test]
    fn strips_trailing_apostrophe_possessive_for_s_names() {
        assert_eq!(
            detect("I saw James today.", "I saw James' today.").as_deref(),
            Some("James")
        );
    }

    #[test]
    fn supports_accented_names() {
        assert_eq!(
            detect("I met Jose today.", "I met José today.").as_deref(),
            Some("José")
        );
    }

    #[test]
    fn supports_unicode_last_names() {
        assert_eq!(
            detect("I called Muller today.", "I called Müller today.").as_deref(),
            Some("Müller")
        );
    }

    #[test]
    fn allows_name_particles_inside_phrases() {
        assert_eq!(
            detect("Read van gogh today.", "Read Van Gogh today.").as_deref(),
            Some("Van Gogh")
        );
    }

    #[test]
    fn rejects_lowercase_common_word() {
        assert_eq!(detect("Their ready.", "There ready."), None);
    }

    #[test]
    fn rejects_punctuation_only_edit() {
        assert_eq!(detect("I met Mackenzie.", "I met Mackenzie!"), None);
    }

    #[test]
    fn rejects_sentence_rewrite() {
        assert_eq!(
            detect(
                "I met Mackenzie today.",
                "I am hungry and want to leave now."
            ),
            None
        );
    }

    #[test]
    fn rejects_title_cased_common_phrase_rewrite() {
        assert_eq!(
            detect(
                "guys let's get this done it's important",
                "Guys This Is Important"
            ),
            None
        );
    }

    #[test]
    fn rejects_all_caps_common_phrase_rewrite() {
        assert_eq!(
            detect(
                "Guys, let's get this done, it's important.",
                "Guys, THIS IS IMPORTANTTTT. Let's get it done."
            ),
            None
        );
    }

    #[test]
    fn rejects_single_all_caps_common_words() {
        assert_eq!(detect("This is urgent.", "This is URGENT."), None);
        assert_eq!(
            detect("This is nasa.", "This is NASA.").as_deref(),
            Some("NASA")
        );
    }

    #[test]
    fn rejects_edit_outside_inserted_span() {
        assert_eq!(
            detect_candidate(
                "Prefix suffix",
                "Mackenzie",
                "Changed Prefix Mackenzie suffix",
                &[]
            ),
            None
        );
    }

    #[test]
    fn rejects_duplicate_dictionary_entry() {
        assert_eq!(
            detect_candidate(
                "",
                "I met Mackenzie.",
                "I met McKenzie.",
                &["mckenzie".into()]
            ),
            None
        );
    }

    #[test]
    fn treats_resized_text_field_as_same_target() {
        assert!(super::frames_match(
            Some((100.0, 200.0, 420.0, 36.0)),
            Some((100.5, 200.5, 420.0, 72.0)),
        ));
    }

    #[test]
    fn rejects_moved_text_field_target() {
        assert!(!super::frames_match(
            Some((100.0, 200.0, 420.0, 36.0)),
            Some((180.0, 200.0, 420.0, 36.0)),
        ));
    }

    #[test]
    fn dictionary_add_clears_session_ignore() {
        let suggestion = "SessionOnlyNoNo";

        super::remember_ignored_suggestion(suggestion);
        assert!(super::is_ignored_suggestion(suggestion));

        super::sync_ignored_dictionary_entries(&[suggestion.to_string()]);
        assert!(!super::is_ignored_suggestion(suggestion));
    }
}
