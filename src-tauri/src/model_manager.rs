use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::downloader::{download_model_files, ModelFileDescriptor};

const MODELS_ROOT: &str = "models";

#[derive(Debug, Clone)]
pub enum ModelStorage {
    Directory,
    File { artifact: &'static str },
}

#[derive(Debug, Clone)]
pub enum LocalModelEngine {
    Parakeet { quantized: bool },
    Whisper,
}

#[derive(Debug, Clone)]
pub struct ModelDefinition {
    pub key: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub size_mb: f32,
    pub files: &'static [ModelFileDescriptor],
    pub engine: LocalModelEngine,
    pub variant: &'static str,
    pub storage: ModelStorage,
    pub tags: &'static [&'static str],
}

#[derive(Debug, Clone)]
pub struct ReadyModel {
    pub key: String,
    pub path: PathBuf,
    pub engine: LocalModelEngine,
}

const PARAKEET_TDT_FP32_FILES: [ModelFileDescriptor; 6] = [
    ModelFileDescriptor {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/config.json",
        name: "config.json",
    },
    ModelFileDescriptor {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.onnx",
        name: "encoder-model.onnx",
    },
    ModelFileDescriptor {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.onnx.data",
        name: "encoder-model.onnx.data",
    },
    ModelFileDescriptor {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/decoder_joint-model.onnx",
        name: "decoder_joint-model.onnx",
    },
    ModelFileDescriptor {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/nemo128.onnx",
        name: "nemo128.onnx",
    },
    ModelFileDescriptor {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/vocab.txt",
        name: "vocab.txt",
    },
];

const PARAKEET_TDT_INT8_FILES: [ModelFileDescriptor; 5] = [
    ModelFileDescriptor {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/config.json",
        name: "config.json",
    },
    ModelFileDescriptor {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.int8.onnx",
        name: "encoder-model.int8.onnx",
    },
    ModelFileDescriptor {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/decoder_joint-model.int8.onnx",
        name: "decoder_joint-model.int8.onnx",
    },
    ModelFileDescriptor {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/nemo128.onnx",
        name: "nemo128.onnx",
    },
    ModelFileDescriptor {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/vocab.txt",
        name: "vocab.txt",
    },
];

const WHISPER_SMALL_Q5_FILES: [ModelFileDescriptor; 1] = [ModelFileDescriptor {
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
    name: "ggml-small-q5_1.bin",
}];

const WHISPER_MEDIUM_Q4_FILES: [ModelFileDescriptor; 1] = [ModelFileDescriptor {
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q4_1.bin",
    name: "ggml-medium-q4_1.bin",
}];

pub const MODEL_DEFINITIONS: &[ModelDefinition] = &[
    ModelDefinition {
        key: "parakeet_tdt_int8",
        label: "Parakeet TDT 0.6B",
        description: "Fast multilingual transcription with NVIDIA's quantized Parakeet model.",
        size_mb: 980.0,
        files: &PARAKEET_TDT_INT8_FILES,
        engine: LocalModelEngine::Parakeet { quantized: true },
        variant: "Int8 Quantized",
        storage: ModelStorage::Directory,
        tags: &["Multilingual", "Fast"],
    },
    ModelDefinition {
        key: "parakeet_tdt_fp32",
        label: "Parakeet TDT 0.6B",
        description: "Highest accuracy Parakeet model with full-precision weights.",
        size_mb: 1350.0,
        files: &PARAKEET_TDT_FP32_FILES,
        engine: LocalModelEngine::Parakeet { quantized: false },
        variant: "FP32 Precision",
        storage: ModelStorage::Directory,
        tags: &["Multilingual", "High Accuracy"],
    },

    ModelDefinition {
        key: "whisper_small_q5",
        label: "Whisper Small",
        description: "CPU-friendly, supports custom words.",
        size_mb: 480.0,
        files: &WHISPER_SMALL_Q5_FILES,
        engine: LocalModelEngine::Whisper,
        variant: "Q5_1",
        storage: ModelStorage::File { artifact: "ggml-small-q5_1.bin" },
        tags: &["English", "Custom Words", "CPU Friendly"],
    },
    ModelDefinition {
        key: "whisper_medium_q4",
        label: "Whisper Medium",
        description: "Best quality local Whisper model with multilingual support, supports custom words.",
        size_mb: 1500.0,
        files: &WHISPER_MEDIUM_Q4_FILES,
        engine: LocalModelEngine::Whisper,
        variant: "Q4_1",
        storage: ModelStorage::File { artifact: "ggml-medium-q4_1.bin" },
        tags: &["Multilingual", "Custom Words", "Balanced"],
    },
];

pub fn definition(key: &str) -> Option<&'static ModelDefinition> {
    MODEL_DEFINITIONS.iter().find(|def| def.key == key)
}

pub fn get_model_dir<R: Runtime>(app: &AppHandle<R>, key: &str) -> Result<PathBuf> {
    let mut dir = app
        .path()
        .app_data_dir()
        .context("Unable to resolve app data directory")?;
    dir.push(MODELS_ROOT);
    dir.push(key);
    Ok(dir)
}

fn ensure_models_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let mut dir = app
        .path()
        .app_data_dir()
        .context("Unable to resolve app data directory")?;
    dir.push(MODELS_ROOT);
    fs::create_dir_all(&dir).context("Failed to prepare models directory")?;
    Ok(dir)
}

fn artifact_path(dir: &Path, storage: &ModelStorage) -> PathBuf {
    match storage {
        ModelStorage::Directory => dir.to_path_buf(),
        ModelStorage::File { artifact } => dir.join(artifact),
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct ModelInfo {
    pub key: String,
    pub label: String,
    pub description: String,
    pub size_mb: f32,
    pub file_count: usize,
    pub engine: String,
    pub variant: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ModelStatus {
    pub key: String,
    pub installed: bool,
    pub bytes_on_disk: u64,
    pub missing_files: Vec<String>,
    pub directory: String,
}

impl ModelStatus {
    fn from_definition(dir: &Path, def: &ModelDefinition) -> Self {
        let missing_files = missing_files(dir, def);
        let installed = missing_files.is_empty() && dir.exists();
        let bytes_on_disk = if dir.exists() {
            calculate_dir_size(dir).unwrap_or(0)
        } else {
            0
        };
        let artifact = artifact_path(dir, &def.storage);

        Self {
            key: def.key.to_string(),
            installed,
            bytes_on_disk,
            missing_files,
            directory: artifact.display().to_string(),
        }
    }
}

fn missing_files(dir: &Path, def: &ModelDefinition) -> Vec<String> {
    def.files
        .iter()
        .filter_map(|descriptor| {
            let file_path = dir.join(descriptor.name);
            if file_path.exists() {
                None
            } else {
                Some(descriptor.name.to_string())
            }
        })
        .collect()
}

fn calculate_dir_size(dir: &Path) -> Result<u64> {
    let mut total = 0u64;
    if dir.is_dir() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                total += calculate_dir_size(&entry.path())?;
            } else {
                total += metadata.len();
            }
        }
    }
    Ok(total)
}

fn engine_label(engine: &LocalModelEngine) -> &'static str {
    match engine {
        LocalModelEngine::Parakeet { .. } => "Parakeet (ONNX)",
        LocalModelEngine::Whisper => "Whisper (GGML)",
    }
}

#[tauri::command]
pub fn list_models() -> Vec<ModelInfo> {
    MODEL_DEFINITIONS
        .iter()
        .map(|def| ModelInfo {
            key: def.key.to_string(),
            label: def.label.to_string(),
            description: def.description.to_string(),
            size_mb: def.size_mb,
            file_count: def.files.len(),
            engine: engine_label(&def.engine).to_string(),
            variant: def.variant.to_string(),
            tags: def.tags.iter().map(|s| s.to_string()).collect(),
        })
        .collect()
}

#[tauri::command]
pub fn check_model_status<R: Runtime>(app: AppHandle<R>, model: String) -> Result<ModelStatus, String> {
    let def = definition(&model).ok_or_else(|| "Unknown model".to_string())?;
    let dir = get_model_dir(&app, &model).map_err(|err| err.to_string())?;
    Ok(ModelStatus::from_definition(&dir, def))
}

#[tauri::command]
pub async fn download_model<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, crate::AppState>,
    model: String,
) -> Result<ModelStatus, String> {
    let def = definition(&model).ok_or_else(|| "Unknown model".to_string())?;
    ensure_models_root(&app).map_err(|err| err.to_string())?;
    let dir = get_model_dir(&app, &model).map_err(|err| err.to_string())?;
    let client = state.http();

    download_model_files(&app, &client, &model, def.files, &dir)
        .await
        .map_err(|err| err.to_string())?;

    Ok(ModelStatus::from_definition(&dir, def))
}

#[tauri::command]
pub fn delete_model<R: Runtime>(app: AppHandle<R>, model: String) -> Result<ModelStatus, String> {
    let def = definition(&model).ok_or_else(|| "Unknown model".to_string())?;
    let dir = get_model_dir(&app, &model).map_err(|err| err.to_string())?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|err| err.to_string())?;
    }
    Ok(ModelStatus::from_definition(&dir, def))
}

pub fn ensure_model_ready<R: Runtime>(app: &AppHandle<R>, model: &str) -> Result<ReadyModel> {
    let def = definition(model).ok_or_else(|| anyhow!("Unknown model"))?;
    let dir = get_model_dir(app, model)?;
    let status = ModelStatus::from_definition(&dir, def);
    if !status.installed {
        return Err(anyhow!(
            "{} is not fully installed. Missing: {}",
            def.label,
            status.missing_files.join(", ")
        ));
    }

    Ok(ReadyModel {
        key: def.key.to_string(),
        path: artifact_path(&dir, &def.storage),
        engine: def.engine.clone(),
    })
}