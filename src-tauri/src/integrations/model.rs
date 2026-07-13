//! `glimpse model …`. `list` is headless; `set` mutates live app state and is
//! routed to the running app (not yet implemented).

use anyhow::{Result, bail};
use serde::Serialize;
use serde_json::json;

use super::{client, output, positionals, wants_help};
use crate::settings::{self, SettingsStore, UserSettings};
use crate::speech::catalog;

fn help() {
    super::print_command_help(
        "Choose the active speech model.",
        "glimpse model <subcommand> [options]",
        &[
            (
                "SUBCOMMANDS",
                &[
                    ("list", "List speech models. The active one is marked."),
                    (
                        "set <model-id>",
                        "Switch to a local model. Requires the app.",
                    ),
                    ("set remote", "Enable remote speech."),
                ],
            ),
            (
                "OPTIONS",
                &[
                    ("--installed-only", "List only installed models (list)."),
                    ("--json", "Output machine-readable JSON."),
                ],
            ),
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
        "list" => list(identifier, rest, json),
        "set" => set(rest, json),
        other => bail!("Unknown model subcommand: {other}. Run 'glimpse model --help'."),
    }
}

fn set(args: &[String], json: bool) -> Result<()> {
    let target = positionals(args, &[])
        .first()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow::anyhow!("expected a model id or `remote`"))?;
    let payload = if target == "remote" {
        serde_json::json!({ "target": "remote" })
    } else {
        serde_json::json!({ "target": "local", "model": target })
    };
    let data = client::request_data("model.set", payload)?;
    if json {
        output::print_json(&serde_json::json!({ "ok": true, "active": data.get("active") }));
    } else if let Some(active) = data.get("active").and_then(|v| v.as_str()) {
        println!("Active model: {active}");
    }
    Ok(())
}

fn list(identifier: &str, args: &[String], json: bool) -> Result<()> {
    let settings = SettingsStore::for_cli(identifier)?.load()?;
    let models_dir = settings::cli_data_dir(identifier)?.join("models");
    let installed_only = args.iter().any(|arg| arg == "--installed-only");

    let entries: Vec<ModelEntry> = catalog::list_models_at(&models_dir, &settings)
        .into_iter()
        .filter(|model| !installed_only || model.installed || model.remote)
        .map(|model| {
            let active = is_active(&model, &settings);
            ModelEntry {
                id: model.id,
                key: model.key,
                label: model.label,
                remote: model.remote,
                installed: model.installed,
                active,
            }
        })
        .collect();

    if json {
        let active = entries
            .iter()
            .find(|entry| entry.active)
            .map(|e| e.key.clone());
        output::print_json(&json!({
            "ok": true,
            "active": active,
            "models": entries,
        }));
    } else {
        for entry in entries {
            let marker = if entry.active { "*" } else { " " };
            let kind = if entry.remote {
                "remote"
            } else if entry.installed {
                "installed"
            } else {
                "available"
            };
            println!("{marker} {:<28} {:<10} {}", entry.key, kind, entry.label);
        }
    }
    Ok(())
}

fn is_active(model: &crate::speech::catalog::SpeechModel, settings: &UserSettings) -> bool {
    if settings.remote_speech_enabled {
        model.remote
    } else {
        !model.remote && model.key == settings.local_model
    }
}

#[derive(Serialize)]
struct ModelEntry {
    id: String,
    key: String,
    label: String,
    remote: bool,
    installed: bool,
    active: bool,
}
