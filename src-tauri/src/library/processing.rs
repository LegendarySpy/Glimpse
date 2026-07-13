use std::env;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, ErrorKind};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use symphonia::core::{
    codecs::audio::AudioDecoderOptions, errors::Error as SymphoniaError, formats::FormatOptions,
    formats::TrackType, formats::probe::Hint, io::MediaSourceStream, meta::MetadataOptions,
    units::Timestamp,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{AppRuntime, AppState, model_manager, storage::StorageManager};

use super::types::{
    EVENT_LIBRARY_IMPORT_PROGRESS, ExportFormat, LibraryImportOptions,
    LibraryImportProgressPayload, LibraryItem, LibraryItemPatch, LibraryItemStatus,
    SUPPORTED_AUDIO_FORMATS, SUPPORTED_VIDEO_FORMATS, Speaker, TARGET_SAMPLE_RATE,
    TranscriptSegment, cancelled_error, is_cancelled_error,
};

pub(crate) fn create_item_from_path(
    app: &AppHandle<AppRuntime>,
    storage: Arc<StorageManager>,
    source_path: &Path,
    options: &LibraryImportOptions,
) -> Result<LibraryItem> {
    let remote_selection = crate::remote_speech::is_remote_model(&options.model_key);
    if !remote_selection {
        let status = model_manager::check_model_status(app.clone(), options.model_key.clone())
            .map_err(|err| anyhow!(err))?;
        if !status.installed {
            return Err(anyhow!("Selected model is not installed"));
        }
    }
    if !source_path.exists() {
        return Err(anyhow!("File not found"));
    }
    let ext = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_supported_format(&ext) {
        return Err(anyhow!("Unsupported file format: {ext}"));
    }

    let file_name = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled");

    let id = Uuid::new_v4().to_string();
    let folder_name = build_folder_name(file_name, &id);
    let library_dir = library_root(app)?;
    let item_dir = library_dir.join(folder_name);
    let audio_path = item_dir.join(format!("{id}.wav"));
    let metadata = fs::metadata(source_path)?;

    let show_timestamps = if remote_selection {
        options.show_timestamps
    } else {
        options.show_timestamps && model_supports_timestamps(&options.model_key)
    };
    let detect_speakers = remote_selection && options.detect_speakers;

    let item = LibraryItem {
        id,
        name: file_name.to_string(),
        audio_path: audio_path.display().to_string(),
        source_path: source_path.display().to_string(),
        store_original: options.store_original,
        status: LibraryItemStatus::Pending,
        transcript: None,
        segments: None,
        words: None,
        duration_seconds: 0.0,
        file_size_bytes: metadata.len(),
        original_format: ext,
        created_at: Utc::now().to_rfc3339(),
        transcribed_at: None,
        tags: Vec::new(),
        llm_cleanup_enabled: false,
        speech_model: options.model_key.clone(),
        show_timestamps,
        detect_speakers,
        kind: crate::library::default_item_kind(),
        speakers: None,
    };

    storage.insert_library_item(item.clone())?;
    Ok(item)
}

pub(crate) fn convert_library_item(
    app: &AppHandle<AppRuntime>,
    state: &AppState,
    id: &str,
    source_path: &Path,
    store_original: bool,
    token: &CancellationToken,
) -> Result<()> {
    if token.is_cancelled() {
        return Err(cancelled_error());
    }
    let storage = state.storage();
    let item = storage
        .get_library_item(id)?
        .ok_or_else(|| anyhow!("Library item not found"))?;

    if !source_path.exists() {
        return Err(anyhow!("File not found"));
    }

    let ext = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_supported_format(&ext) {
        return Err(anyhow!("Unsupported file format: {ext}"));
    }

    let audio_path = PathBuf::from(&item.audio_path);
    let item_dir = audio_path
        .parent()
        .ok_or_else(|| anyhow!("Library folder not found"))?;

    fs::create_dir_all(item_dir)
        .with_context(|| format!("Failed to create library folder at {}", item_dir.display()))?;

    let result = (|| -> Result<f32> {
        report_import_progress(app, storage.clone(), id, 0.0);
        if token.is_cancelled() {
            return Err(cancelled_error());
        }

        if store_original {
            let original_target = item_dir.join(format!("source.{}", ext));
            let source_size = fs::metadata(source_path)
                .with_context(|| format!("Failed to read file size for {}", source_path.display()))?
                .len();
            let available = fs2::available_space(item_dir).with_context(|| {
                format!(
                    "Failed to read available disk space for {}",
                    item_dir.display()
                )
            })?;
            if available < source_size {
                return Err(anyhow!(
                    "Insufficient disk space to store original file (need {} bytes, have {} bytes)",
                    source_size,
                    available
                ));
            }
            fs::copy(source_path, &original_target).with_context(|| {
                format!(
                    "Failed to copy original file to {}",
                    original_target.display()
                )
            })?;
        }

        let duration_ms = probe_media_duration_ms(source_path);
        let mut last_progress = 0.0f32;
        let mut progress_cb = |progress: f32| {
            let clamped = progress.clamp(0.0, 1.0);
            if clamped >= 1.0 || (clamped - last_progress) >= 0.01 {
                report_import_progress(app, storage.clone(), id, clamped);
                last_progress = clamped;
            }
        };

        convert_to_wav(
            source_path,
            &audio_path,
            &ext,
            Some(token),
            duration_ms,
            Some(&mut progress_cb),
        )?;
        if token.is_cancelled() {
            return Err(cancelled_error());
        }
        let duration_seconds = wav_duration_seconds(&audio_path)?;
        Ok(duration_seconds)
    })();

    let duration_seconds = match result {
        Ok(duration_seconds) => duration_seconds,
        Err(err) => {
            let _ = fs::remove_dir_all(item_dir);
            return Err(err);
        }
    };
    let _ = storage.update_library_item(
        id,
        LibraryItemPatch {
            duration_seconds: Some(duration_seconds),
            ..Default::default()
        },
    );

    Ok(())
}

fn report_import_progress(
    app: &AppHandle<AppRuntime>,
    storage: Arc<StorageManager>,
    id: &str,
    progress: f32,
) {
    let progress = progress.clamp(0.0, 1.0);
    let _ = storage.update_library_item(
        id,
        LibraryItemPatch {
            status: Some(LibraryItemStatus::Importing { progress }),
            ..Default::default()
        },
    );
    let _ = app.emit(
        EVENT_LIBRARY_IMPORT_PROGRESS,
        LibraryImportProgressPayload {
            id: id.to_string(),
            progress,
        },
    );
}

fn is_supported_format(ext: &str) -> bool {
    SUPPORTED_AUDIO_FORMATS.contains(&ext) || SUPPORTED_VIDEO_FORMATS.contains(&ext)
}

fn model_supports_timestamps(model_key: &str) -> bool {
    model_manager::model_supports_capability(model_key, model_manager::MODEL_CAPABILITY_TIMESTAMPS)
}

fn build_folder_name(base: &str, id: &str) -> String {
    let sanitized = sanitize_folder_name(base);
    if sanitized.is_empty() {
        format!("library-item-{}", &id[..8])
    } else {
        format!("{}-{}", sanitized, &id[..8])
    }
}

fn sanitize_folder_name(value: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if (ch == ' ' || ch == '-' || ch == '_') && !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

pub(crate) fn library_root(app: &AppHandle<AppRuntime>) -> Result<PathBuf> {
    let mut dir = app
        .path()
        .app_data_dir()
        .context("App data directory not found")?;
    dir.push("library");
    Ok(dir)
}

pub(crate) fn stored_original_path(item: &LibraryItem) -> Option<PathBuf> {
    if !item.store_original {
        return None;
    }
    let ext = item.original_format.trim();
    if ext.is_empty() {
        return None;
    }
    let audio_path = PathBuf::from(&item.audio_path);
    let item_dir = audio_path.parent()?;
    Some(item_dir.join(format!("source.{ext}")))
}

pub(crate) struct WavInfo {
    pub sample_rate: u32,
    pub total_samples: usize,
    pub duration_seconds: f32,
}

pub(crate) fn read_wav_info(path: &Path) -> Result<WavInfo> {
    let file = fs::File::open(path)
        .with_context(|| format!("Failed to open WAV file at {}", path.display()))?;
    let reader = hound::WavReader::new(BufReader::new(file))
        .map_err(|err| anyhow!("WAV read error: {err}"))?;
    let spec = reader.spec();
    if spec.sample_rate == 0 {
        return Err(anyhow!("Invalid sample rate"));
    }
    let total_samples = reader.duration() as usize;
    let duration_seconds = total_samples as f32 / spec.sample_rate as f32;
    Ok(WavInfo {
        sample_rate: spec.sample_rate,
        total_samples,
        duration_seconds,
    })
}

pub(crate) fn compute_total_chunks(total_samples: usize, chunk_samples: usize, step: usize) -> u32 {
    if total_samples == 0 {
        return 0;
    }
    let mut count: u32 = 0;
    let mut start = 0usize;
    let step = step.max(1);
    let chunk_samples = chunk_samples.max(1);
    loop {
        count = count.saturating_add(1);
        if start.saturating_add(chunk_samples) >= total_samples {
            break;
        }
        start = start.saturating_add(step);
        if start >= total_samples {
            break;
        }
    }
    count
}

pub(crate) fn stream_wav_chunks<F>(
    path: &Path,
    chunk_samples: usize,
    overlap_samples: usize,
    mut on_chunk: F,
) -> Result<()>
where
    F: FnMut(usize, &[i16]) -> Result<()>,
{
    let file = fs::File::open(path)
        .with_context(|| format!("Failed to open WAV file at {}", path.display()))?;
    let mut reader = hound::WavReader::new(BufReader::new(file))
        .map_err(|err| anyhow!("WAV read error: {err}"))?;
    let spec = reader.spec();
    if spec.sample_format != hound::SampleFormat::Int {
        return Err(anyhow!("Unsupported WAV sample format"));
    }
    if spec.bits_per_sample != 16 {
        return Err(anyhow!(
            "Unsupported WAV bits per sample: {}",
            spec.bits_per_sample
        ));
    }
    if spec.sample_rate == 0 {
        return Err(anyhow!("Invalid sample rate"));
    }

    let channels = spec.channels.max(1) as usize;
    let chunk_samples = chunk_samples.max(1);
    let overlap_samples = overlap_samples.min(chunk_samples.saturating_sub(1));

    let mut raw_samples: Vec<i16> = Vec::with_capacity(chunk_samples.saturating_mul(channels));
    let mut mono_samples: Vec<i16> = Vec::with_capacity(chunk_samples);
    let mut carry: Vec<i16> = Vec::with_capacity(overlap_samples);
    let mut chunk: Vec<i16> = Vec::with_capacity(chunk_samples);
    let mut start_idx: usize = 0;
    let mut next_read = chunk_samples;
    let mut samples_iter = reader.samples::<i16>();

    loop {
        raw_samples.clear();
        let target = next_read.saturating_mul(channels);
        for _ in 0..target {
            match samples_iter.next() {
                Some(Ok(sample)) => raw_samples.push(sample),
                Some(Err(err)) => return Err(anyhow!("WAV read error: {err}")),
                None => break,
            }
        }
        let eof = raw_samples.len() < target;
        let frame_count = raw_samples.len() / channels;
        if frame_count == 0 {
            break;
        }

        if channels > 1 {
            downmix_interleaved_to_mono_i16(&raw_samples, channels, &mut mono_samples);
        } else {
            mono_samples.clear();
            mono_samples.extend_from_slice(&raw_samples);
        }

        chunk.clear();
        if !carry.is_empty() {
            chunk.extend_from_slice(&carry);
        }
        chunk.extend_from_slice(&mono_samples);
        if chunk.is_empty() {
            break;
        }
        let cut = if eof {
            chunk.len()
        } else {
            let min_cut = overlap_samples
                .saturating_add(chunk_samples.saturating_sub(overlap_samples).div_ceil(2))
                .min(chunk.len());
            crate::recorder::quiet_cut_index(&chunk, spec.sample_rate).max(min_cut)
        };
        on_chunk(start_idx, &chunk[..cut])?;

        if eof {
            break;
        }
        let keep_from = cut.saturating_sub(overlap_samples);
        carry.clear();
        carry.extend_from_slice(&chunk[keep_from..]);
        start_idx = start_idx.saturating_add(keep_from);
        next_read = chunk_samples.saturating_sub(carry.len()).max(1);
    }

    Ok(())
}

fn downmix_interleaved_to_mono_i16(samples: &[i16], channels: usize, output: &mut Vec<i16>) {
    output.clear();
    if samples.is_empty() {
        return;
    }
    if channels <= 1 {
        output.extend_from_slice(samples);
        return;
    }

    let frames = samples.len() / channels;
    output.reserve(frames);
    for frame in 0..frames {
        let mut acc = 0i32;
        for ch in 0..channels {
            acc += samples[frame * channels + ch] as i32;
        }
        output.push((acc / channels as i32) as i16);
    }
}

pub(crate) fn convert_to_wav(
    input: &Path,
    output: &Path,
    ext: &str,
    token: Option<&CancellationToken>,
    duration_ms: Option<u64>,
    progress_cb: Option<&mut dyn FnMut(f32)>,
) -> Result<()> {
    if SUPPORTED_AUDIO_FORMATS.contains(&ext) {
        return convert_audio_to_wav(input, output, token, duration_ms, progress_cb);
    }
    if SUPPORTED_VIDEO_FORMATS.contains(&ext) {
        return convert_video_to_wav(input, output, token, duration_ms, progress_cb);
    }
    Err(anyhow!("Unsupported file format: {ext}"))
}

fn convert_audio_to_wav(
    input: &Path,
    output: &Path,
    token: Option<&CancellationToken>,
    duration_ms: Option<u64>,
    mut progress_cb: Option<&mut dyn FnMut(f32)>,
) -> Result<()> {
    let is_wav = input
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("wav"))
        .unwrap_or(false);
    if is_wav && try_copy_wav_if_compatible(input, output)? {
        return Ok(());
    }

    let progress_ptr = progress_cb
        .as_mut()
        .map(|cb| &mut **cb as *mut dyn FnMut(f32));

    if let Some(ffmpeg) = find_ffmpeg_in_path() {
        let callback = progress_ptr.map(|ptr| unsafe { &mut *ptr });
        match convert_with_ffmpeg(&ffmpeg, input, output, token, duration_ms, callback) {
            Ok(()) => return Ok(()),
            Err(err) => {
                let _ = fs::remove_file(output);
                if is_cancelled_error(&err) {
                    return Err(err);
                }
            }
        }
    }

    let decode_result = {
        // SAFETY: progress_ptr (if present) points to the caller-provided callback,
        // which lives for the duration of this function and is only used sequentially.
        let callback = progress_ptr.map(|ptr| unsafe { &mut *ptr });
        decode_audio_to_wav(input, output, token, duration_ms, callback)
    };
    match decode_result {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(output);
            if is_cancelled_error(&err) {
                return Err(err);
            }
            Err(anyhow!(
                "Audio decode failed: {err}. Install ffmpeg to import this file."
            ))
        }
    }
}

fn try_copy_wav_if_compatible(input: &Path, output: &Path) -> Result<bool> {
    let file = fs::File::open(input)
        .with_context(|| format!("Failed to open WAV file at {}", input.display()))?;
    let reader = match hound::WavReader::new(file) {
        Ok(reader) => reader,
        Err(_) => return Ok(false),
    };
    let spec = reader.spec();
    if spec.sample_rate == TARGET_SAMPLE_RATE
        && spec.channels == 1
        && spec.bits_per_sample == 16
        && spec.sample_format == hound::SampleFormat::Int
    {
        drop(reader);
        fs::copy(input, output).with_context(|| {
            format!(
                "Failed to copy WAV file from {} to {}",
                input.display(),
                output.display()
            )
        })?;
        return Ok(true);
    }
    Ok(false)
}

fn decode_audio_to_wav(
    input: &Path,
    output: &Path,
    token: Option<&CancellationToken>,
    duration_ms: Option<u64>,
    mut progress_cb: Option<&mut dyn FnMut(f32)>,
) -> Result<()> {
    let file = fs::File::open(input)
        .with_context(|| format!("Failed to open audio file at {}", input.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = input.extension().and_then(|value| value.to_str()) {
        hint.with_extension(ext);
    }

    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|err| anyhow!("Failed to read audio container: {err}"))?;
    let track = format
        .default_track(TrackType::Audio)
        .or_else(|| {
            format.tracks().iter().find(|track| {
                track
                    .codec_params
                    .as_ref()
                    .and_then(|params| params.audio())
                    .is_some_and(|audio| audio.sample_rate.is_some() && audio.channels.is_some())
            })
        })
        .ok_or_else(|| anyhow!("No supported audio tracks found"))?;
    let audio_params = track
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .ok_or_else(|| anyhow!("Track is not an audio track"))?;
    let sample_rate = audio_params
        .sample_rate
        .ok_or_else(|| anyhow!("Unknown sample rate"))?;
    if sample_rate == 0 {
        return Err(anyhow!("Invalid sample rate"));
    }
    let channels = audio_params
        .channels
        .as_ref()
        .ok_or_else(|| anyhow!("Unknown channel count"))?
        .count();
    if channels == 0 {
        return Err(anyhow!("Unknown channel count"));
    }
    let time_base = track.time_base;
    let total_frames = track.num_frames;

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(audio_params, &AudioDecoderOptions::default())
        .map_err(|err| anyhow!("Unsupported audio codec: {err}"))?;
    let track_id = track.id;

    let output_file = fs::File::create(output)
        .with_context(|| format!("Failed to create WAV file at {}", output.display()))?;
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::new(BufWriter::new(output_file), spec)
        .map_err(|err| anyhow!("WAV writer init failed: {err}"))?;

    let mut resampler = if sample_rate == TARGET_SAMPLE_RATE {
        None
    } else {
        Some(LinearResampler::new(sample_rate, TARGET_SAMPLE_RATE))
    };

    let mut mono = Vec::new();
    let mut resampled = Vec::new();
    let mut interleaved: Vec<f32> = Vec::new();
    let mut wrote_any = false;
    let duration_ms_f64 = duration_ms.map(|ms| ms as f64);
    let mut last_reported = 0.0f32;

    loop {
        if let Some(token) = token
            && token.is_cancelled()
        {
            return Err(cancelled_error());
        }

        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(err) => return Err(anyhow!("Audio packet read failed: {err}")),
        };

        if packet.track_id != track_id {
            continue;
        }

        if let Some(cb) = progress_cb.as_mut() {
            let progress = if let Some(total) = total_frames {
                let packet_end = packet.pts.saturating_add(packet.dur).get();
                Some((packet_end as f64 / total as f64).min(1.0) as f32)
            } else if let (Some(total_ms), Some(time_base)) = (duration_ms_f64, time_base) {
                let packet_end = packet.pts.saturating_add(packet.dur);
                time_base.calc_time(packet_end).map(|time| {
                    let packet_ms = time.as_millis() as f64;
                    (packet_ms / total_ms).min(1.0) as f32
                })
            } else {
                None
            };

            if let Some(progress) = progress
                && (progress >= 1.0 || (progress - last_reported) >= 0.01)
            {
                cb(progress);
                last_reported = progress;
            }
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::IoError(err)) if err.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(err) => return Err(anyhow!("Audio decode failed: {err}")),
        };

        decoded.copy_to_vec_interleaved(&mut interleaved);
        downmix_interleaved_to_mono(&interleaved, channels, &mut mono);
        if mono.is_empty() {
            continue;
        }

        if let Some(resampler) = resampler.as_mut() {
            resampler.push(&mono, &mut resampled);
            if !resampled.is_empty() {
                write_wav_samples(&mut writer, &resampled)?;
                wrote_any = true;
            }
        } else {
            write_wav_samples(&mut writer, &mono)?;
            wrote_any = true;
        }
    }

    if let Some(resampler) = resampler.as_mut() {
        resampler.finish(&mut resampled);
        if !resampled.is_empty() {
            write_wav_samples(&mut writer, &resampled)?;
            wrote_any = true;
        }
    }

    writer
        .finalize()
        .map_err(|err| anyhow!("WAV finalize error: {err}"))?;

    if (total_frames.is_some() || (duration_ms.is_some() && time_base.is_some()))
        && let Some(cb) = progress_cb.as_mut()
    {
        cb(1.0);
    }

    if !wrote_any {
        return Err(anyhow!("No audio samples decoded"));
    }

    Ok(())
}

fn write_wav_samples(
    writer: &mut hound::WavWriter<BufWriter<fs::File>>,
    samples: &[f32],
) -> Result<()> {
    for &sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        writer
            .write_sample((clamped * i16::MAX as f32).round() as i16)
            .map_err(|err| anyhow!("WAV write error: {err}"))?;
    }
    Ok(())
}

fn downmix_interleaved_to_mono(samples: &[f32], channels: usize, output: &mut Vec<f32>) {
    output.clear();
    if samples.is_empty() {
        return;
    }
    if channels <= 1 {
        output.extend_from_slice(samples);
        return;
    }
    let frames = samples.len() / channels;
    output.reserve(frames);
    for frame in 0..frames {
        let mut acc = 0f32;
        for ch in 0..channels {
            acc += samples[frame * channels + ch];
        }
        output.push(acc / channels as f32);
    }
}

// Streaming resampler to avoid buffering entire files in memory.
struct LinearResampler {
    step: f64,
    pos: f64,
    buffer: Vec<f32>,
    start: usize,
}

impl LinearResampler {
    fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            step: in_rate as f64 / out_rate as f64,
            pos: 0.0,
            buffer: Vec::new(),
            start: 0,
        }
    }

    fn push(&mut self, input: &[f32], output: &mut Vec<f32>) {
        output.clear();
        if input.is_empty() {
            return;
        }
        self.buffer.extend_from_slice(input);
        self.drain(output, false);
    }

    fn finish(&mut self, output: &mut Vec<f32>) {
        output.clear();
        self.drain(output, true);
    }

    fn drain(&mut self, output: &mut Vec<f32>, flush: bool) {
        let available = self.buffer.len().saturating_sub(self.start);
        if available == 0 {
            return;
        }
        let available_f = available as f64;
        while self.pos + 1.0 < available_f || (flush && self.pos < available_f) {
            let idx_offset = self.pos.floor() as usize;
            if idx_offset >= available {
                break;
            }
            let idx = self.start + idx_offset;
            let frac = self.pos - idx_offset as f64;
            let a = self.buffer[idx] as f64;
            let b = if idx + 1 < self.buffer.len() {
                self.buffer[idx + 1] as f64
            } else {
                a
            };
            output.push((a + (b - a) * frac) as f32);
            self.pos += self.step;
        }

        let max_drop = if flush {
            available
        } else {
            available.saturating_sub(1)
        };
        let drop = (self.pos.floor() as usize).min(max_drop);
        if drop > 0 {
            self.start += drop;
            self.pos -= drop as f64;
            if self.start > 8192 {
                self.buffer.drain(0..self.start);
                self.start = 0;
            }
        }

        if flush {
            self.buffer.clear();
            self.start = 0;
            self.pos = 0.0;
        }
    }
}

fn convert_video_to_wav(
    input: &Path,
    output: &Path,
    token: Option<&CancellationToken>,
    duration_ms: Option<u64>,
    progress_cb: Option<&mut dyn FnMut(f32)>,
) -> Result<()> {
    let ffmpeg = find_ffmpeg_in_path().ok_or_else(|| {
        anyhow!("FFmpeg is required to import video files. Install ffmpeg and ensure it is on your PATH.")
    })?;
    convert_with_ffmpeg(&ffmpeg, input, output, token, duration_ms, progress_cb)
}

fn convert_with_ffmpeg(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    token: Option<&CancellationToken>,
    duration_ms: Option<u64>,
    mut progress_cb: Option<&mut dyn FnMut(f32)>,
) -> Result<()> {
    if let Some(token) = token
        && token.is_cancelled()
    {
        return Err(cancelled_error());
    }

    if duration_ms.is_some() && progress_cb.is_some() {
        let mut child = Command::new(ffmpeg)
            .arg("-y")
            .arg("-nostdin")
            .arg("-loglevel")
            .arg("error")
            .arg("-progress")
            .arg("pipe:1")
            .arg("-nostats")
            .arg("-i")
            .arg(input)
            .arg("-vn")
            .arg("-acodec")
            .arg("pcm_s16le")
            .arg("-ar")
            .arg(TARGET_SAMPLE_RATE.to_string())
            .arg("-ac")
            .arg("1")
            .arg(output)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| match err.kind() {
                ErrorKind::NotFound => anyhow!("FFmpeg not found on PATH."),
                _ => anyhow!("Failed to run ffmpeg: {err}"),
            })?;

        let mut reader = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| anyhow!("Failed to read ffmpeg progress output"))?,
        );
        let total_ms = duration_ms.unwrap_or_default().max(1);
        let mut last_reported = 0.0f32;
        let mut line = String::new();

        loop {
            if let Some(token) = token
                && token.is_cancelled()
            {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(output);
                return Err(cancelled_error());
            }

            line.clear();
            let read = reader
                .read_line(&mut line)
                .map_err(|err| anyhow!("Failed to read ffmpeg progress output: {err}"))?;
            if read == 0 {
                break;
            }

            if let Some(out_time_ms) = parse_ffmpeg_progress_ms(line.trim())
                && let Some(cb) = progress_cb.as_mut()
            {
                let progress = (out_time_ms as f64 / total_ms as f64).min(1.0) as f32;
                if progress >= 1.0 || (progress - last_reported) >= 0.01 {
                    cb(progress);
                    last_reported = progress;
                }
            }
        }

        let status = child
            .wait()
            .map_err(|err| anyhow!("Failed to run ffmpeg: {err}"))?;
        if let Some(token) = token
            && token.is_cancelled()
        {
            let _ = fs::remove_file(output);
            return Err(cancelled_error());
        }
        if !status.success() {
            let _ = fs::remove_file(output);
            return Err(anyhow!("ffmpeg conversion failed"));
        }
        if let Some(cb) = progress_cb.as_mut() {
            cb(1.0);
        }
        return Ok(());
    }

    let mut child = Command::new(ffmpeg)
        .arg("-y")
        .arg("-nostdin")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(input)
        .arg("-vn")
        .arg("-acodec")
        .arg("pcm_s16le")
        .arg("-ar")
        .arg(TARGET_SAMPLE_RATE.to_string())
        .arg("-ac")
        .arg("1")
        .arg(output)
        .spawn()
        .map_err(|err| match err.kind() {
            ErrorKind::NotFound => anyhow!("FFmpeg not found on PATH."),
            _ => anyhow!("Failed to run ffmpeg: {err}"),
        })?;
    let status = loop {
        if let Some(token) = token
            && token.is_cancelled()
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(output);
            return Err(cancelled_error());
        }

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                thread::sleep(Duration::from_millis(200));
            }
            Err(err) => {
                let _ = child.kill();
                let _ = fs::remove_file(output);
                return Err(anyhow!("Failed to run ffmpeg: {err}"));
            }
        }
    };

    if !status.success() {
        let _ = fs::remove_file(output);
        return Err(anyhow!("ffmpeg conversion failed"));
    }
    Ok(())
}

fn find_binary_in_path(file_name: &str, fallback_dirs: &[&str]) -> Option<PathBuf> {
    if let Some(path_var) = env::var_os("PATH") {
        for dir in env::split_paths(&path_var) {
            let candidate = dir.join(file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for dir in fallback_dirs {
        let candidate = Path::new(dir).join(file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_ffmpeg_in_path() -> Option<PathBuf> {
    let file_name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let fallback_dirs: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
        ]
    } else {
        &["/usr/local/bin", "/usr/bin"]
    };
    find_binary_in_path(file_name, fallback_dirs)
}

fn find_ffprobe_in_path() -> Option<PathBuf> {
    let file_name = if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let fallback_dirs: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
        ]
    } else {
        &["/usr/local/bin", "/usr/bin"]
    };
    find_binary_in_path(file_name, fallback_dirs)
}

pub(crate) fn probe_media_duration_ms(path: &Path) -> Option<u64> {
    if let Some(ffprobe) = find_ffprobe_in_path() {
        let output = Command::new(ffprobe)
            .arg("-v")
            .arg("error")
            .arg("-show_entries")
            .arg("format=duration")
            .arg("-of")
            .arg("default=nk=1:nw=1")
            .arg(path)
            .output()
            .ok()?;
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let seconds = stdout.trim().parse::<f64>().ok()?;
            if seconds.is_finite() && seconds > 0.0 {
                return Some((seconds * 1000.0) as u64);
            }
        }
    }

    probe_media_duration_ms_symphonia(path)
}

fn probe_media_duration_ms_symphonia(path: &Path) -> Option<u64> {
    let file = fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(ext);
    }

    let format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .ok()?;
    let track = format.default_track(TrackType::Audio).or_else(|| {
        format.tracks().iter().find(|track| {
            track
                .codec_params
                .as_ref()
                .and_then(|params| params.audio())
                .is_some_and(|audio| audio.sample_rate.is_some() && audio.channels.is_some())
        })
    })?;
    let time_base = track.time_base?;
    let num_frames = track.num_frames?;
    let time = time_base.calc_time(Timestamp::new(num_frames as i64))?;
    let ms = time.as_millis();
    if ms > 0 { Some(ms as u64) } else { None }
}

fn parse_ffmpeg_progress_ms(line: &str) -> Option<u64> {
    if let Some(value) = line.strip_prefix("out_time_ms=") {
        return value.trim().parse::<u64>().ok();
    }
    if let Some(value) = line.strip_prefix("out_time_us=") {
        return value.trim().parse::<u64>().ok().map(|us| us / 1000);
    }
    if let Some(value) = line.strip_prefix("out_time=") {
        return parse_ffmpeg_time_to_ms(value.trim());
    }
    None
}

fn parse_ffmpeg_time_to_ms(value: &str) -> Option<u64> {
    let parts = value.splitn(3, ':').collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    let hours = parts[0].parse::<u64>().ok()?;
    let minutes = parts[1].parse::<u64>().ok()?;
    let seconds = parts[2].parse::<f64>().ok()?;
    let total_seconds = (hours as f64 * 3600.0) + (minutes as f64 * 60.0) + seconds;
    if total_seconds.is_finite() && total_seconds >= 0.0 {
        Some((total_seconds * 1000.0) as u64)
    } else {
        None
    }
}

fn wav_duration_seconds(path: &Path) -> Result<f32> {
    let file = fs::File::open(path)
        .with_context(|| format!("Failed to open WAV file at {}", path.display()))?;
    let reader = hound::WavReader::new(file).map_err(|err| anyhow!("WAV read error: {err}"))?;
    let spec = reader.spec();
    if spec.sample_rate == 0 {
        return Err(anyhow!("Invalid sample rate"));
    }
    let samples = reader.duration() as f32;
    Ok(samples / spec.sample_rate as f32)
}

pub(crate) fn convert_segments_to_ms(
    segments: &[glimpse_speech::TranscriptionSegment],
) -> Vec<TranscriptSegment> {
    segments
        .iter()
        .map(|segment| TranscriptSegment {
            start_ms: (segment.start * 1000.0).max(0.0) as u64,
            end_ms: (segment.end * 1000.0).max(0.0) as u64,
            text: segment.text.trim().to_string(),
            speaker_id: None,
        })
        .collect()
}

pub(crate) fn diarize_segments(
    segments: &[glimpse_speech::remote::DiarizedSegment],
) -> (Vec<TranscriptSegment>, Option<Vec<Speaker>>) {
    let mut labels: Vec<String> = Vec::new();
    for segment in segments {
        if let Some(label) = segment.speaker.as_deref().map(str::trim)
            && !label.is_empty()
            && !labels.iter().any(|seen| seen == label)
        {
            labels.push(label.to_string());
        }
    }

    let speakers: Vec<Speaker> = labels
        .iter()
        .enumerate()
        .map(|(index, _)| Speaker {
            id: format!("speaker_{}", index + 1),
            name: format!("Speaker {}", index + 1),
            color: None,
        })
        .collect();

    let converted = segments
        .iter()
        .map(|segment| {
            let speaker_id = segment
                .speaker
                .as_deref()
                .map(str::trim)
                .filter(|label| !label.is_empty())
                .and_then(|label| {
                    labels
                        .iter()
                        .position(|seen| seen == label)
                        .map(|index| speakers[index].id.clone())
                });
            TranscriptSegment {
                start_ms: (segment.start * 1000.0).max(0.0) as u64,
                end_ms: (segment.end * 1000.0).max(0.0) as u64,
                text: segment.text.trim().to_string(),
                speaker_id,
            }
        })
        .collect();

    (converted, (!speakers.is_empty()).then_some(speakers))
}

pub(crate) fn build_export_content(item: &LibraryItem, format: ExportFormat) -> Result<String> {
    let title = item.name.clone();
    let transcript = item.transcript.clone().unwrap_or_default();
    match format {
        ExportFormat::Txt => Ok(format!(
            "{}\nTranscribed: {}\n\n{}",
            title,
            item.transcribed_at
                .clone()
                .unwrap_or_else(|| item.created_at.clone()),
            build_speaker_transcript(item, false).unwrap_or(transcript)
        )),
        ExportFormat::Md => Ok(format!(
            "# {}\n\n**Duration:** {}  \n**Transcribed:** {}  \n**Tags:** {}\n\n---\n\n{}",
            title,
            format_duration(item.duration_seconds),
            item.transcribed_at
                .clone()
                .unwrap_or_else(|| item.created_at.clone()),
            if item.tags.is_empty() {
                "None".to_string()
            } else {
                item.tags.join(", ")
            },
            build_speaker_transcript(item, true).unwrap_or(transcript)
        )),
        ExportFormat::Srt => build_srt(item),
        ExportFormat::Vtt => build_vtt(item),
    }
}

fn speaker_name<'a>(item: &'a LibraryItem, speaker_id: &Option<String>) -> Option<&'a str> {
    let id = speaker_id.as_deref()?;
    item.speakers
        .as_ref()?
        .iter()
        .find(|speaker| speaker.id == id)
        .map(|speaker| speaker.name.as_str())
}

fn has_assigned_speakers(item: &LibraryItem) -> bool {
    item.speakers.as_ref().is_some_and(|s| !s.is_empty())
        && item
            .segments
            .as_ref()
            .is_some_and(|segments| segments.iter().any(|s| s.speaker_id.is_some()))
}

/// Groups consecutive same-speaker segments into labeled paragraphs.
fn build_speaker_transcript(item: &LibraryItem, markdown: bool) -> Option<String> {
    if !has_assigned_speakers(item) {
        return None;
    }
    let segments = item.segments.as_ref()?;
    let mut out = String::new();
    let mut current: Option<Option<&str>> = None;
    for segment in segments {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }
        let name = speaker_name(item, &segment.speaker_id);
        if current != Some(name) {
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            if let Some(name) = name {
                if markdown {
                    out.push_str(&format!("**{}:** ", name));
                } else {
                    out.push_str(&format!("{}: ", name));
                }
            }
            current = Some(name);
        } else {
            out.push(' ');
        }
        out.push_str(text);
    }
    Some(out)
}

fn build_srt(item: &LibraryItem) -> Result<String> {
    let segments = item
        .segments
        .as_ref()
        .ok_or_else(|| anyhow!("No timestamp segments available"))?;
    let mut out = String::new();
    for (idx, segment) in segments.iter().enumerate() {
        out.push_str(&(idx + 1).to_string());
        out.push('\n');
        let text = match speaker_name(item, &segment.speaker_id) {
            Some(name) => format!(
                "{}: {}",
                name.replace(['\r', '\n'], " "),
                segment.text.trim()
            ),
            None => segment.text.trim().to_string(),
        };
        out.push_str(&format!(
            "{} --> {}\n{}\n\n",
            format_srt_timestamp(segment.start_ms),
            format_srt_timestamp(segment.end_ms),
            text
        ));
    }
    Ok(out.trim().to_string())
}

fn escape_vtt_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_vtt_voice(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !matches!(ch, '\r' | '\n' | '>'))
        .collect()
}

fn build_vtt(item: &LibraryItem) -> Result<String> {
    let segments = item
        .segments
        .as_ref()
        .ok_or_else(|| anyhow!("No timestamp segments available"))?;
    let mut out = String::from("WEBVTT\n\n");
    for segment in segments {
        // WebVTT voice spans render as speaker labels in players.
        let text = match speaker_name(item, &segment.speaker_id) {
            Some(name) => format!(
                "<v {}>{}</v>",
                escape_vtt_voice(name),
                escape_vtt_text(segment.text.trim())
            ),
            None => escape_vtt_text(segment.text.trim()),
        };
        out.push_str(&format!(
            "{} --> {}\n{}\n\n",
            format_vtt_timestamp(segment.start_ms),
            format_vtt_timestamp(segment.end_ms),
            text
        ));
    }
    Ok(out.trim().to_string())
}

fn format_srt_timestamp(ms: u64) -> String {
    let total_seconds = ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    let millis = ms % 1000;
    format!("{:02}:{:02}:{:02},{:03}", hours, minutes, seconds, millis)
}

fn format_vtt_timestamp(ms: u64) -> String {
    let total_seconds = ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    let millis = ms % 1000;
    format!("{:02}:{:02}:{:02}.{:03}", hours, minutes, seconds, millis)
}

fn format_duration(seconds: f32) -> String {
    if seconds <= 0.0 {
        return "0:00".to_string();
    }
    let total = seconds.round() as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let secs = total % 60;
    if hours > 0 {
        format!("{}:{:02}:{:02}", hours, minutes, secs)
    } else {
        format!("{}:{:02}", minutes, secs)
    }
}
