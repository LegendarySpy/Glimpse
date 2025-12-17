use std::path::PathBuf;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use transcribe_rs::{
    engines::{
        moonshine::{ModelVariant as MoonshineModelVariant, MoonshineEngine, MoonshineModelParams},
        parakeet::{ParakeetEngine, ParakeetModelParams},
        whisper::{WhisperEngine, WhisperInferenceParams},
    },
    TranscriptionEngine,
};

use crate::{
    model_manager::{self, LocalModelEngine, ReadyModel},
    transcription::{normalize_transcript, TranscriptionSuccess},
};

pub struct LocalTranscriber {
    inner: Mutex<Option<LoadedEngine>>,
}

struct LoadedEngine {
    key: String,
    path: PathBuf,
    engine: EngineInstance,
}

enum EngineInstance {
    Parakeet { engine: ParakeetEngine },
    Whisper { engine: WhisperEngine },
    Moonshine { engine: MoonshineEngine },
}

struct PreparedAudio {
    pub data: Vec<f32>,
}

impl LocalTranscriber {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub fn transcribe(
        &self,
        model: &ReadyModel,
        samples: &[i16],
        sample_rate: u32,
        initial_prompt: Option<&str>,
        language: Option<&str>,
    ) -> Result<TranscriptionSuccess> {
        self.ensure_engine(model)?;
        let prepared = prepare_audio(samples, sample_rate);
        let model_label = model_manager::definition(&model.key)
            .map(|def| def.label.to_string())
            .unwrap_or_else(|| model.key.clone());

        let mut guard = self.inner.lock();
        let loaded = guard
            .as_mut()
            .ok_or_else(|| anyhow!("Local model not available"))?;

        let transcript = match &mut loaded.engine {
            EngineInstance::Parakeet { engine, .. } => {
                let result = engine
                    .transcribe_samples(prepared.data.clone(), None)
                    .map_err(|err| anyhow!("Parakeet transcription failed: {err}"))?;
                result.text
            }
            EngineInstance::Whisper { engine } => {
                let params = if initial_prompt.is_some() || language.is_some() {
                    Some(WhisperInferenceParams {
                        initial_prompt: initial_prompt.map(|s| s.to_string()),
                        language: language.map(|s| s.to_string()),
                        ..Default::default()
                    })
                } else {
                    None
                };

                let result = engine
                    .transcribe_samples(prepared.data.clone(), params)
                    .map_err(|err| anyhow!("Whisper transcription failed: {err}"))?;
                result.text
            }
            EngineInstance::Moonshine { engine } => {
                let result = engine
                    .transcribe_samples(prepared.data.clone(), None)
                    .map_err(|err| anyhow!("Moonshine transcription failed: {err}"))?;
                result.text
            }
        };

        Ok(TranscriptionSuccess {
            transcript: normalize_transcript(&transcript),
            speech_model: Some(model_label),
        })
    }

    fn ensure_engine(&self, model: &ReadyModel) -> Result<()> {
        {
            let guard = self.inner.lock();
            if let Some(current) = guard.as_ref() {
                if current.key == model.key && current.path == model.path {
                    return Ok(());
                }
            }
        }

        let engine = match &model.engine {
            LocalModelEngine::Parakeet { quantized } => {
                let mut engine = ParakeetEngine::new();
                let params = if *quantized {
                    ParakeetModelParams::int8()
                } else {
                    ParakeetModelParams::fp32()
                };
                engine
                    .load_model_with_params(model.path.as_path(), params)
                    .map_err(|err| anyhow!("Failed to load Parakeet model: {err}"))?;
                EngineInstance::Parakeet { engine }
            }
            LocalModelEngine::Whisper => {
                let mut engine = WhisperEngine::new();
                engine
                    .load_model(model.path.as_path())
                    .map_err(|err| anyhow!("Failed to load Whisper model: {err}"))?;
                EngineInstance::Whisper { engine }
            }
            LocalModelEngine::Moonshine { variant } => {
                use crate::model_manager::MoonshineVariant;
                let mut engine = MoonshineEngine::new();
                let model_variant = match variant {
                    MoonshineVariant::Tiny => MoonshineModelVariant::Tiny,
                    MoonshineVariant::Base => MoonshineModelVariant::Base,
                };
                engine
                    .load_model_with_params(
                        model.path.as_path(),
                        MoonshineModelParams::variant(model_variant),
                    )
                    .map_err(|err| anyhow!("Failed to load Moonshine model: {err}"))?;
                EngineInstance::Moonshine { engine }
            }
        };

        let mut guard = self.inner.lock();
        *guard = Some(LoadedEngine {
            key: model.key.clone(),
            path: model.path.clone(),
            engine,
        });

        Ok(())
    }
}

impl Default for LocalTranscriber {
    fn default() -> Self {
        Self::new()
    }
}

fn prepare_audio(samples: &[i16], sample_rate: u32) -> PreparedAudio {
    let normalized: Vec<f32> = samples
        .iter()
        .map(|sample| *sample as f32 / i16::MAX as f32)
        .collect();

    let mut data = if sample_rate == 16_000 {
        normalized
    } else {
        resample_linear(&normalized, sample_rate.max(1), 16_000)
    };

    const MIN_SAMPLES: usize = 16_000;
    const EXTRA_PADDING: usize = 4_000;

    let padding_needed = MIN_SAMPLES.saturating_sub(data.len()) + EXTRA_PADDING;
    data.extend(std::iter::repeat(0.0f32).take(padding_needed));

    PreparedAudio { data }
}

fn resample_linear(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    if from_rate == 0 || to_rate == 0 || from_rate == to_rate {
        return samples.to_vec();
    }

    let ratio = to_rate as f64 / from_rate as f64;
    let target_len = ((samples.len() as f64) * ratio).ceil().max(1.0) as usize;
    let last_index = samples.len() - 1;
    let mut output = Vec::with_capacity(target_len);

    for idx in 0..target_len {
        let src_pos = idx as f64 / ratio;
        let base = src_pos.floor() as usize;
        let frac = (src_pos - base as f64) as f32;
        let current = samples[base.min(last_index)];
        let next = samples[(base + 1).min(last_index)];
        output.push(current + (next - current) * frac);
    }

    output
}
