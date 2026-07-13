//! `glimpse replacements …`. Only `list` is headless; `add`/`remove` mutate
//! live app state and are routed to the running app (not yet implemented).

use anyhow::{Result, bail};
use serde_json::json;

use super::{client, output, str_flag, wants_help};
use crate::settings::SettingsStore;

fn help() {
    super::print_command_help(
        "Manage text replacements.",
        "glimpse replacements <subcommand> [options]",
        &[
            (
                "SUBCOMMANDS",
                &[
                    ("list", "List replacements."),
                    ("add --from <a> --to <b>", "Add or update a replacement."),
                    ("remove --from <a>", "Remove a replacement."),
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
        "add" => add(rest, json),
        "remove" => remove(rest, json),
        other => {
            bail!("Unknown replacements subcommand: {other}. Run 'glimpse replacements --help'.")
        }
    }
}

fn add(args: &[String], json: bool) -> Result<()> {
    let from = str_flag(args, "--from")?.ok_or_else(|| anyhow::anyhow!("--from is required"))?;
    let to = str_flag(args, "--to")?.ok_or_else(|| anyhow::anyhow!("--to is required"))?;
    let data = client::request_data("replacements.add", json!({ "from": from, "to": to }))?;
    report(&data, json);
    Ok(())
}

fn remove(args: &[String], json: bool) -> Result<()> {
    let from = str_flag(args, "--from")?.ok_or_else(|| anyhow::anyhow!("--from is required"))?;
    let data = client::request_data("replacements.remove", json!({ "from": from }))?;
    report(&data, json);
    Ok(())
}

fn report(data: &serde_json::Value, json: bool) {
    if json {
        output::print_json(&json!({ "ok": true, "replacements": data.get("replacements") }));
    } else if let Some(items) = data.get("replacements").and_then(|v| v.as_array()) {
        for item in items {
            let from = item.get("from").and_then(|v| v.as_str()).unwrap_or("");
            let to = item.get("to").and_then(|v| v.as_str()).unwrap_or("");
            println!("{from} -> {to}");
        }
    }
}

fn list(identifier: &str, json: bool) -> Result<()> {
    let store = SettingsStore::for_cli(identifier)?;
    let replacements = store.load()?.replacements;
    if json {
        output::print_json(&json!({ "ok": true, "replacements": replacements }));
    } else {
        for replacement in replacements {
            println!("{} -> {}", replacement.from, replacement.to);
        }
    }
    Ok(())
}
