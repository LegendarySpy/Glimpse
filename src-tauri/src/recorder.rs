use std::{borrow::Cow, f32::consts::PI, fs, path::PathBuf, sync::Arc};

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Local};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};
use crossbeam_channel::{bounded, unbounded, Sender};
use mp3lame_encoder::{
    Bitrate, Builder as LameBuilder, FlushNoGap, InterleavedPcm, MonoPcm, Quality,
};
use parking_lot::Mutex;
use webrtc_vad::{Vad, VadMode};

/// Reason why a recording was rejected
#[derive(Debug, Clone)]
pub enum RecordingRejectionReason {
    TooShort { duration_ms: i64, min_ms: i64 },
    TooQuiet { rms: f32, threshold: f32 },
    NoSpeechDetected,
    EmptyBuffer,
}

pub struct RecorderManager {
    tx: Sender<RecorderCommand>,
}

struct ActiveRecording {
    stream: Stream,
    buffer: Arc<Mutex<Vec<i16>>>,
    sample_rate: u32,
    channels: u16,
    started_at: DateTime<Local>,
}

#[derive(Debug, Clone)]
pub struct CompletedRecording {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
    pub channels: u16,
    pub started_at: DateTime<Local>,
    pub ended_at: DateTime<Local>,
}

#[derive(Debug, Clone)]
pub struct RecordingSaved {
    pub path: PathBuf,
    pub started_at: DateTime<Local>,
    pub ended_at: DateTime<Local>,
    /// Override duration in seconds (used for retries when we know the original duration)
    pub duration_override_seconds: Option<f32>,
}

impl RecorderManager {
    pub fn new() -> Self {
        let (tx, rx) = unbounded();

        std::thread::Builder::new()
            .name("glimpse-recorder".into())
            .spawn(move || {
                let mut core = RecorderCore::default();
                while let Ok(cmd) = rx.recv() {
                    match cmd {
                        RecorderCommand::Start { device_id, respond } => {
                            let _ = respond.send(core.start(device_id));
                        }
                        RecorderCommand::Stop { respond } => {
                            let _ = respond.send(core.stop());
                        }
                    }
                }
            })
            .expect("failed to spawn recorder thread");

        Self { tx }
    }

    pub fn start(&self, device_id: Option<String>) -> Result<DateTime<Local>> {
        let (respond_tx, respond_rx) = bounded(1);
        self.tx
            .send(RecorderCommand::Start {
                device_id,
                respond: respond_tx,
            })
            .map_err(|err| anyhow!("Recorder channel closed: {err}"))?;
        respond_rx
            .recv()
            .map_err(|err| anyhow!("Recorder not responding: {err}"))?
    }

    pub fn stop(&self) -> Result<Option<CompletedRecording>> {
        let (respond_tx, respond_rx) = bounded(1);
        self.tx
            .send(RecorderCommand::Stop {
                respond: respond_tx,
            })
            .map_err(|err| anyhow!("Recorder channel closed: {err}"))?;
        respond_rx
            .recv()
            .map_err(|err| anyhow!("Recorder not responding: {err}"))?
    }
}

enum RecorderCommand {
    Start {
        device_id: Option<String>,
        respond: Sender<Result<DateTime<Local>>>,
    },
    Stop {
        respond: Sender<Result<Option<CompletedRecording>>>,
    },
}

#[derive(Default)]
struct RecorderCore {
    active: Option<ActiveRecording>,
}

impl RecorderCore {
    fn start(&mut self, device_id: Option<String>) -> Result<DateTime<Local>> {
        if self.active.is_some() {
            return Err(anyhow!("Recording is already in progress"));
        }

        let host = cpal::default_host();
        let device = if let Some(id) = device_id {
            host.input_devices()
                .context("Failed to list input devices")?
                .find(|d| d.name().map(|n| n == id).unwrap_or(false))
                .or_else(|| host.default_input_device())
                .context("Selected device not found and no default available")?
        } else {
            host.default_input_device()
                .context("No default input device found")?
        };
        let config = device
            .default_input_config()
            .context("No supported input configuration found")?;
        let format = config.sample_format();
        let stream_config: cpal::StreamConfig = config.clone().into();
        let sample_rate = stream_config.sample_rate.0;
        let channels = stream_config.channels;

        let buffer = Arc::new(Mutex::new(Vec::with_capacity(
            (sample_rate as usize * channels as usize).max(48_000),
        )));
        let buffer_ref = buffer.clone();

        let err_fn = |err| {
            eprintln!("Microphone stream error: {err}");
        };

        let stream = match format {
            SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| push_f32_samples(data, &buffer_ref),
                err_fn,
                None,
            )?,
            SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| push_i16_samples(data, &buffer_ref),
                err_fn,
                None,
            )?,
            SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| push_u16_samples(data, &buffer_ref),
                err_fn,
                None,
            )?,
            _ => return Err(anyhow!("Unsupported sample format")),
        };

        stream.play()?;

        let started_at = Local::now();
        self.active = Some(ActiveRecording {
            stream,
            buffer,
            sample_rate,
            channels,
            started_at,
        });

        Ok(started_at)
    }

    fn stop(&mut self) -> Result<Option<CompletedRecording>> {
        if let Some(active) = self.active.take() {
            drop(active.stream);
            let raw_samples = Arc::try_unwrap(active.buffer)
                .map(|mutex| mutex.into_inner())
                .unwrap_or_else(|arc| arc.lock().clone());

            let mut mono = samples_to_mono_f32(&raw_samples, active.channels as usize);
            if mono.is_empty() {
                return Ok(Some(CompletedRecording {
                    samples: raw_samples,
                    sample_rate: active.sample_rate,
                    channels: active.channels,
                    started_at: active.started_at,
                    ended_at: Local::now(),
                }));
            }

            apply_filters(&mut mono, active.sample_rate);
            let trimmed = trim_silence(&mono, active.sample_rate);
            let mut processed = if trimmed.is_empty() { mono } else { trimmed };

            apply_compression(&mut processed);
            apply_frame_normalization(&mut processed, active.sample_rate);

            let samples: Vec<i16> = processed
                .into_iter()
                .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
                .collect();

            Ok(Some(CompletedRecording {
                samples,
                sample_rate: active.sample_rate,
                channels: 1,
                started_at: active.started_at,
                ended_at: Local::now(),
            }))
        } else {
            Ok(None)
        }
    }
}

/// Configuration for recording validation
pub struct ValidationConfig {
    /// Minimum duration in milliseconds (default: 300ms)
    pub min_duration_ms: i64,
    /// Minimum RMS energy threshold (default: 0.005)
    pub min_rms_energy: f32,
    /// Minimum percentage of frames that must contain speech (default: 5%)
    pub min_speech_percentage: f32,
}

impl Default for ValidationConfig {
    fn default() -> Self {
        Self {
            min_duration_ms: 300,
            min_rms_energy: 0.0003,
            min_speech_percentage: 5.0,
        }
    }
}

/// Validates if a recording contains meaningful audio worth transcribing.
/// Returns Ok(()) if valid, or Err with the rejection reason.
pub fn validate_recording(recording: &CompletedRecording) -> Result<(), RecordingRejectionReason> {
    validate_recording_with_config(recording, &ValidationConfig::default())
}

/// Validates a recording with custom configuration.
pub fn validate_recording_with_config(
    recording: &CompletedRecording,
    config: &ValidationConfig,
) -> Result<(), RecordingRejectionReason> {
    // Check 1: Empty buffer
    if recording.samples.is_empty() {
        return Err(RecordingRejectionReason::EmptyBuffer);
    }

    // Check 2: Minimum duration
    let duration_ms = (recording.ended_at - recording.started_at).num_milliseconds();
    if duration_ms < config.min_duration_ms {
        return Err(RecordingRejectionReason::TooShort {
            duration_ms,
            min_ms: config.min_duration_ms,
        });
    }

    // Convert to f32 for analysis
    let samples_f32: Vec<f32> = recording
        .samples
        .iter()
        .map(|s| *s as f32 / i16::MAX as f32)
        .collect();

    // Check 3: RMS energy level (catches silence/very quiet recordings)
    let rms = calculate_rms(&samples_f32);
    if rms < config.min_rms_energy {
        return Err(RecordingRejectionReason::TooQuiet {
            rms,
            threshold: config.min_rms_energy,
        });
    }

    // Check 4: Voice Activity Detection - ensure at least some speech is present
    let speech_percentage = calculate_speech_percentage(&samples_f32, recording.sample_rate);
    if speech_percentage < config.min_speech_percentage {
        return Err(RecordingRejectionReason::NoSpeechDetected);
    }

    Ok(())
}

/// Calculate Root Mean Square energy of audio samples
fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_squares: f32 = samples.iter().map(|s| s * s).sum();
    (sum_squares / samples.len() as f32).sqrt()
}

/// Calculate percentage of frames containing speech using VAD
fn calculate_speech_percentage(samples: &[f32], sample_rate: u32) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    // Resample to VAD-compatible rate if needed
    let vad_rate = match sample_rate {
        8000 | 16000 | 32000 | 48000 => sample_rate,
        _ => 16000,
    };

    let analysis = if vad_rate == sample_rate {
        samples.to_vec()
    } else {
        resample_linear(samples, sample_rate, vad_rate)
    };

    let frame_ms = 30usize;
    let frame_len = (vad_rate as usize * frame_ms) / 1000;
    if frame_len == 0 || analysis.len() < frame_len {
        return 0.0;
    }

    let analysis_i16: Vec<i16> = analysis
        .iter()
        .map(|s| (*s).clamp(-1.0, 1.0))
        .map(|s| (s * i16::MAX as f32).round() as i16)
        .collect();

    let mut vad = match Vad::new(vad_rate as i32) {
        Ok(mut instance) => {
            // Use aggressive mode to be more strict about detecting speech
            let _ = instance.fvad_set_mode(VadMode::LowBitrate);
            instance
        }
        Err(_) => return 100.0, // If VAD fails, assume it's valid
    };

    let mut speech_frames = 0;
    let mut total_frames = 0;
    for chunk in analysis_i16.chunks(frame_len) {
        if chunk.len() < frame_len {
            break;
        }
        total_frames += 1;
        if vad.is_voice_segment(chunk).unwrap_or(false) {
            speech_frames += 1;
        }
    }

    if total_frames == 0 {
        return 0.0;
    }

    (speech_frames as f32 / total_frames as f32) * 100.0
}

pub fn persist_recording(
    base_dir: PathBuf,
    recording: CompletedRecording,
) -> Result<RecordingSaved> {
    if recording.samples.is_empty() {
        return Err(anyhow!("Recording buffer is empty"));
    }

    let date_dir = recording.started_at.format("%Y-%m-%d").to_string();
    let timestamp = recording.started_at.format("%H%M%S").to_string();

    let folder = base_dir.join(date_dir);
    fs::create_dir_all(&folder)
        .with_context(|| format!("Failed to create recording folder at {}", folder.display()))?;
    let file_path = folder.join(format!("{}.mp3", timestamp));

    let mp3_bytes = encode_to_mp3(
        &recording.samples,
        recording.sample_rate,
        recording.channels,
    )?;
    fs::write(&file_path, mp3_bytes)
        .with_context(|| format!("Failed to write recording file at {}", file_path.display()))?;

    Ok(RecordingSaved {
        path: file_path,
        started_at: recording.started_at,
        ended_at: recording.ended_at,
        duration_override_seconds: None,
    })
}

fn encode_to_mp3(samples: &[i16], sample_rate: u32, channels: u16) -> Result<Vec<u8>> {
    // Minimum samples needed for MP3 encoding (at least one frame worth)
    // MP3 frames are typically 1152 samples for MPEG-1
    const MIN_SAMPLES: usize = 1152;

    if samples.len() < MIN_SAMPLES {
        return Err(anyhow!("Recording too short (minimum ~50ms required)"));
    }

    let mut builder =
        LameBuilder::new().ok_or_else(|| anyhow!("Failed to initialize MP3 encoder"))?;
    builder
        .set_sample_rate(sample_rate)
        .map_err(|err| anyhow!("Invalid sample rate: {err}"))?;
    let constrained_channels = match channels {
        0 => 1,
        1 | 2 => channels,
        _ => 1,
    };
    builder
        .set_num_channels(constrained_channels as u8)
        .map_err(|err| anyhow!("Invalid channel count: {err}"))?;
    builder
        .set_brate(Bitrate::Kbps128)
        .map_err(|err| anyhow!("Failed to set bitrate: {err}"))?;
    builder
        .set_quality(Quality::VeryNice)
        .map_err(|err| anyhow!("Failed to set quality: {err}"))?;

    let mut encoder = builder
        .build()
        .map_err(|err| anyhow!("Failed to initialize encoder: {err}"))?;
    let mut output = Vec::with_capacity(mp3lame_encoder::max_required_buffer_size(samples.len()));

    let buffer: Cow<'_, [i16]> = if constrained_channels == channels || channels <= 2 {
        Cow::Borrowed(samples)
    } else {
        Cow::Owned(downmix_to_mono(samples, channels as usize))
    };

    match constrained_channels {
        1 => {
            encoder
                .encode_to_vec(MonoPcm(buffer.as_ref()), &mut output)
                .map_err(|err| anyhow!("Encode error: {err}"))?;
        }
        2 => {
            encoder
                .encode_to_vec(InterleavedPcm(buffer.as_ref()), &mut output)
                .map_err(|err| anyhow!("Encode error: {err}"))?;
        }
        _ => unreachable!(),
    }

    encoder
        .flush_to_vec::<FlushNoGap>(&mut output)
        .map_err(|err| anyhow!("Flush error: {err}"))?;

    Ok(output)
}

fn samples_to_mono_f32(samples: &[i16], channels: usize) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    if channels <= 1 {
        return samples
            .iter()
            .map(|s| *s as f32 / i16::MAX as f32)
            .collect();
    }

    let frames = samples.len() / channels;
    let mut mono = Vec::with_capacity(frames);
    for frame in 0..frames {
        let mut acc = 0f32;
        for ch in 0..channels {
            let idx = frame * channels + ch;
            if let Some(sample) = samples.get(idx) {
                acc += *sample as f32;
            }
        }
        mono.push(acc / channels as f32 / i16::MAX as f32);
    }
    mono
}

fn apply_filters(samples: &mut [f32], sample_rate: u32) {
    apply_high_pass(samples, sample_rate, 120.0);
    apply_low_pass(samples, sample_rate, 8_000.0);
}

fn apply_high_pass(samples: &mut [f32], sample_rate: u32, cutoff: f32) {
    if samples.is_empty() {
        return;
    }
    let clamped_cutoff = cutoff.min(sample_rate as f32 / 2.0 - 10.0).max(20.0);
    let rc = 1.0 / (2.0 * PI * clamped_cutoff);
    let dt = 1.0 / sample_rate as f32;
    let alpha = rc / (rc + dt);
    let mut prev_y = samples[0];
    let mut prev_x = samples[0];
    for sample in samples.iter_mut() {
        let y = alpha * (prev_y + *sample - prev_x);
        prev_y = y;
        prev_x = *sample;
        *sample = y;
    }
}

fn apply_low_pass(samples: &mut [f32], sample_rate: u32, cutoff: f32) {
    if samples.is_empty() {
        return;
    }
    let clamped_cutoff = cutoff.min(sample_rate as f32 / 2.0 - 10.0).max(200.0);
    let rc = 1.0 / (2.0 * PI * clamped_cutoff);
    let dt = 1.0 / sample_rate as f32;
    let alpha = dt / (rc + dt);
    let mut prev = samples[0];
    for sample in samples.iter_mut() {
        prev = prev + alpha * (*sample - prev);
        *sample = prev;
    }
}

fn apply_compression(samples: &mut [f32]) {
    if samples.is_empty() {
        return;
    }

    let threshold = 0.2f32;
    let ratio = 2.0f32;
    let attack = 0.2f32;
    let release = 0.02f32;
    let mut gain = 1.0f32;

    for sample in samples.iter_mut() {
        let input_level = sample.abs();
        let mut target_gain = 1.0f32;
        if input_level > threshold {
            let over = input_level / threshold;
            let compressed = threshold * (1.0 + (over - 1.0) / ratio);
            target_gain = (compressed / input_level).clamp(0.1, 1.0);
        }
        let coeff = if target_gain < gain { attack } else { release };
        gain += (target_gain - gain) * coeff;
        *sample *= gain;
    }
}

fn apply_frame_normalization(samples: &mut [f32], sample_rate: u32) {
    if samples.is_empty() {
        return;
    }

    let frame_size = (sample_rate as usize / 100).max(256);
    let target_rms = 0.22f32;
    let smoothing = 0.1f32;
    let mut gain = 1.0f32;

    for chunk in samples.chunks_mut(frame_size) {
        let rms = (chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len().max(1) as f32).sqrt();
        let desired = if rms > 1e-4 {
            (target_rms / rms).clamp(0.5, 4.0)
        } else {
            4.0
        };
        gain += (desired - gain) * smoothing;
        for sample in chunk.iter_mut() {
            *sample *= gain;
        }
    }
}

fn trim_silence(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let vad_rate = match sample_rate {
        8000 | 16000 | 32000 | 48000 => sample_rate,
        _ => 16000,
    };

    let analysis = if vad_rate == sample_rate {
        samples.to_vec()
    } else {
        resample_linear(samples, sample_rate, vad_rate)
    };

    let frame_ms = 30usize;
    let frame_len = (vad_rate as usize * frame_ms) / 1000;
    if frame_len == 0 || analysis.len() < frame_len {
        return samples.to_vec();
    }

    let analysis_i16: Vec<i16> = analysis
        .iter()
        .map(|s| (*s).clamp(-1.0, 1.0))
        .map(|s| (s * i16::MAX as f32).round() as i16)
        .collect();

    let mut vad = match Vad::new(vad_rate as i32) {
        Ok(mut instance) => {
            let _ = instance.fvad_set_mode(VadMode::LowBitrate);
            instance
        }
        Err(_) => return samples.to_vec(),
    };

    let mut speech_frames = Vec::new();
    for chunk in analysis_i16.chunks(frame_len) {
        if chunk.len() < frame_len {
            break;
        }
        let voiced = vad.is_voice_segment(chunk).unwrap_or(true);
        speech_frames.push(voiced);
    }

    if speech_frames.is_empty() || speech_frames.iter().all(|flag| !*flag) {
        return samples.to_vec();
    }

    let hang_duration_ms = 350f32;
    let hang_frames = ((hang_duration_ms / frame_ms as f32).ceil()) as usize;
    let pre_roll = 4usize;
    let min_gap_ms = 600f32;
    let min_gap_frames = ((min_gap_ms / frame_ms as f32).ceil()) as usize;
    let mut keep_mask = vec![false; speech_frames.len()];
    let mut hang = 0usize;
    for (idx, speech) in speech_frames.iter().enumerate() {
        if *speech {
            keep_mask[idx] = true;
            hang = hang_frames;
        } else if hang > 0 {
            keep_mask[idx] = true;
            hang -= 1;
        }
    }

    // restore short pauses to avoid over-trimming
    if min_gap_frames > 0 {
        let mut run_start = None;
        for idx in 0..keep_mask.len() {
            if !keep_mask[idx] {
                run_start.get_or_insert(idx);
            } else if let Some(start) = run_start.take() {
                if idx - start <= min_gap_frames {
                    for gap_idx in start..idx {
                        keep_mask[gap_idx] = true;
                    }
                }
            }
        }
        if let Some(start) = run_start.take() {
            if keep_mask.len() - start <= min_gap_frames {
                for gap_idx in start..keep_mask.len() {
                    keep_mask[gap_idx] = true;
                }
            }
        }
    }

    for idx in 0..keep_mask.len() {
        if keep_mask[idx] {
            for back in 1..=pre_roll.min(idx) {
                keep_mask[idx - back] = true;
            }
        }
    }

    let samples_per_vad_sample = sample_rate as f32 / vad_rate as f32;
    let mut intervals: Vec<(usize, usize)> = Vec::new();
    let mut current: Option<(usize, usize)> = None;
    for (idx, keep) in keep_mask.iter().enumerate() {
        let start = ((idx * frame_len) as f32 * samples_per_vad_sample) as usize;
        let end = (((idx + 1) * frame_len) as f32 * samples_per_vad_sample).ceil() as usize;
        if *keep {
            if let Some(interval) = current.as_mut() {
                interval.1 = end;
            } else {
                current = Some((start, end));
            }
        } else if let Some(interval) = current.take() {
            intervals.push(interval);
        }
    }
    if let Some(interval) = current.take() {
        intervals.push(interval);
    }

    if intervals.is_empty() {
        return samples.to_vec();
    }

    let mut output = Vec::new();
    for (start, end) in intervals {
        let clamped_start = start.min(samples.len());
        let clamped_end = end.min(samples.len());
        if clamped_start < clamped_end {
            output.extend_from_slice(&samples[clamped_start..clamped_end]);
        }
    }

    if output.is_empty() {
        samples.to_vec()
    } else {
        output
    }
}

fn resample_linear(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
    if input.is_empty() {
        return Vec::new();
    }
    if in_rate == out_rate {
        return input.to_vec();
    }

    let ratio = out_rate as f64 / in_rate as f64;
    let out_len = ((input.len() as f64) * ratio).max(1.0).round() as usize;
    if out_len <= 1 {
        return vec![input[0]];
    }

    let mut output = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos.floor() as usize;
        let frac = src_pos - idx as f64;
        let next_idx = (idx + 1).min(input.len() - 1);
        let sample = input[idx] as f64 * (1.0 - frac) + input[next_idx] as f64 * frac;
        output.push(sample as f32);
    }
    output
}

fn push_f32_samples(data: &[f32], buffer: &Arc<Mutex<Vec<i16>>>) {
    let mut writer = buffer.lock();
    for &sample in data {
        let clamped = sample.clamp(-1.0, 1.0);
        writer.push((clamped * i16::MAX as f32) as i16);
    }
}

fn push_i16_samples(data: &[i16], buffer: &Arc<Mutex<Vec<i16>>>) {
    let mut writer = buffer.lock();
    writer.extend_from_slice(data);
}

fn push_u16_samples(data: &[u16], buffer: &Arc<Mutex<Vec<i16>>>) {
    let mut writer = buffer.lock();
    for &sample in data {
        let centered = sample as i32 - i16::MAX as i32;
        writer.push(centered as i16);
    }
}

fn downmix_to_mono(samples: &[i16], channels: usize) -> Vec<i16> {
    if channels <= 1 {
        return samples.to_vec();
    }

    let frames = samples.len() / channels;
    let mut mono = Vec::with_capacity(frames);
    for frame in 0..frames {
        let mut acc = 0i32;
        for ch in 0..channels {
            let idx = frame * channels + ch;
            acc += samples.get(idx).copied().unwrap_or_default() as i32;
        }
        mono.push((acc / channels as i32) as i16);
    }
    mono
}
