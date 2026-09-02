//! `glimpse api start|stop|status` - control the local OpenAI-compatible API.

use anyhow::{Result, bail};
use serde_json::{Map, Value, json};

use super::{client, has_flag, output, str_flag, wants_help};

fn help() {
    super::print_command_help(
        "Control the local API server.",
        "glimpse api <subcommand> [options]",
        &[
            (
                "SUBCOMMANDS",
                &[
                    ("status", "Report whether the server is running."),
                    ("start", "Start the server. Requires the app."),
                    ("stop", "Stop the server."),
                ],
            ),
            (
                "OPTIONS",
                &[
                    ("--host <host>", "Bind host (start)."),
                    ("--port <port>", "Bind port (start)."),
                    ("--model <id>", "Speech model (start)."),
                    ("--api-key <key>", "Require this API key (start)."),
                    ("--cors", "Allow browser clients (start)."),
                    ("--no-cors", "Disallow browser clients (start)."),
                    ("--json", "Output machine-readable JSON."),
                ],
            ),
        ],
    );
}

pub(crate) fn run(args: &[String], json: bool) -> Result<()> {
    if args.is_empty() || wants_help(args) {
        help();
        return Ok(());
    }
    let (sub, rest) = args.split_first().expect("non-empty checked above");
    match sub.as_str() {
        "status" => status(json),
        "start" => emit(
            client::request_data("api.start", start_payload(rest)?)?,
            json,
        ),
        "stop" => emit(client::request_data("api.stop", json!({}))?, json),
        other => bail!("Unknown api subcommand: {other}. Run 'glimpse api --help'."),
    }
}

/// Collect the optional `api start` overrides into a payload. Absent flags are
/// omitted so the app falls back to the saved settings for each one.
fn start_payload(args: &[String]) -> Result<Value> {
    let mut payload = Map::new();
    if let Some(host) = str_flag(args, "--host")? {
        payload.insert("host".to_string(), json!(host));
    }
    if let Some(port) = str_flag(args, "--port")? {
        let port: u16 = port
            .parse()
            .map_err(|_| anyhow::anyhow!("--port must be a number between 0 and 65535"))?;
        payload.insert("port".to_string(), json!(port));
    }
    if let Some(model) = str_flag(args, "--model")? {
        payload.insert("model".to_string(), json!(model));
    }
    if let Some(key) = str_flag(args, "--api-key")? {
        payload.insert("api_key".to_string(), json!(key));
    }
    if has_flag(args, "--cors") {
        payload.insert("cors".to_string(), json!(true));
    } else if has_flag(args, "--no-cors") {
        payload.insert("cors".to_string(), json!(false));
    }
    Ok(Value::Object(payload))
}

fn status(json: bool) -> Result<()> {
    match client::try_request_data("api.status", json!({}), "api status failed")? {
        Some(data) => emit(data, json),
        None => {
            if json {
                output::print_json(&json!({ "ok": true, "running": false }));
            } else {
                println!("running: false (Glimpse is not running)");
            }
            Ok(())
        }
    }
}

fn emit(data: Value, json: bool) -> Result<()> {
    if json {
        output::print_json_ok(data);
    } else {
        let running = data
            .get("running")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let host = data.get("host").and_then(Value::as_str).unwrap_or("");
        let port = data.get("port").and_then(Value::as_u64).unwrap_or(0);
        if running {
            println!("running: true  ({host}:{port})");
        } else {
            println!("running: false");
        }
    }
    Ok(())
}
