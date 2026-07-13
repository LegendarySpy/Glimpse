//! `glimpse status` - report app/runtime state. Never launches the app.

use anyhow::Result;
use serde_json::{Value, json};

use super::{client, coded, output, wants_help};

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
    match client::try_request("status", json!({}))? {
        Some(response) if response.ok => {
            if json {
                let mut value = response.data;
                if let Some(object) = value.as_object_mut() {
                    object.insert("ok".to_string(), Value::Bool(true));
                }
                output::print_json(&value);
            } else {
                print_plain(&response.data);
            }
        }
        Some(response) => {
            return Err(coded(
                3,
                response
                    .error
                    .unwrap_or_else(|| "status failed".to_string()),
            ));
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
