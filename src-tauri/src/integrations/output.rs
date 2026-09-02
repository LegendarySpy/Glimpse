//! Shared output helpers: compact JSON on stdout, JSON errors on stderr.

use serde::Serialize;
use serde_json::{Value, json};

pub(crate) fn print_json<T: Serialize>(value: &T) {
    match serde_json::to_string(value) {
        Ok(text) => println!("{text}"),
        Err(err) => eprintln!("Failed to serialize result: {err}"),
    }
}

/// Prints `value` with `"ok": true` merged in, matching the daemon's success shape.
pub(crate) fn print_json_ok(mut value: Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert("ok".to_string(), Value::Bool(true));
    }
    print_json(&value);
}

pub(crate) fn print_error_json(message: &str) {
    let payload = json!({ "ok": false, "error": message });
    eprintln!("{payload}");
}

/// Collapse a transcript to a single trimmed line for table-style plain output.
pub(crate) fn one_line(text: &str, max: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > max {
        let truncated: String = collapsed.chars().take(max.saturating_sub(1)).collect();
        format!("{truncated}…")
    } else {
        collapsed
    }
}
