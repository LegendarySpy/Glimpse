use std::{borrow::Cow, fs, path::PathBuf, sync::Arc};

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Local};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};
use crossbeam_channel::{bounded, unbounded, Sender};
use mp3lame_encoder::{Bitrate, Builder as LameBuilder, FlushNoGap, InterleavedPcm, MonoPcm, Quality};
use parking_lot::Mutex;

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
                        RecorderCommand::Start { respond } => {
                            let _ = respond.send(core.start());
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

    pub fn start(&self) -> Result<DateTime<Local>> {
        let (respond_tx, respond_rx) = bounded(1);
        self.tx
            .send(RecorderCommand::Start { respond: respond_tx })
            .map_err(|err| anyhow!("Recorder channel closed: {err}"))?;
        respond_rx
            .recv()
            .map_err(|err| anyhow!("Recorder not responding: {err}"))?
    }

    pub fn stop(&self) -> Result<Option<CompletedRecording>> {
        let (respond_tx, respond_rx) = bounded(1);
        self.tx
            .send(RecorderCommand::Stop { respond: respond_tx })
            .map_err(|err| anyhow!("Recorder channel closed: {err}"))?;
        respond_rx
            .recv()
            .map_err(|err| anyhow!("Recorder not responding: {err}"))?
    }
}

enum RecorderCommand {
    Start {
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
    fn start(&mut self) -> Result<DateTime<Local>> {
        if self.active.is_some() {
            return Err(anyhow!("Recording is already in progress"));
        }

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .context("No default input device found")?;
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
            let mut samples = Arc::try_unwrap(active.buffer)
                .map(|mutex| mutex.into_inner())
                .unwrap_or_else(|arc| arc.lock().clone());

            normalize_samples(&mut samples);

            Ok(Some(CompletedRecording {
                samples,
                sample_rate: active.sample_rate,
                channels: active.channels,
                started_at: active.started_at,
                ended_at: Local::now(),
            }))
        } else {
            Ok(None)
        }
    }
}

pub fn persist_recording(base_dir: PathBuf, recording: CompletedRecording) -> Result<RecordingSaved> {
    if recording.samples.is_empty() {
        return Err(anyhow!("Recording buffer is empty"));
    }

    let date_dir = recording.started_at.format("%Y-%m-%d").to_string();
    let timestamp = recording.started_at.format("%H%M%S").to_string();

    let folder = base_dir.join(date_dir);
    fs::create_dir_all(&folder)
        .with_context(|| format!("Failed to create recording folder at {}", folder.display()))?;
    let file_path = folder.join(format!("{}.mp3", timestamp));

    let mp3_bytes = encode_to_mp3(&recording.samples, recording.sample_rate, recording.channels)?;
    fs::write(&file_path, mp3_bytes)
        .with_context(|| format!("Failed to write recording file at {}", file_path.display()))?;

    Ok(RecordingSaved {
        path: file_path,
        started_at: recording.started_at,
        ended_at: recording.ended_at,
    })
}

fn encode_to_mp3(samples: &[i16], sample_rate: u32, channels: u16) -> Result<Vec<u8>> {
    let mut builder = LameBuilder::new().ok_or_else(|| anyhow!("Failed to initialize MP3 encoder"))?;
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
        .set_brate(Bitrate::Kbps192)
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

fn normalize_samples(samples: &mut [i16]) {
    if samples.is_empty() {
        return;
    }

    let peak = samples
        .iter()
        .map(|sample| (i32::from(*sample)).abs() as f32)
        .fold(0.0f32, f32::max);

    if peak <= 0.0 {
        return;
    }

    let target = i16::MAX as f32 * 0.92; // leave a little headroom to avoid clipping
    let gain = (target / peak).clamp(0.25, 20.0);

    if (gain - 1.0).abs() < 0.01 {
        return;
    }

    for sample in samples.iter_mut() {
        let scaled = (*sample as f32) * gain;
        *sample = scaled
            .clamp(-(i16::MAX as f32), i16::MAX as f32)
            .round() as i16;
    }
}
