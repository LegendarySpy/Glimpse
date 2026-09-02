use std::path::Path;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Row, ToSql, params};

use crate::library::{LibraryFilter, LibraryItem, LibraryItemPatch, LibraryItemStatus};

const LIBRARY_COLUMNS: &str = "id, name, audio_path, source_path, store_original, status, progress, \
    error_message, transcript, segments, words, duration_seconds, file_size_bytes, original_format, \
    created_at, transcribed_at, tags, llm_cleanup_enabled, speech_model, show_timestamps, \
    detect_speakers, kind, speakers";

pub(crate) fn insert_library_item(conn: &Connection, item: LibraryItem) -> Result<LibraryItem> {
    let (status, progress, error_message) = item.status.as_fields();
    let segments = serialize_json_column(&item.segments)?;
    let words = serialize_json_column(&item.words)?;
    let tags = serialize_tags(&item.tags)?;
    let speakers = serialize_json_column(&item.speakers)?;

    conn.execute(
        "INSERT INTO library_items (
            id,
            name,
            audio_path,
            source_path,
            store_original,
            status,
            progress,
            error_message,
            transcript,
            segments,
            words,
            duration_seconds,
            file_size_bytes,
            original_format,
            created_at,
            transcribed_at,
            tags,
            llm_cleanup_enabled,
            speech_model,
            show_timestamps,
            detect_speakers,
            kind,
            speakers
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
        params![
            item.id,
            item.name,
            item.audio_path,
            item.source_path,
            if item.store_original { 1 } else { 0 },
            status,
            progress,
            error_message,
            item.transcript,
            segments,
            words,
            item.duration_seconds,
            item.file_size_bytes as i64,
            item.original_format,
            item.created_at,
            item.transcribed_at,
            tags,
            if item.llm_cleanup_enabled { 1 } else { 0 },
            item.speech_model,
            if item.show_timestamps { 1 } else { 0 },
            if item.detect_speakers { 1 } else { 0 },
            item.kind,
            speakers,
        ],
    )?;

    Ok(item)
}

pub(crate) fn get_library_items_page(
    conn: &Connection,
    root: &Path,
    filter: LibraryFilter,
    limit: usize,
    offset: usize,
) -> Result<(Vec<LibraryItem>, bool)> {
    let (where_clause, mut params) = build_library_filter(&filter);
    let sql = format!(
        "SELECT {LIBRARY_COLUMNS}
         FROM library_items
         {}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?",
        where_clause
    );

    let fetch_limit = limit.saturating_add(1) as i64;
    params.push(Box::new(fetch_limit));
    params.push(Box::new(offset as i64));

    let mut stmt = conn.prepare(&sql)?;
    let mut items = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            library_item_from_row(root, row)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let has_more = items.len() > limit;
    if has_more {
        items.truncate(limit);
    }

    Ok((items, has_more))
}

pub(crate) fn get_recoverable_library_items(
    conn: &Connection,
    root: &Path,
) -> Result<Vec<LibraryItem>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {LIBRARY_COLUMNS}
         FROM library_items
         WHERE status IN ('pending', 'importing', 'transcribing', 'cancelling')
         ORDER BY created_at ASC"
    ))?;

    let items = stmt
        .query_map([], |row| library_item_from_row(root, row))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(items)
}

pub(crate) fn update_library_item(
    conn: &mut Connection,
    root: &Path,
    id: &str,
    patch: LibraryItemPatch,
) -> Result<Option<LibraryItem>> {
    let tx = conn.transaction()?;
    let mut item = match get_library_item(&tx, root, id)? {
        Some(item) => item,
        None => return Ok(None),
    };

    if let Some(name) = patch.name {
        item.name = name;
    }
    if let Some(transcript) = patch.transcript {
        item.transcript = Some(transcript);
    }
    if let Some(segments) = patch.segments {
        item.segments = Some(segments);
    }
    if let Some(words) = patch.words {
        item.words = Some(words);
    }
    if let Some(tags) = patch.tags {
        item.tags = tags;
    }
    if let Some(status) = patch.status {
        item.status = status;
    }
    if let Some(enabled) = patch.llm_cleanup_enabled {
        item.llm_cleanup_enabled = enabled;
    }
    if let Some(model) = patch.speech_model {
        item.speech_model = model;
    }
    if let Some(transcribed_at) = patch.transcribed_at {
        item.transcribed_at = Some(transcribed_at);
    }
    if let Some(show_timestamps) = patch.show_timestamps {
        item.show_timestamps = show_timestamps;
    }
    if let Some(detect_speakers) = patch.detect_speakers {
        item.detect_speakers = detect_speakers;
    }
    if let Some(duration_seconds) = patch.duration_seconds {
        item.duration_seconds = duration_seconds;
    }
    if let Some(kind) = patch.kind {
        item.kind = kind;
    }
    if let Some(speakers) = patch.speakers {
        item.speakers = speakers;
    }

    update_library_item_full(&tx, &item)?;
    tx.commit()?;
    Ok(Some(item))
}

pub(crate) fn delete_library_item(
    conn: &Connection,
    root: &Path,
    id: &str,
) -> Result<Option<String>> {
    let item = get_library_item(conn, root, id)?;
    if item.is_some() {
        conn.execute("DELETE FROM library_items WHERE id = ?1", params![id])?;
    }
    Ok(item.map(|value| value.audio_path))
}

pub(crate) fn get_library_tags(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tags FROM library_items")?;
    let mut rows = stmt.query([])?;
    let mut set = std::collections::BTreeSet::new();
    while let Some(row) = rows.next()? {
        let tags_json: String = row.get(0)?;
        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
        for tag in tags {
            let trimmed = tag.trim();
            if !trimmed.is_empty() {
                set.insert(trimmed.to_string());
            }
        }
    }
    Ok(set.into_iter().collect())
}

pub(crate) fn get_library_item(
    conn: &Connection,
    root: &Path,
    id: &str,
) -> Result<Option<LibraryItem>> {
    conn.query_row(
        &format!("SELECT {LIBRARY_COLUMNS} FROM library_items WHERE id = ?1"),
        params![id],
        |row| library_item_from_row(root, row),
    )
    .optional()
    .map_err(Into::into)
}

fn update_library_item_full(conn: &Connection, item: &LibraryItem) -> Result<()> {
    let (status, progress, error_message) = item.status.as_fields();
    let segments = serialize_json_column(&item.segments)?;
    let words = serialize_json_column(&item.words)?;
    let tags = serialize_tags(&item.tags)?;
    let speakers = serialize_json_column(&item.speakers)?;

    conn.execute(
        "UPDATE library_items SET
            name = ?1,
            audio_path = ?2,
            source_path = ?3,
            store_original = ?4,
            status = ?5,
            progress = ?6,
            error_message = ?7,
            transcript = ?8,
            segments = ?9,
            words = ?10,
            duration_seconds = ?11,
            file_size_bytes = ?12,
            original_format = ?13,
            created_at = ?14,
            transcribed_at = ?15,
            tags = ?16,
            llm_cleanup_enabled = ?17,
            speech_model = ?18,
            show_timestamps = ?19,
            kind = ?20,
            speakers = ?21,
            detect_speakers = ?22
         WHERE id = ?23",
        params![
            item.name,
            item.audio_path,
            item.source_path,
            if item.store_original { 1 } else { 0 },
            status,
            progress,
            error_message,
            item.transcript,
            segments,
            words,
            item.duration_seconds,
            item.file_size_bytes as i64,
            item.original_format,
            item.created_at,
            item.transcribed_at,
            tags,
            if item.llm_cleanup_enabled { 1 } else { 0 },
            item.speech_model,
            if item.show_timestamps { 1 } else { 0 },
            item.kind,
            speakers,
            if item.detect_speakers { 1 } else { 0 },
            item.id,
        ],
    )?;
    Ok(())
}

// Re-root a stored audio path onto the current library location when the
// original no longer exists (e.g. the app data directory moved).
fn resolve_audio_path(root: &Path, stored: String) -> String {
    let path = Path::new(&stored);
    if path.exists() {
        return stored;
    }
    if let (Some(folder), Some(file)) = (path.parent().and_then(Path::file_name), path.file_name())
    {
        let rebased = root.join(folder).join(file);
        if rebased.exists() {
            return rebased.display().to_string();
        }
    }
    stored
}

fn library_item_from_row(root: &Path, row: &Row<'_>) -> rusqlite::Result<LibraryItem> {
    let status_value: String = row.get("status")?;
    let progress: f32 = row.get::<_, f64>("progress").unwrap_or(0.0) as f32;
    let error_message: Option<String> = row.get("error_message")?;
    let segments_json: Option<String> = row.get("segments")?;
    let words_json: Option<String> = row.get("words").ok();
    let tags_json: String = row.get("tags")?;
    let speakers_json: Option<String> = row.get("speakers").ok().flatten();

    let segments = parse_json_column(segments_json);
    let words = parse_json_column(words_json);
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    let speakers = parse_json_column(speakers_json);

    Ok(LibraryItem {
        id: row.get("id")?,
        name: row.get("name")?,
        audio_path: resolve_audio_path(root, row.get("audio_path")?),
        source_path: row.get("source_path")?,
        store_original: row.get::<_, i64>("store_original")? == 1,
        status: LibraryItemStatus::from_fields(&status_value, progress, error_message),
        transcript: row.get("transcript")?,
        segments,
        words,
        duration_seconds: row.get::<_, f64>("duration_seconds")? as f32,
        file_size_bytes: row.get::<_, i64>("file_size_bytes")? as u64,
        original_format: row.get("original_format")?,
        created_at: row.get("created_at")?,
        transcribed_at: row.get("transcribed_at")?,
        tags,
        llm_cleanup_enabled: row.get::<_, i64>("llm_cleanup_enabled")? == 1,
        speech_model: row.get("speech_model")?,
        show_timestamps: row.get::<_, i64>("show_timestamps")? == 1,
        detect_speakers: row
            .get::<_, i64>("detect_speakers")
            .map(|value| value == 1)
            .unwrap_or(false),
        kind: row
            .get::<_, Option<String>>("kind")
            .ok()
            .flatten()
            .unwrap_or_else(crate::library::default_item_kind),
        speakers,
    })
}

fn serialize_json_column<T: serde::Serialize>(value: &Option<Vec<T>>) -> Result<Option<String>> {
    match value {
        Some(value) => Ok(Some(serde_json::to_string(value)?)),
        None => Ok(None),
    }
}

fn parse_json_column<T: serde::de::DeserializeOwned>(value: Option<String>) -> Option<Vec<T>> {
    value
        .filter(|raw| !raw.trim().is_empty())
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn serialize_tags(tags: &[String]) -> Result<String> {
    Ok(serde_json::to_string(tags)?)
}

fn extract_search_terms(search: &str) -> (String, Vec<String>) {
    let mut tag_terms = Vec::new();
    let mut text_terms = Vec::new();

    for token in search.split_whitespace() {
        if let Some(tag) = token.strip_prefix('#') {
            let trimmed = tag.trim();
            if !trimmed.is_empty() {
                tag_terms.push(trimmed.to_string());
            }
            continue;
        }

        text_terms.push(token);
    }

    (text_terms.join(" ").trim().to_string(), tag_terms)
}

fn build_library_filter(filter: &LibraryFilter) -> (String, Vec<Box<dyn ToSql>>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(search) = filter.search.as_ref()
        && !search.trim().is_empty()
    {
        let (text_search, tag_terms) = extract_search_terms(search.trim());

        if !text_search.is_empty() {
            let like = format!("%{}%", text_search);
            clauses.push("(name LIKE ? OR transcript LIKE ?)".to_string());
            params.push(Box::new(like.clone()));
            params.push(Box::new(like));
        }

        for tag in tag_terms {
            clauses.push("tags LIKE ?".to_string());
            params.push(Box::new(format!("%\"{}\"%", tag)));
        }
    }

    if let Some(status) = filter.status.as_ref() {
        let trimmed = status.trim();
        if !trimmed.is_empty() {
            if trimmed == "active" {
                clauses.push("status IN ('pending', 'importing', 'transcribing')".to_string());
            } else {
                clauses.push("status = ?".to_string());
                params.push(Box::new(trimmed.to_string()));
            }
        }
    }

    if let Some(tag) = filter.tag.as_ref()
        && !tag.trim().is_empty()
    {
        clauses.push("tags LIKE ?".to_string());
        params.push(Box::new(format!("%\"{}\"%", tag.trim())));
    }

    if let Some(days) = filter.since_days {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
        clauses.push("created_at >= ?".to_string());
        params.push(Box::new(cutoff.to_rfc3339()));
    }

    if clauses.is_empty() {
        ("".to_string(), params)
    } else {
        (format!("WHERE {}", clauses.join(" AND ")), params)
    }
}
