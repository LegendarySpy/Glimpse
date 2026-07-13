//! `glimpse library …` - import (via the app) and read-only status/list/export.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use serde_json::{Value, json};

use super::{
    client, coded, has_flag, open_storage, output, positionals, str_flag, usize_flag, wants_help,
};
use crate::library::{
    ExportFormat, LibraryFilter, LibraryItem, LibraryItemStatus, build_export_content,
};

const WAIT_TIMEOUT: Duration = Duration::from_secs(3600);
const WAIT_POLL: Duration = Duration::from_secs(1);

fn help() {
    super::print_command_help(
        "Import and transcribe audio and video files.",
        "glimpse library <subcommand> [options]",
        &[
            (
                "SUBCOMMANDS",
                &[
                    ("import <file>...", "Import and transcribe files."),
                    ("status <id>...", "Show import status."),
                    ("list", "List library items."),
                    ("export <id>", "Export a transcript to a file."),
                ],
            ),
            (
                "OPTIONS",
                &[
                    (
                        "--store-original",
                        "Keep a copy of the source file (import).",
                    ),
                    ("--model <id>", "Speech model to use (import)."),
                    ("--open", "Open the library when done (import)."),
                    ("--wait", "Wait for transcription to finish (import)."),
                    (
                        "--to <format>",
                        "Export format: txt, md, srt, vtt (export).",
                    ),
                    ("--output <path>", "Export destination (export)."),
                    ("--limit <n>", "Maximum results (list)."),
                    ("--status <state>", "Filter by status (list)."),
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
        "import" => import(identifier, rest, json),
        "status" => status(identifier, rest, json),
        "list" => list(identifier, rest, json),
        "export" => export(identifier, rest, json),
        other => bail!("Unknown library subcommand: {other}. Run 'glimpse library --help'."),
    }
}

fn import(identifier: &str, args: &[String], json: bool) -> Result<()> {
    let files: Vec<String> = positionals(args, &["--model"])
        .into_iter()
        .cloned()
        .collect();
    if files.is_empty() {
        bail!("library import expects at least one file");
    }
    let store_original = has_flag(args, "--store-original");
    let model = str_flag(args, "--model")?;
    let open_after = has_flag(args, "--open");
    let wait = has_flag(args, "--wait");

    let mut jobs = Vec::new();
    for file in &files {
        let absolute =
            std::fs::canonicalize(file).map_err(|_| coded(1, format!("File not found: {file}")))?;
        let mut payload = json!({
            "path": absolute.to_string_lossy(),
            "store_original": store_original,
        });
        if let Some(model) = model {
            payload["model"] = json!(model);
        }
        let data = client::request_data("library.import", payload)?;
        jobs.push(data);
    }

    if open_after {
        let _ = client::request_data("open", json!({ "target": "library" }));
    }

    if wait {
        let storage = open_storage(identifier)?;
        for job in &mut jobs {
            if let Some(id) = job.get("id").and_then(Value::as_str) {
                let final_item = wait_for_completion(&storage, id)?;
                let (status, _, _) = final_item.status.as_fields();
                job["status"] = json!(status);
            }
        }
    }

    if json {
        output::print_json(&json!({ "ok": true, "jobs": jobs }));
    } else {
        for job in &jobs {
            let id = job.get("id").and_then(Value::as_str).unwrap_or("");
            let name = job.get("name").and_then(Value::as_str).unwrap_or("");
            let status = job
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending");
            println!("{id}\t{status}\t{name}");
        }
    }
    Ok(())
}

fn wait_for_completion(storage: &crate::storage::StorageManager, id: &str) -> Result<LibraryItem> {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        let item = storage
            .get_library_item(id)?
            .ok_or_else(|| coded(3, format!("Library item {id} disappeared")))?;
        if matches!(
            item.status,
            LibraryItemStatus::Complete
                | LibraryItemStatus::Error { .. }
                | LibraryItemStatus::Cancelled
        ) {
            return Ok(item);
        }
        if Instant::now() >= deadline {
            return Err(coded(4, format!("Timed out waiting for library item {id}")));
        }
        std::thread::sleep(WAIT_POLL);
    }
}

fn status(identifier: &str, args: &[String], json: bool) -> Result<()> {
    let ids: Vec<String> = positionals(args, &[]).into_iter().cloned().collect();
    if ids.is_empty() {
        bail!("library status expects at least one id");
    }
    let storage = open_storage(identifier)?;
    let mut items = Vec::new();
    for id in &ids {
        let item = storage
            .get_library_item(id)?
            .ok_or_else(|| coded(1, format!("No library item with id {id}")))?;
        items.push(item);
    }
    if json {
        let mapped: Vec<Value> = items.iter().map(item_summary).collect();
        output::print_json(&json!({ "ok": true, "items": mapped }));
    } else {
        for item in &items {
            let (status, progress, _) = item.status.as_fields();
            println!(
                "{}\t{}\t{:.0}%\t{}",
                item.id,
                status,
                progress * 100.0,
                item.name
            );
        }
    }
    Ok(())
}

fn list(identifier: &str, args: &[String], json: bool) -> Result<()> {
    let limit = usize_flag(args, "--limit", 20)?;
    let filter = LibraryFilter {
        status: str_flag(args, "--status")?.map(str::to_string),
        ..Default::default()
    };
    let storage = open_storage(identifier)?;
    let (items, _has_more) = storage.get_library_items_page(filter, limit, 0)?;
    if json {
        let mapped: Vec<Value> = items.iter().map(item_summary).collect();
        output::print_json(&json!({ "ok": true, "count": mapped.len(), "items": mapped }));
    } else {
        for item in &items {
            let (status, _, _) = item.status.as_fields();
            println!("{}\t{}\t{}", item.id, status, item.name);
        }
    }
    Ok(())
}

fn export(identifier: &str, args: &[String], json: bool) -> Result<()> {
    let id = positionals(args, &["--to", "--output"])
        .first()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow::anyhow!("library export expects an id"))?;
    let format = parse_format(str_flag(args, "--to")?.unwrap_or("txt"))?;
    let output_path = str_flag(args, "--output")?
        .ok_or_else(|| anyhow::anyhow!("--output <path> is required"))?;

    let storage = open_storage(identifier)?;
    let item = storage
        .get_library_item(&id)?
        .ok_or_else(|| coded(1, format!("No library item with id {id}")))?;
    let content = build_export_content(&item, format).map_err(|err| coded(3, err.to_string()))?;

    let path = PathBuf::from(output_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content)?;

    if json {
        output::print_json(&json!({ "ok": true, "output": path.to_string_lossy() }));
    } else {
        println!("{}", path.display());
    }
    Ok(())
}

fn parse_format(value: &str) -> Result<ExportFormat> {
    match value.to_lowercase().as_str() {
        "txt" => Ok(ExportFormat::Txt),
        "md" => Ok(ExportFormat::Md),
        "srt" => Ok(ExportFormat::Srt),
        "vtt" => Ok(ExportFormat::Vtt),
        other => bail!("Unknown export format: {other} (expected txt|md|srt|vtt)"),
    }
}

fn item_summary(item: &LibraryItem) -> Value {
    let (status, progress, error) = item.status.as_fields();
    json!({
        "id": item.id,
        "name": item.name,
        "status": status,
        "progress": progress,
        "error": error,
        "transcript": item.transcript,
        "duration_seconds": item.duration_seconds,
        "speech_model": item.speech_model,
        "created_at": item.created_at,
        "transcribed_at": item.transcribed_at,
    })
}
