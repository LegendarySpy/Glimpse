use std::{
    f32::consts::PI,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Local, TimeZone};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream};
use crossbeam_channel::{Sender, bounded, unbounded};
use parking_lot::Mutex;
use rubato::{Fft, FixedSync, Resampler, audioadapter_buffers::direct::InterleavedSlice};
use uuid::Uuid;
use webrtc_vad::{SampleRate as VadSampleRate, Vad, VadMode};

#[derive(Debug, Clone)]
pub enum RecordingRejectionReason {
    TooShort { duration_ms: i64, min_ms: i64 },
    TooQuiet { rms: f32, threshold: f32 },
    NoSpeechDetected,
    EmptyBuffer,
}

pub(crate) const SPECTRUM_SIZE: usize = 512;
const ARM_SIGNAL_FLOOR: f32 = 0.01;

struct AudioSpectrumState {
    samples: Vec<f32>,
    write_index: usize,
    filled: bool,
}

impl AudioSpectrumState {
    fn new() -> Self {
        Self {
            samples: vec![0.0; SPECTRUM_SIZE],
            write_index: 0,
            filled: false,
        }
    }

    fn push_sample(&mut self, sample: f32) {
        self.samples[self.write_index] = sample;
        self.write_index += 1;
        if self.write_index >= SPECTRUM_SIZE {
            self.write_index = 0;
            self.filled = true;
        }
    }

    fn reset(&mut self) {
        self.samples.fill(0.0);
        self.write_index = 0;
        self.filled = false;
    }

    fn snapshot(&self) -> Option<Vec<f32>> {
        if !self.filled {
            return None;
        }
        let mut out = Vec::with_capacity(SPECTRUM_SIZE);
        out.extend_from_slice(&self.samples[self.write_index..]);
        out.extend_from_slice(&self.samples[..self.write_index]);
        Some(out)
    }
}

struct LiveBufferState {
    buffer: Arc<Mutex<Vec<i16>>>,
    sample_rate: u32,
    channels: u16,
}

pub struct RecorderManager {
    tx: Sender<RecorderCommand>,
    spectrum: Arc<Mutex<AudioSpectrumState>>,
    live_buffer: Arc<Mutex<Option<LiveBufferState>>>,
    armed: Arc<AtomicBool>,
}

type AfterCaptureHook = Box<dyn FnOnce() + Send + 'static>;

struct ActiveRecording {
    stream: Stream,
    buffer: Arc<Mutex<Vec<i16>>>,
    sample_rate: u32,
    channels: u16,
    started_at: DateTime<Local>,
    pending: Option<PendingWriter>,
}

struct PendingWriter {
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    path: PathBuf,
}

impl PendingWriter {
    fn spawn(
        dir: PathBuf,
        buffer: Arc<Mutex<Vec<i16>>>,
        sample_rate: u32,
        channels: u16,
        started_at: DateTime<Local>,
    ) -> Result<Self> {
        fs::create_dir_all(&dir)
            .with_context(|| format!("Failed to create pending dir at {}", dir.display()))?;
        let millis = started_at.timestamp_millis();
        let suffix = Uuid::new_v4().simple().to_string();
        let path = dir.join(format!("{millis}-{suffix}.partial.wav"));
        let spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec)
            .map_err(|err| anyhow!("Failed to create partial WAV: {err}"))?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop_flag);
        let max_chunk_samples = (sample_rate as usize)
            .saturating_mul(channels as usize)
            .max(1);
        let handle = std::thread::Builder::new()
            .name("glimpse-pending-writer".into())
            .spawn(move || {
                let mut cursor = 0usize;
                loop {
                    let stopping = stop_for_thread.load(Ordering::Relaxed);
                    let (chunk, has_more) = {
                        let buf = buffer.lock();
                        if cursor < buf.len() {
                            let end = cursor.saturating_add(max_chunk_samples).min(buf.len());
                            let slice = buf[cursor..end].to_vec();
                            cursor = end;
                            (slice, cursor < buf.len())
                        } else {
                            (Vec::new(), false)
                        }
                    };
                    for sample in &chunk {
                        let _ = writer.write_sample(*sample);
                    }
                    if !chunk.is_empty() {
                        let _ = writer.flush();
                    }
                    if stopping && !has_more {
                        break;
                    }
                    if has_more {
                        continue;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                let _ = writer.finalize();
            })
            .map_err(|err| anyhow!("Failed to spawn pending writer thread: {err}"))?;

        Ok(Self {
            stop_flag,
            handle: Some(handle),
            path,
        })
    }

    fn finish(mut self) -> PathBuf {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        self.path
    }

    fn finish_and_discard(self) {
        let path = self.finish();
        let _ = fs::remove_file(path);
    }
}

#[derive(Debug, Clone)]
pub struct CompletedRecording {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
    pub channels: u16,
    pub started_at: DateTime<Local>,
    pub ended_at: DateTime<Local>,
    pub pending_path: Option<PathBuf>,
    pub speech_percentage: Option<f32>,
}

#[derive(Debug, Clone)]
pub struct RecordingSaved {
    pub path: PathBuf,
    pub started_at: DateTime<Local>,
    pub ended_at: DateTime<Local>,
    /// Override duration in seconds (used for retries when we know the original duration)
    pub duration_override_seconds: Option<f32>,
    pub pending_path: Option<PathBuf>,
}

impl Default for RecorderManager {
    fn default() -> Self {
        let (tx, rx) = unbounded();
        let spectrum = Arc::new(Mutex::new(AudioSpectrumState::new()));
        let live_buffer = Arc::new(Mutex::new(None));
        let armed = Arc::new(AtomicBool::new(false));
        let spectrum_for_thread = Arc::clone(&spectrum);
        let live_buffer_for_thread = Arc::clone(&live_buffer);
        let armed_for_thread = Arc::clone(&armed);

        std::thread::Builder::new()
            .name("glimpse-recorder".into())
            .spawn(move || {
                let mut core = RecorderCore::new(
                    spectrum_for_thread,
                    live_buffer_for_thread,
                    armed_for_thread,
                );
                while let Ok(cmd) = rx.recv() {
                    match cmd {
                        RecorderCommand::Start {
                            device_id,
                            pending_dir,
                            respond,
                        } => {
                            let _ = respond.send(core.start(device_id, pending_dir));
                        }
                        RecorderCommand::Stop {
                            respond,
                            after_capture,
                            discard_pending,
                        } => {
                            let _ = respond.send(core.stop(after_capture, discard_pending));
                        }
                    }
                }
            })
            .expect("failed to spawn recorder thread");

        Self {
            tx,
            spectrum,
            live_buffer,
            armed,
        }
    }
}

impl RecorderManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn arm(&self) {
        self.armed.store(true, Ordering::Relaxed);
    }

    pub fn spectrum_snapshot(&self) -> Option<Vec<f32>> {
        match self.spectrum.try_lock() {
            Some(state) => state.snapshot(),
            _ => None,
        }
    }

    /// Read new i16 samples from the live recording buffer starting at `offset`.
    /// Returns `(new_samples_mono_f32, sample_rate, new_offset)` or `None` if not recording.
    pub fn read_live_samples(&self, offset: usize) -> Option<(Vec<f32>, u32, usize)> {
        let guard = self.live_buffer.lock();
        let state = guard.as_ref()?;
        let buffer = state.buffer.lock();
        let channels = state.channels as usize;
        let sample_rate = state.sample_rate;

        if offset >= buffer.len() {
            return Some((Vec::new(), sample_rate, offset));
        }

        let raw = &buffer[offset..];
        let new_offset = buffer.len();

        let mono: Vec<f32> = if channels <= 1 {
            raw.iter().map(|s| *s as f32 / i16::MAX as f32).collect()
        } else {
            raw.chunks(channels)
                .map(|frame| {
                    let sum: f32 = frame.iter().map(|s| *s as f32).sum();
                    (sum / channels as f32) / i16::MAX as f32
                })
                .collect()
        };

        Some((mono, sample_rate, new_offset))
    }

    pub fn start(
        &self,
        device_id: Option<String>,
        pending_dir: Option<PathBuf>,
    ) -> Result<DateTime<Local>> {
        let (respond_tx, respond_rx) = bounded(1);
        self.tx
            .send(RecorderCommand::Start {
                device_id,
                pending_dir,
                respond: respond_tx,
            })
            .map_err(|err| anyhow!("Recorder channel closed: {err}"))?;
        respond_rx
            .recv()
            .map_err(|err| anyhow!("Recorder not responding: {err}"))?
    }

    pub fn stop(&self) -> Result<Option<CompletedRecording>> {
        self.stop_after_capture_and_discard_pending(|| {})
    }

    pub fn stop_after_capture(
        &self,
        after_capture: impl FnOnce() + Send + 'static,
    ) -> Result<Option<CompletedRecording>> {
        self.stop_after_capture_inner(after_capture, false)
    }

    pub fn stop_after_capture_and_discard_pending(
        &self,
        after_capture: impl FnOnce() + Send + 'static,
    ) -> Result<Option<CompletedRecording>> {
        self.stop_after_capture_inner(after_capture, true)
    }

    fn stop_after_capture_inner(
        &self,
        after_capture: impl FnOnce() + Send + 'static,
        discard_pending: bool,
    ) -> Result<Option<CompletedRecording>> {
        let (respond_tx, respond_rx) = bounded(1);
        self.tx
            .send(RecorderCommand::Stop {
                respond: respond_tx,
                after_capture: Box::new(after_capture),
                discard_pending,
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
        pending_dir: Option<PathBuf>,
        respond: Sender<Result<DateTime<Local>>>,
    },
    Stop {
        respond: Sender<Result<Option<CompletedRecording>>>,
        after_capture: AfterCaptureHook,
        discard_pending: bool,
    },
}

struct RecorderCore {
    active: Option<ActiveRecording>,
    spectrum: Arc<Mutex<AudioSpectrumState>>,
    live_buffer: Arc<Mutex<Option<LiveBufferState>>>,
    armed: Arc<AtomicBool>,
}

impl RecorderCore {
    fn new(
        spectrum: Arc<Mutex<AudioSpectrumState>>,
        live_buffer: Arc<Mutex<Option<LiveBufferState>>>,
        armed: Arc<AtomicBool>,
    ) -> Self {
        Self {
            active: None,
            spectrum,
            live_buffer,
            armed,
        }
    }

    fn start(
        &mut self,
        device_id: Option<String>,
        pending_dir: Option<PathBuf>,
    ) -> Result<DateTime<Local>> {
        if self.active.is_some() {
            return Err(anyhow!("Recording is already in progress"));
        }

        let host = cpal::default_host();
        let device = if let Some(selected) = device_id {
            selected
                .parse::<cpal::DeviceId>()
                .ok()
                .and_then(|parsed| host.device_by_id(&parsed))
                .or_else(|| {
                    host.input_devices().ok()?.find(|device| {
                        device
                            .id()
                            .map(|id| id.to_string() == selected)
                            .unwrap_or(false)
                            || device
                                .description()
                                .map(|desc| desc.name() == selected.as_str())
                                .unwrap_or(false)
                    })
                })
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
        let stream_config: cpal::StreamConfig = config.into();
        let sample_rate = stream_config.sample_rate;
        let channels = stream_config.channels;

        let buffer = Arc::new(Mutex::new(Vec::with_capacity(
            (sample_rate as usize * channels as usize).max(48_000),
        )));
        self.spectrum.lock().reset();
        self.armed.store(false, Ordering::Relaxed);

        let spectrum = &self.spectrum;
        let armed = &self.armed;
        let stream = match format {
            SampleFormat::F32 => {
                build_mic_stream::<f32>(&device, stream_config, &buffer, spectrum, armed)?
            }
            SampleFormat::F64 => {
                build_mic_stream::<f64>(&device, stream_config, &buffer, spectrum, armed)?
            }
            SampleFormat::I8 => {
                build_mic_stream::<i8>(&device, stream_config, &buffer, spectrum, armed)?
            }
            SampleFormat::I16 => {
                build_mic_stream::<i16>(&device, stream_config, &buffer, spectrum, armed)?
            }
            SampleFormat::I24 => {
                build_mic_stream::<cpal::I24>(&device, stream_config, &buffer, spectrum, armed)?
            }
            SampleFormat::I32 => {
                build_mic_stream::<i32>(&device, stream_config, &buffer, spectrum, armed)?
            }
            SampleFormat::U8 => {
                build_mic_stream::<u8>(&device, stream_config, &buffer, spectrum, armed)?
            }
            SampleFormat::U16 => {
                build_mic_stream::<u16>(&device, stream_config, &buffer, spectrum, armed)?
            }
            SampleFormat::U32 => {
                build_mic_stream::<u32>(&device, stream_config, &buffer, spectrum, armed)?
            }
            other => return Err(anyhow!("Unsupported sample format: {other}")),
        };

        stream.play()?;

        *self.live_buffer.lock() = Some(LiveBufferState {
            buffer: Arc::clone(&buffer),
            sample_rate,
            channels,
        });

        let started_at = Local::now();
        let pending = pending_dir.and_then(|dir| {
            match PendingWriter::spawn(dir, Arc::clone(&buffer), sample_rate, channels, started_at)
            {
                Ok(writer) => Some(writer),
                Err(err) => {
                    tracing::error!("Crash-safe recording writer unavailable: {err}");
                    None
                }
            }
        });

        self.active = Some(ActiveRecording {
            stream,
            buffer,
            sample_rate,
            channels,
            started_at,
            pending,
        });

        Ok(started_at)
    }

    fn stop(
        &mut self,
        after_capture: AfterCaptureHook,
        discard_pending: bool,
    ) -> Result<Option<CompletedRecording>> {
        *self.live_buffer.lock() = None;
        self.spectrum.lock().reset();
        match self.active.take() {
            Some(mut active) => {
                drop(active.stream);
                let pending_path = match active.pending.take() {
                    Some(pending) => {
                        if discard_pending {
                            pending.finish_and_discard();
                            None
                        } else {
                            Some(pending.finish())
                        }
                    }
                    _ => None,
                };
                let ended_at = Local::now();
                after_capture();
                let raw_samples = Arc::try_unwrap(active.buffer)
                    .map(|mutex| mutex.into_inner())
                    .unwrap_or_else(|arc| arc.lock().clone());

                let processed =
                    process_raw_samples(&raw_samples, active.sample_rate, active.channels);

                Ok(Some(CompletedRecording {
                    samples: processed.samples,
                    sample_rate: processed.sample_rate,
                    channels: processed.channels,
                    started_at: active.started_at,
                    ended_at,
                    pending_path,
                    speech_percentage: processed.speech_percentage,
                }))
            }
            _ => {
                after_capture();
                Ok(None)
            }
        }
    }
}

struct ProcessedAudio {
    samples: Vec<i16>,
    sample_rate: u32,
    channels: u16,
    speech_percentage: Option<f32>,
}

fn process_raw_samples(raw_samples: &[i16], sample_rate: u32, channels: u16) -> ProcessedAudio {
    let mut mono = samples_to_mono_f32(raw_samples, channels as usize);
    if mono.is_empty() {
        return ProcessedAudio {
            samples: raw_samples.to_vec(),
            sample_rate,
            channels,
            speech_percentage: None,
        };
    }

    apply_filters(&mut mono, sample_rate);

    // Resample to 16kHz once; WAV storage, VAD, and local models all consume 16kHz.
    let mono = if sample_rate == WAV_SAMPLE_RATE {
        mono
    } else {
        resample_audio(&mono, sample_rate, WAV_SAMPLE_RATE)
    };

    let (trimmed, speech_percentage) = trim_silence(&mono, WAV_SAMPLE_RATE);
    let mut processed = if trimmed.is_empty() { mono } else { trimmed };

    apply_compression(&mut processed);
    apply_frame_normalization(&mut processed, WAV_SAMPLE_RATE);
    apply_peak_limiter(&mut processed);

    let samples = processed
        .into_iter()
        .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
        .collect();

    ProcessedAudio {
        samples,
        sample_rate: WAV_SAMPLE_RATE,
        channels: 1,
        speech_percentage,
    }
}

pub const MIN_RECORDING_DURATION_MS: i64 = 300;

pub struct ValidationConfig {
    pub min_duration_ms: i64,
    pub min_rms_energy: f32,
    pub min_speech_percentage: f32,
}

impl Default for ValidationConfig {
    fn default() -> Self {
        Self {
            min_duration_ms: MIN_RECORDING_DURATION_MS,
            min_rms_energy: 0.0002,
            min_speech_percentage: 3.0,
        }
    }
}

pub fn validate_recording(recording: &CompletedRecording) -> Result<(), RecordingRejectionReason> {
    validate_recording_with_config(recording, &ValidationConfig::default())
}

pub fn validate_recording_with_config(
    recording: &CompletedRecording,
    config: &ValidationConfig,
) -> Result<(), RecordingRejectionReason> {
    if recording.samples.is_empty() {
        return Err(RecordingRejectionReason::EmptyBuffer);
    }

    let duration_ms = (recording.ended_at - recording.started_at).num_milliseconds();
    if duration_ms < config.min_duration_ms {
        return Err(RecordingRejectionReason::TooShort {
            duration_ms,
            min_ms: config.min_duration_ms,
        });
    }

    let rms = calculate_rms_i16(&recording.samples);
    if rms < config.min_rms_energy {
        return Err(RecordingRejectionReason::TooQuiet {
            rms,
            threshold: config.min_rms_energy,
        });
    }

    let mut speech_percentage = recording.speech_percentage.unwrap_or_else(|| {
        speech_percentage_i16_with_mode(&recording.samples, recording.sample_rate, VadMode::Quality)
    });
    if recording.speech_percentage.is_some() && speech_percentage < config.min_speech_percentage {
        speech_percentage = speech_percentage_i16_with_mode(
            &recording.samples,
            recording.sample_rate,
            VadMode::Quality,
        );
    }
    if speech_percentage < config.min_speech_percentage {
        return Err(RecordingRejectionReason::NoSpeechDetected);
    }

    Ok(())
}

fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_squares: f32 = samples.iter().map(|s| s * s).sum();
    (sum_squares / samples.len() as f32).sqrt()
}

fn calculate_rms_i16(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let scale = 1.0 / i16::MAX as f64;
    let sum_squares: f64 = samples
        .iter()
        .map(|s| {
            let value = *s as f64 * scale;
            value * value
        })
        .sum();
    ((sum_squares / samples.len() as f64).sqrt()) as f32
}

fn vad_sample_rate(sample_rate: u32) -> Option<VadSampleRate> {
    match sample_rate {
        8000 => Some(VadSampleRate::Rate8kHz),
        16000 => Some(VadSampleRate::Rate16kHz),
        32000 => Some(VadSampleRate::Rate32kHz),
        48000 => Some(VadSampleRate::Rate48kHz),
        _ => None,
    }
}

fn create_vad(sample_rate: u32, mode: VadMode) -> Option<Vad> {
    let rate = vad_sample_rate(sample_rate)?;
    Some(Vad::new_with_rate_and_mode(rate, mode))
}

fn calculate_speech_percentage_with_mode(samples: &[f32], sample_rate: u32, mode: VadMode) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let vad_rate = match sample_rate {
        8000 | 16000 | 32000 | 48000 => sample_rate,
        _ => 16000,
    };

    let analysis = if vad_rate == sample_rate {
        samples.to_vec()
    } else {
        resample_audio(samples, sample_rate, vad_rate)
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

    let mut vad = match create_vad(vad_rate, mode) {
        Some(instance) => instance,
        None => return 100.0, // If VAD fails, assume it's valid
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

pub fn quiet_cut_index(samples: &[i16], sample_rate: u32) -> usize {
    let len = samples.len();
    let rate = sample_rate.max(1) as usize;
    let window = (len / 10).clamp(rate, rate * 20);
    let frame = (rate * 150) / 1000;
    let step = (rate * 50) / 1000;
    if frame == 0 || step == 0 || len <= window + frame {
        return len;
    }

    let floor = len - window;
    let mut best_end = len;
    let mut best_energy = u64::MAX;
    let mut frame_end = len;
    while frame_end >= floor + frame {
        let energy: u64 = samples[frame_end - frame..frame_end]
            .iter()
            .map(|s| (*s as i64).unsigned_abs())
            .sum();
        if energy < best_energy {
            best_energy = energy;
            best_end = frame_end;
        }
        frame_end -= step;
    }

    best_end - frame / 2
}

pub fn speech_percentage_i16_with_mode(samples: &[i16], sample_rate: u32, mode: VadMode) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    if matches!(sample_rate, 8000 | 16000 | 32000 | 48000) {
        return calculate_speech_percentage_i16_with_mode(samples, sample_rate, mode);
    }

    let scale = 1.0 / i16::MAX as f32;
    let samples_f32: Vec<f32> = samples
        .iter()
        .map(|sample| *sample as f32 * scale)
        .collect();

    calculate_speech_percentage_with_mode(&samples_f32, sample_rate, mode)
}

fn calculate_speech_percentage_i16_with_mode(
    samples: &[i16],
    sample_rate: u32,
    mode: VadMode,
) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let frame_ms = 30usize;
    let frame_len = (sample_rate as usize * frame_ms) / 1000;
    if frame_len == 0 || samples.len() < frame_len {
        return 0.0;
    }

    let mut vad = match create_vad(sample_rate, mode) {
        Some(instance) => instance,
        None => return 100.0, // If VAD fails, assume it's valid
    };

    let mut speech_frames = 0;
    let mut total_frames = 0;
    for chunk in samples.chunks(frame_len) {
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

const WAV_SAMPLE_RATE: u32 = 16_000;
const WAV_CHANNELS: u16 = 1;
const WAV_BITS_PER_SAMPLE: u16 = 16;

pub fn persist_recording(
    base_dir: PathBuf,
    recording: &CompletedRecording,
) -> Result<RecordingSaved> {
    if recording.samples.is_empty() {
        return Err(anyhow!("Recording buffer is empty"));
    }

    let date_dir = recording.started_at.format("%Y-%m-%d").to_string();
    let timestamp = recording.started_at.format("%H%M%S").to_string();
    let millis = recording.started_at.timestamp_subsec_millis();
    let suffix = Uuid::new_v4().simple().to_string();

    let folder = base_dir.join(date_dir);
    fs::create_dir_all(&folder)
        .with_context(|| format!("Failed to create recording folder at {}", folder.display()))?;
    let file_path = folder.join(format!("{timestamp}-{millis:03}-{suffix}.wav"));

    let wav_samples = prepare_wav_samples(
        &recording.samples,
        recording.sample_rate,
        recording.channels,
    );
    if wav_samples.is_empty() {
        return Err(anyhow!("Recording buffer is empty"));
    }

    let duration_override_seconds = Some(wav_samples.len() as f32 / WAV_SAMPLE_RATE as f32);

    let wav_bytes = encode_to_wav(&wav_samples, WAV_SAMPLE_RATE, WAV_CHANNELS)?;
    fs::write(&file_path, wav_bytes)
        .with_context(|| format!("Failed to write recording file at {}", file_path.display()))?;

    Ok(RecordingSaved {
        path: file_path,
        started_at: recording.started_at,
        ended_at: recording.ended_at,
        duration_override_seconds,
        pending_path: recording.pending_path.clone(),
    })
}

pub const PENDING_DIR_NAME: &str = ".pending";

pub fn recover_pending_recordings(base_dir: PathBuf) -> Vec<(RecordingSaved, CompletedRecording)> {
    let pending_dir = base_dir.join(PENDING_DIR_NAME);
    let entries = match fs::read_dir(&pending_dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let scan_started_at = Local::now();

    let mut recovered = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_partial = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.ends_with(".partial.wav"))
            .unwrap_or(false);
        if !is_partial {
            continue;
        }
        if started_at_from_partial_name(&path)
            .is_some_and(|started_at| started_at >= scan_started_at)
        {
            continue;
        }

        match recover_one_partial(&base_dir, &path) {
            Ok(Some(result)) => recovered.push(result),
            Ok(None) => {
                let _ = fs::remove_file(&path);
            }
            Err(err) => {
                tracing::error!("Failed to recover {}: {err}", path.display());
                let _ = fs::rename(&path, path.with_extension("wav.failed"));
            }
        }
    }

    recovered.sort_by_key(|item| std::cmp::Reverse(item.0.started_at));
    recovered
}

fn recover_one_partial(
    base_dir: &Path,
    path: &Path,
) -> Result<Option<(RecordingSaved, CompletedRecording)>> {
    let reader =
        hound::WavReader::open(path).map_err(|err| anyhow!("Unable to read partial WAV: {err}"))?;
    let spec = reader.spec();
    let raw_samples: Vec<i16> = reader
        .into_samples::<i16>()
        .filter_map(|sample| sample.ok())
        .collect();
    if raw_samples.is_empty() {
        return Ok(None);
    }

    let started_at = started_at_from_partial_name(path).unwrap_or_else(Local::now);
    let frames = raw_samples.len() / spec.channels.max(1) as usize;
    let duration = chrono::Duration::milliseconds(
        (frames as f64 / spec.sample_rate.max(1) as f64 * 1000.0) as i64,
    );
    let ended_at = started_at + duration;

    let processed = process_raw_samples(&raw_samples, spec.sample_rate, spec.channels);
    if processed.samples.is_empty() {
        return Ok(None);
    }

    let recording = CompletedRecording {
        samples: processed.samples,
        sample_rate: processed.sample_rate,
        channels: processed.channels,
        started_at,
        ended_at,
        pending_path: Some(path.to_path_buf()),
        speech_percentage: processed.speech_percentage,
    };

    let saved = persist_recording(base_dir.to_path_buf(), &recording)?;
    Ok(Some((saved, recording)))
}

fn started_at_from_partial_name(path: &Path) -> Option<DateTime<Local>> {
    let name = path.file_name()?.to_str()?;
    let millis: i64 = name.split('-').next()?.parse().ok()?;
    match Local.timestamp_millis_opt(millis) {
        chrono::LocalResult::Single(dt) => Some(dt),
        _ => None,
    }
}

fn prepare_wav_samples(samples: &[i16], sample_rate: u32, channels: u16) -> Vec<i16> {
    if samples.is_empty() {
        return Vec::new();
    }

    let mono_samples = if channels > 1 {
        downmix_to_mono(samples, channels as usize)
    } else {
        samples.to_vec()
    };

    if sample_rate == WAV_SAMPLE_RATE {
        return mono_samples;
    }

    let mono_f32: Vec<f32> = mono_samples
        .iter()
        .map(|s| *s as f32 / i16::MAX as f32)
        .collect();
    let resampled = resample_audio(&mono_f32, sample_rate, WAV_SAMPLE_RATE);
    resampled
        .into_iter()
        .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
        .collect()
}

fn encode_to_wav(samples: &[i16], sample_rate: u32, channels: u16) -> Result<Vec<u8>> {
    if samples.is_empty() {
        return Err(anyhow!("Recording buffer is empty"));
    }

    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: WAV_BITS_PER_SAMPLE,
        sample_format: hound::SampleFormat::Int,
    };

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)
            .map_err(|err| anyhow!("WAV writer init failed: {err}"))?;
        for sample in samples {
            writer
                .write_sample(*sample)
                .map_err(|err| anyhow!("WAV write error: {err}"))?;
        }
        writer
            .finalize()
            .map_err(|err| anyhow!("WAV finalize error: {err}"))?;
    }

    Ok(cursor.into_inner())
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
    let Some(profile) = GainProfile::from_samples(samples, frame_size) else {
        return;
    };

    let attack = 0.14f32;
    let release = 0.04f32;
    let mut gain = 1.0f32;

    for chunk in samples.chunks_mut(frame_size) {
        let rms = calculate_rms(chunk);
        let desired = profile.desired_gain(rms);
        let smoothing = if desired > gain { attack } else { release };
        gain += (desired - gain) * smoothing;
        for sample in chunk.iter_mut() {
            *sample *= gain;
        }
    }
}

struct GainProfile {
    speech_gate_rms: f32,
    target_rms: f32,
    max_gain: f32,
}

impl GainProfile {
    fn from_samples(samples: &[f32], frame_size: usize) -> Option<Self> {
        let mut frame_rms: Vec<f32> = samples.chunks(frame_size).map(calculate_rms).collect();
        if frame_rms.is_empty() {
            return None;
        }

        frame_rms.sort_by(|a, b| a.total_cmp(b));
        let noise_floor_rms = percentile_sorted(&frame_rms, 0.2).clamp(0.0008, 0.006);
        let speech_gate_rms = (noise_floor_rms * 2.5).clamp(0.0015, 0.03);
        let speech_rms = percentile_sorted(&frame_rms, 0.65).max(speech_gate_rms);
        let target_rms = if speech_rms < 0.06 { 0.20 } else { 0.18 };
        let noise_to_speech = noise_floor_rms / speech_rms.max(noise_floor_rms);
        let max_gain = if noise_to_speech > 0.15 { 3.0 } else { 5.0 };

        Some(Self {
            speech_gate_rms,
            target_rms,
            max_gain,
        })
    }

    fn desired_gain(&self, rms: f32) -> f32 {
        if rms < self.speech_gate_rms {
            return 1.0;
        }

        (self.target_rms / rms).clamp(0.6, self.max_gain)
    }
}

fn percentile_sorted(values: &[f32], percentile: f32) -> f32 {
    let index = ((values.len() - 1) as f32 * percentile.clamp(0.0, 1.0)).round() as usize;
    values[index]
}

fn apply_peak_limiter(samples: &mut [f32]) {
    if samples.is_empty() {
        return;
    }

    let peak = samples
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0f32, f32::max);
    let ceiling = 0.95f32;
    if peak <= ceiling {
        return;
    }

    let gain = ceiling / peak;
    for sample in samples.iter_mut() {
        *sample *= gain;
    }
}

/// Returns the trimmed samples plus the speech percentage of the kept audio,
/// so validation can reuse this VAD pass instead of running its own. Returns
/// None when no usable measurement was made (e.g. no speech detected here -
/// compression/normalization may still surface quiet speech for validation).
fn trim_silence(samples: &[f32], sample_rate: u32) -> (Vec<f32>, Option<f32>) {
    if samples.is_empty() {
        return (Vec::new(), None);
    }

    let vad_rate = match sample_rate {
        8000 | 16000 | 32000 | 48000 => sample_rate,
        _ => 16000,
    };

    let to_i16 = |s: &f32| (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
    let analysis_i16: Vec<i16> = if vad_rate == sample_rate {
        samples.iter().map(to_i16).collect()
    } else {
        resample_audio(samples, sample_rate, vad_rate)
            .iter()
            .map(to_i16)
            .collect()
    };

    let frame_ms = 30usize;
    let frame_len = (vad_rate as usize * frame_ms) / 1000;
    if frame_len == 0 || analysis_i16.len() < frame_len {
        return (samples.to_vec(), None);
    }

    let mut vad = match create_vad(vad_rate, VadMode::Quality) {
        Some(instance) => instance,
        None => return (samples.to_vec(), None),
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
        return (samples.to_vec(), None);
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
            } else if let Some(start) = run_start.take()
                && idx - start <= min_gap_frames
            {
                for item in keep_mask.iter_mut().take(idx).skip(start) {
                    *item = true;
                }
            }
        }
        if let Some(start) = run_start.take()
            && keep_mask.len() - start <= min_gap_frames
        {
            for item in keep_mask.iter_mut().skip(start) {
                *item = true;
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

    // Speech share of the kept frames, mirroring what a VAD pass over the
    // trimmed output would measure.
    let voiced_count = speech_frames.iter().filter(|flag| **flag).count();
    let kept_count = keep_mask.iter().filter(|flag| **flag).count();
    let speech_percentage = if kept_count == 0 {
        None
    } else {
        Some((voiced_count as f32 / kept_count as f32) * 100.0)
    };

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
        return (samples.to_vec(), speech_percentage);
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
        (samples.to_vec(), speech_percentage)
    } else {
        (output, speech_percentage)
    }
}

fn resample_audio(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
    if input.is_empty() {
        return Vec::new();
    }
    if in_rate == out_rate {
        return input.to_vec();
    }

    resample_with_rubato(input, in_rate, out_rate).unwrap_or_else(|| {
        tracing::error!(
            "rubato resampler failed ({in_rate}→{out_rate}); falling back to linear resampler"
        );
        resample_linear(input, in_rate, out_rate)
    })
}

fn resample_with_rubato(input: &[f32], in_rate: u32, out_rate: u32) -> Option<Vec<f32>> {
    let mut resampler = Fft::<f32>::new(
        in_rate as usize,
        out_rate as usize,
        1024,
        1,
        FixedSync::Both,
    )
    .ok()?;

    let input_adapter = InterleavedSlice::new(input, 1, input.len()).ok()?;
    let output_capacity = resampler.process_all_needed_output_len(input.len());
    let mut output = vec![0.0f32; output_capacity];
    let mut output_adapter = InterleavedSlice::new_mut(&mut output, 1, output_capacity).ok()?;
    let (_, output_len) = resampler
        .process_all_into_buffer(&input_adapter, &mut output_adapter, input.len(), None)
        .ok()?;

    output.truncate(output_len);
    Some(output)
}

fn resample_linear(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
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

fn build_mic_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    buffer: &Arc<Mutex<Vec<i16>>>,
    spectrum: &Arc<Mutex<AudioSpectrumState>>,
    armed: &Arc<AtomicBool>,
) -> Result<Stream, cpal::Error>
where
    T: SizedSample + 'static,
    i16: FromSample<T>,
    f32: FromSample<T>,
{
    let buffer = Arc::clone(buffer);
    let spectrum = Arc::clone(spectrum);
    let armed = Arc::clone(armed);
    let channels = (config.channels as usize).max(1);
    device.build_input_stream(
        config,
        move |data: &[T], _| push_samples(data, &buffer, &spectrum, &armed, channels),
        |err| tracing::error!("Microphone stream error: {err}"),
        None,
    )
}

fn push_samples<T>(
    data: &[T],
    buffer: &Mutex<Vec<i16>>,
    spectrum: &Mutex<AudioSpectrumState>,
    armed: &AtomicBool,
    channels: usize,
) where
    T: Sample,
    i16: FromSample<T>,
    f32: FromSample<T>,
{
    if let Some(mut analysis) = spectrum.try_lock() {
        for frame in data.chunks(channels) {
            let mono: f32 = frame
                .iter()
                .map(|&sample| f32::from_sample(sample).clamp(-1.0, 1.0))
                .sum();
            analysis.push_sample(mono / frame.len() as f32);
        }
    }

    if !armed.load(Ordering::Relaxed) {
        let peak = data
            .iter()
            .map(|&sample| f32::from_sample(sample).abs())
            .fold(0.0_f32, f32::max);
        if peak < ARM_SIGNAL_FLOOR {
            return;
        }
        armed.store(true, Ordering::Relaxed);
    }

    let mut writer = buffer.lock();
    writer.extend(data.iter().map(|&sample| i16::from_sample(sample)));
}

pub(crate) fn downmix_to_mono(samples: &[i16], channels: usize) -> Vec<i16> {
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
