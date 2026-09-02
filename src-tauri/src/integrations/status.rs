//! `glimpse status` - report app/runtime state. Never launches the app.

use anyhow::Result;
use serde_json::{Value, json};

use super::{client, output, wants_help};

fn help() {
    super::print_command_help(
        "Show whether Glimpse is running.",
        "glimpse status [options]",
        &[("OPTIONS", &[("--json", "Output machine-readable JSON.")])],
    );
}

pub(crate) fn run(args: &[String], json: bool) -> Result<()> {
    if wants_help(args) {
        help();
        return Ok(());
    }
    match client::try_request_data("status", json!({}), "status failed")? {
        Some(data) => {
            if json {
                output::print_json_ok(data);
            } else {
                print_plain(&data);
            }
        }
        None => {
            if json {
                output::print_json(&json!({ "ok": true, "app_running": false }));
            } else {
                println!("app_running:   false");
            }
        }
    }
    Ok(())
}

fn print_plain(data: &Value) {
    let pill = data
        .get("pill")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let active = data
        .get("active_model")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let api_running = data
        .get("local_api")
        .and_then(|api| api.get("running"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    println!("app_running:   true");
    println!("pill:          {pill}");
    println!("active_model:  {active}");
    println!(
        "local_api:     {}",
        if api_running { "running" } else { "stopped" }
    );
}
