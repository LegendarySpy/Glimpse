//! `glimpse history …` - read-only dictation history. Headless, no app needed.

use anyhow::{Result, bail};
use serde::Serialize;
use serde_json::json;

use super::{open_storage, output, positionals, usize_flag, wants_help};
use crate::storage::{TranscriptionRecord, TranscriptionStatus};

fn help() {
    super::print_command_help(
        "Read dictation history. Runs without the app.",
        "glimpse history <subcommand> [options]",
        &[
            (
                "SUBCOMMANDS",
                &[
                    ("last", "Show the most recent dictation."),
                    ("list", "List recent dictations."),
                    ("search <query>", "Search dictation text."),
                    ("get <id>", "Show a single dictation."),
                    ("stats", "Show lifetime totals."),
                ],
            ),
            (
                "OPTIONS",
                &[
                    ("--limit <n>", "Maximum results (list, search)."),
                    ("--offset <n>", "Skip results (list)."),
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
        "last" => last(identifier, json),
        "list" => list(identifier, rest, json),
        "search" => search(identifier, rest, json),
        "get" => get(identifier, rest, json),
        "stats" => stats(identifier, json),
        other => bail!("Unknown history subcommand: {other}. Run 'glimpse history --help'."),
    }
}

fn last(identifier: &str, json: bool) -> Result<()> {
    let storage = open_storage(identifier)?;
    let record = storage.get_recent_transcriptions(1)?.into_iter().next();
    if json {
        output::print_json(&json!({
            "ok": true,
            "record": record.as_ref().map(HistoryRecord::from),
        }));
    } else if let Some(record) = record {
        println!("{}", record.text);
    }
    Ok(())
}

fn list(identifier: &str, args: &[String], json: bool) -> Result<()> {
    let limit = usize_flag(args, "--limit", 20)?;
    let offset = usize_flag(args, "--offset", 0)?;
    let storage = open_storage(identifier)?;
    let records = storage.get_recent_transcriptions_page(limit, offset)?;
    emit_records(&records, json);
    Ok(())
}

fn search(identifier: &str, args: &[String], json: bool) -> Result<()> {
    let limit = usize_flag(args, "--limit", 20)?;
    let query = positionals(args, &["--limit"])
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    if query.trim().is_empty() {
        bail!("history search requires a query");
    }
    let storage = open_storage(identifier)?;
    let records = storage.search_transcriptions(query.trim(), limit)?;
    emit_records(&records, json);
    Ok(())
}

fn get(identifier: &str, args: &[String], json: bool) -> Result<()> {
    let id = positionals(args, &[])
        .first()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow::anyhow!("history get requires an id"))?;
    let storage = open_storage(identifier)?;
    let record = storage
        .get_by_id(&id)
        .ok_or_else(|| anyhow::anyhow!("No dictation found with id {id}"))?;
    if json {
        output::print_json(&json!({ "ok": true, "record": HistoryRecord::from(&record) }));
    } else {
        println!("{}", record.text);
    }
    Ok(())
}

fn stats(identifier: &str, json: bool) -> Result<()> {
    let storage = open_storage(identifier)?;
    let stats = storage.lifetime_stats()?;
    let duration_seconds = stats.duration_ms as f64 / 1000.0;
    if json {
        output::print_json(&json!({
            "ok": true,
            "words": stats.words,
            "duration_seconds": duration_seconds,
            "dictations": stats.dictations,
        }));
    } else {
        println!("Words:      {}", stats.words);
        println!("Duration:   {duration_seconds:.0}s");
        println!("Dictations: {}", stats.dictations);
    }
    Ok(())
}

fn emit_records(records: &[TranscriptionRecord], json: bool) {
    if json {
        let mapped: Vec<HistoryRecord> = records.iter().map(HistoryRecord::from).collect();
        output::print_json(&json!({
            "ok": true,
            "count": mapped.len(),
            "records": mapped,
        }));
    } else {
        for record in records {
            println!(
                "{}\t{}\t{}",
                record.id,
                record.timestamp.to_rfc3339(),
                output::one_line(&record.text, 100)
            );
        }
    }
}

#[derive(Serialize)]
struct HistoryRecord {
    id: String,
    timestamp_ms: i64,
    text: String,
    raw_text: Option<String>,
    llm_cleaned: bool,
    speech_model: String,
    llm_model: Option<String>,
    mode_name: Option<String>,
    word_count: u32,
    audio_duration_seconds: f32,
    audio_path: String,
    audio_available: bool,
    status: &'static str,
}

impl From<&TranscriptionRecord> for HistoryRecord {
    fn from(record: &TranscriptionRecord) -> Self {
        Self {
            id: record.id.clone(),
            timestamp_ms: record.timestamp.timestamp_millis(),
            text: record.text.clone(),
            raw_text: record.raw_text.clone(),
            llm_cleaned: record.llm_cleaned,
            speech_model: record.speech_model.clone(),
            llm_model: record.llm_model.clone(),
            mode_name: record.mode_name.clone(),
            word_count: record.word_count,
            audio_duration_seconds: record.audio_duration_seconds,
            audio_path: record.audio_path.clone(),
            audio_available: record.audio_available,
            status: match record.status {
                TranscriptionStatus::Success => "success",
                TranscriptionStatus::Error => "error",
            },
        }
    }
}
