//! CLI integration layer: plain domain verbs for external tools (Raycast,
//! Shortcuts, Finder, scripts). Reads run headless against the local DBs;
//! mutations and transcription are routed to the running app over a control
//! socket ([`ipc`]/[`client`]/[`server`], answered in [`handlers`]).

mod api;
mod client;
mod dictionary;
mod handlers;
mod history;
mod ipc;
mod library;
mod model;
mod open;
mod output;
mod replacements;
mod server;
mod status;
mod transcribe;

pub(crate) use server::start as start_control_server;

use anyhow::{Result, bail};

struct CliCommand {
    name: &'static str,
    help: &'static str,
    /// `true`: handled by this layer. `false`: handled by glimpse-speech.
    owned: bool,
}

const COMMANDS: &[CliCommand] = &[
    CliCommand {
        name: "transcribe",
        help: "Transcribe a file to text.",
        owned: true,
    },
    CliCommand {
        name: "library",
        help: "Import and transcribe files in the background.",
        owned: true,
    },
    CliCommand {
        name: "history",
        help: "Read dictation history.",
        owned: true,
    },
    CliCommand {
        name: "dictionary",
        help: "Manage custom dictionary words.",
        owned: true,
    },
    CliCommand {
        name: "replacements",
        help: "Manage text replacements.",
        owned: true,
    },
    CliCommand {
        name: "model",
        help: "Choose the active speech model.",
        owned: true,
    },
    CliCommand {
        name: "models",
        help: "Install or remove speech models.",
        owned: false,
    },
    CliCommand {
        name: "status",
        help: "Show whether Glimpse is running.",
        owned: true,
    },
    CliCommand {
        name: "open",
        help: "Open the Glimpse app.",
        owned: true,
    },
    CliCommand {
        name: "api",
        help: "Start, stop, or check the local API server.",
        owned: true,
    },
    CliCommand {
        name: "serve",
        help: "Run a standalone transcription server.",
        owned: false,
    },
];

pub fn is_integration_command(verb: &str) -> bool {
    COMMANDS.iter().any(|c| c.name == verb && c.owned)
}

pub(crate) type HelpSection<'a> = (&'a str, &'a [(&'a str, &'a str)]);

pub(crate) fn print_command_help(overview: &str, usage: &str, sections: &[HelpSection]) {
    let width = sections
        .iter()
        .flat_map(|(_, rows)| rows.iter())
        .map(|(label, _)| label.len())
        .max()
        .unwrap_or(0);
    println!("OVERVIEW: {overview}\n");
    println!("USAGE: {usage}");
    for (title, rows) in sections {
        println!("\n{title}:");
        for (label, desc) in rows.iter() {
            println!("  {label:<width$}  {desc}");
        }
    }
}

/// Renders the whole CLI's `--help`, so commands from both this layer and
/// glimpse-speech appear in one list instead of two.
pub fn print_help() {
    let subcommands: Vec<(&str, &str)> = COMMANDS.iter().map(|c| (c.name, c.help)).collect();
    print_command_help(
        "Local dictation and transcription from the terminal.",
        "glimpse <command> [options]",
        &[
            (
                "OPTIONS",
                &[
                    ("--cache-dir <path>", "Override the model cache directory."),
                    ("--json", "Output machine-readable JSON."),
                    ("-h, --help", "Show help information."),
                ],
            ),
            ("SUBCOMMANDS", subcommands.as_slice()),
        ],
    );
    println!("\n  See 'glimpse <command> --help' for command details.");
}

/// Front door for every integration command. `args` includes the leading verb.
/// Owns process exit: maps errors to the documented exit codes and prints
/// machine-readable errors in `--json` mode.
pub fn dispatch(identifier: &str, args: &[String]) -> Result<()> {
    ipc::init_socket_label(identifier);
    let json = args.iter().any(|arg| arg == "--json");
    match run(identifier, args, json) {
        Ok(()) => Ok(()),
        Err(err) => {
            let code = err
                .downcast_ref::<CodedError>()
                .map(|coded| coded.code)
                .unwrap_or(1);
            if json {
                output::print_error_json(&err.to_string());
            } else {
                eprintln!("{err}");
            }
            std::process::exit(code);
        }
    }
}

fn run(identifier: &str, args: &[String], json: bool) -> Result<()> {
    let (verb, rest) = args
        .split_first()
        .expect("dispatch is only called with a leading verb");
    match verb.as_str() {
        "history" => history::run(identifier, rest, json),
        "dictionary" => dictionary::run(identifier, rest, json),
        "replacements" => replacements::run(identifier, rest, json),
        "model" => model::run(identifier, rest, json),
        "library" => library::run(identifier, rest, json),
        "open" => open::run(rest, json),
        "status" => status::run(rest, json),
        "api" => api::run(rest, json),
        "transcribe" => transcribe::run(identifier, rest, json),
        other => bail!("Unknown command: {other}"),
    }
}

/// Error carrying a specific process exit code (see the integration spec).
/// 1 = user error, 2 = app unavailable, 3 = job failed, 4 = cancelled/timeout.
#[derive(Debug)]
pub(crate) struct CodedError {
    pub code: i32,
    pub message: String,
}

impl std::fmt::Display for CodedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CodedError {}

pub(crate) fn coded(code: i32, message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(CodedError {
        code,
        message: message.into(),
    })
}

/// Open the transcriptions/library SQLite database headless (no running app).
pub(crate) fn open_storage(identifier: &str) -> Result<crate::storage::StorageManager> {
    let path = crate::settings::cli_data_dir(identifier)?.join("transcriptions.db");
    if !path.exists() {
        bail!("No Glimpse database found. Run Glimpse at least once first.");
    }
    crate::storage::StorageManager::new(path)
}

/// Returns true if the args request help for a subcommand.
pub(crate) fn wants_help(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "-h" || arg == "--help")
}

/// A token that looks like a flag (e.g. `--json`, `-x`) rather than a value.
fn looks_like_flag(value: &str) -> bool {
    value.starts_with("--") || (value.starts_with('-') && value.len() > 1)
}

/// The value following `flag`, or an error if it's missing or another flag.
fn flag_value<'a>(args: &'a [String], flag: &str) -> Result<Option<&'a str>> {
    let Some(idx) = args.iter().position(|arg| arg == flag) else {
        return Ok(None);
    };
    let value = args
        .get(idx + 1)
        .ok_or_else(|| anyhow::anyhow!("{flag} requires a value"))?;
    if looks_like_flag(value) {
        bail!("{flag} requires a value");
    }
    Ok(Some(value.as_str()))
}

/// Parse a `--flag <value>` integer option. Returns the default if absent.
pub(crate) fn usize_flag(args: &[String], flag: &str, default: usize) -> Result<usize> {
    match flag_value(args, flag)? {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| anyhow::anyhow!("{flag} must be a non-negative integer")),
        None => Ok(default),
    }
}

/// Parse a `--flag <value>` string option. Errors if the value is missing or is
/// itself another flag; returns None only when the flag is absent.
pub(crate) fn str_flag<'a>(args: &'a [String], flag: &str) -> Result<Option<&'a str>> {
    flag_value(args, flag)
}

pub(crate) fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

/// Collect positional args (everything that isn't a flag or a flag's value).
pub(crate) fn positionals<'a>(args: &'a [String], value_flags: &[&str]) -> Vec<&'a String> {
    let mut out = Vec::new();
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if value_flags.contains(&arg.as_str()) {
            skip_next = true;
            continue;
        }
        if arg.starts_with("--") || (arg.starts_with('-') && arg.len() > 1) {
            continue;
        }
        out.push(arg);
    }
    out
}
