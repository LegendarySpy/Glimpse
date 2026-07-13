//! `glimpse dictionary …`. Only `list` is headless; `add`/`remove` mutate live
//! app state and are routed to the running app (not yet implemented).

use anyhow::{Result, bail};
use serde_json::json;

use super::{client, output, positionals, wants_help};
use crate::settings::SettingsStore;

fn help() {
    super::print_command_help(
        "Manage custom dictionary words.",
        "glimpse dictionary <subcommand> [options]",
        &[
            (
                "SUBCOMMANDS",
                &[
                    ("list", "List custom words."),
                    (
                        "add <word>...",
                        "Add words. Requires the app; launches it if needed.",
                    ),
                    ("remove <word>...", "Remove words."),
                ],
            ),
            ("OPTIONS", &[("--json", "Output machine-readable JSON.")]),
        ],
    );
}

pub(crate) fn run(identifier: &str, args: &[String], json: bool) -> Result<()> {
    if args.is_empty() || wants_help(args) {
        help();
        return Ok(());
    }
    let (sub, rest) = args.split_first().expect("non-empty checked above");
    match sub.as_str() {
        "list" => list(identifier, json),
        "add" => mutate("dictionary.add", rest, json),
        "remove" => mutate("dictionary.remove", rest, json),
        other => bail!("Unknown dictionary subcommand: {other}. Run 'glimpse dictionary --help'."),
    }
}

fn mutate(command: &str, args: &[String], json: bool) -> Result<()> {
    let words: Vec<String> = positionals(args, &[]).into_iter().cloned().collect();
    if words.is_empty() {
        bail!("expected at least one word");
    }
    let data = client::request_data(command, json!({ "words": words }))?;
    let saved = data
        .get("words")
        .and_then(|value| value.as_array())
        .map(|words| {
            words
                .iter()
                .filter_map(|w| w.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if json {
        output::print_json(&json!({ "ok": true, "words": saved }));
    } else {
        for word in saved {
            println!("{word}");
        }
    }
    Ok(())
}

fn list(identifier: &str, json: bool) -> Result<()> {
    let store = SettingsStore::for_cli(identifier)?;
    let words = store.load()?.dictionary;
    if json {
        output::print_json(&json!({ "ok": true, "words": words }));
    } else {
        for word in words {
            println!("{word}");
        }
    }
    Ok(())
}
