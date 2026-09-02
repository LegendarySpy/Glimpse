//! `glimpse open …` - bring up the app and navigate. Always needs the app.

use anyhow::Result;
use serde_json::json;

use super::{client, output, positionals, str_flag, wants_help};

fn help() {
    super::print_command_help(
        "Open the Glimpse app.",
        "glimpse open [target] [options]",
        &[
            (
                "ARGUMENTS",
                &[
                    ("settings", "Open the main window (default)."),
                    ("home", "Open the home view (history is an alias)."),
                    ("dictionary", "Open the dictionary view."),
                    ("personalization", "Open the personalization view."),
                    ("library", "Open the library view."),
                    ("models", "Open the models view."),
                ],
            ),
            (
                "OPTIONS",
                &[
                    ("--tab <name>", "Settings tab: models, about, account."),
                    ("--json", "Output machine-readable JSON."),
                ],
            ),
        ],
    );
}

pub(crate) fn run(args: &[String], json: bool) -> Result<()> {
    if wants_help(args) {
        help();
        return Ok(());
    }

    let mut payload = json!({});
    if let Some(target) = positionals(args, &["--tab"]).first() {
        payload["target"] = json!(target);
    }
    if let Some(tab) = str_flag(args, "--tab")? {
        payload["tab"] = json!(tab);
    }

    let data = client::request_data("open", payload)?;
    if json {
        output::print_json(&json!({ "ok": true, "opened": data.get("opened") }));
    }
    Ok(())
}
