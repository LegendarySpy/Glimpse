//! `glimpse transcribe …` - applies the user's model/language/dictionary/
//! replacements/cleanup. With no Glimpse-specific flag it delegates to the
//! glimpse-speech CLI; otherwise it reuses the running app's warm model.

use std::path::PathBuf;

use anyhow::{Result, bail};
use serde_json::{Value, json};

use super::{client, coded, has_flag, output, positionals, str_flag, wants_help};

/// Flags that switch on Glimpse-flavored behavior; otherwise we delegate to
/// glimpse-speech so existing `glimpse transcribe` usage is unchanged.
const GLIMPSE_FLAGS: &[&str] = &[
    "--output",
    "--output-dir",
    "--stdout",
    "--json",
    "--language",
    "--model",
    "--cleanup",
    "--no-cleanup",
    "--suffix",
];

const VALUE_FLAGS: &[&str] = &[
    "--output",
    "--output-dir",
    "--language",
    "--model",
    "--suffix",
];

fn help() {
    super::print_command_help(
        "Transcribe a file to text. With no options, delegates to the speech engine.",
        "glimpse transcribe <file>... [options]",
        &[(
            "OPTIONS",
            &[
                ("--output <path>", "Write the transcript to this file."),
                (
                    "--output-dir <dir>",
                    "Write one file per input into this directory.",
                ),
                (
                    "--suffix <ext>",
                    "Output extension when inferring paths (default .txt).",
                ),
                (
                    "--stdout",
                    "Print the transcript instead of writing a file.",
                ),
                ("--language <code>", "Override the language."),
                ("--model <id>", "Override the speech model."),
                ("--cleanup", "Force LLM cleanup."),
                ("--no-cleanup", "Skip LLM cleanup."),
                ("--json", "Output machine-readable JSON."),
            ],
        )],
    );
}

pub(crate) fn run(_identifier: &str, args: &[String], json: bool) -> Result<()> {
    if wants_help(args) {
        help();
        return Ok(());
    }

    let glimpse_mode = args.iter().any(|arg| GLIMPSE_FLAGS.contains(&arg.as_str()));
    if !glimpse_mode {
        // No Glimpse-specific behavior requested: hand off to glimpse-speech.
        return glimpse_speech::cli::run_blocking();
    }

    let files: Vec<String> = positionals(args, VALUE_FLAGS)
        .into_iter()
        .cloned()
        .collect();
    if files.is_empty() {
        bail!("transcribe expects at least one audio file");
    }

    let output = str_flag(args, "--output")?;
    let output_dir = str_flag(args, "--output-dir")?;
    let suffix = str_flag(args, "--suffix")?.unwrap_or(".txt");
    let to_stdout = has_flag(args, "--stdout");
    let language = str_flag(args, "--language")?;
    let model = str_flag(args, "--model")?;
    let cleanup = if has_flag(args, "--no-cleanup") {
        Some(false)
    } else if has_flag(args, "--cleanup") {
        Some(true)
    } else {
        None
    };

    if files.len() > 1 && output.is_some() {
        bail!("--output works with a single file; use --output-dir for multiple inputs");
    }

    let mut entries = Vec::new();
    for file in &files {
        let absolute =
            std::fs::canonicalize(file).map_err(|_| coded(1, format!("File not found: {file}")))?;
        let mut payload = json!({ "path": absolute.to_string_lossy() });
        if let Some(language) = language {
            payload["language"] = json!(language);
        }
        if let Some(model) = model {
            payload["model"] = json!(model);
        }
        if let Some(cleanup) = cleanup {
            payload["cleanup"] = json!(cleanup);
        }

        let data = match client::try_request_data("transcribe", payload, "transcription failed")? {
            Some(data) => data,
            None => {
                return Err(coded(
                    2,
                    "Glimpse must be running to use transcribe options. Open Glimpse, or run \
                     `glimpse transcribe <file>` with no Glimpse flags for raw output.",
                ));
            }
        };

        let text = data
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let out_path = output_path(file, output, output_dir, suffix, to_stdout);
        if let Some(path) = &out_path {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, &text)?;
        }
        entries.push(Entry {
            input: file.clone(),
            output: out_path,
            text,
            data,
        });
    }

    emit(&entries, json, to_stdout);
    Ok(())
}

struct Entry {
    input: String,
    output: Option<PathBuf>,
    text: String,
    data: Value,
}

/// Resolve where a transcript should be written. `None` means print to stdout.
fn output_path(
    input: &str,
    output: Option<&str>,
    output_dir: Option<&str>,
    suffix: &str,
    to_stdout: bool,
) -> Option<PathBuf> {
    if to_stdout {
        return None;
    }
    if let Some(output) = output {
        return Some(PathBuf::from(output));
    }
    let input_path = PathBuf::from(input);
    let stem = input_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "transcript".to_string());
    let ext = suffix.trim_start_matches('.');
    let file_name = format!("{stem}.{ext}");
    match output_dir {
        Some(dir) => Some(PathBuf::from(dir).join(file_name)),
        // Default: sibling file next to the input.
        None => Some(input_path.with_file_name(file_name)),
    }
}

fn emit(entries: &[Entry], json: bool, to_stdout: bool) {
    if json {
        let files: Vec<Value> = entries
            .iter()
            .map(|entry| {
                json!({
                    "input": entry.input,
                    "output": entry.output.as_ref().map(|p| p.to_string_lossy()),
                    "text": entry.text,
                    "word_count": entry.text.split_whitespace().count(),
                    "speech_model": entry.data.get("speech_model"),
                    "llm_cleaned": entry.data.get("llm_cleaned").and_then(Value::as_bool).unwrap_or(false),
                    "duration_seconds": entry.data.get("duration_seconds"),
                })
            })
            .collect();
        output::print_json(&json!({ "ok": true, "files": files }));
    } else {
        for entry in entries {
            match (&entry.output, to_stdout) {
                (Some(path), _) => println!("{}", path.display()),
                (None, _) => println!("{}", entry.text),
            }
        }
    }
}
