use glimpse_speech::models::{InstallSpec, ModelLayout, ModelStorage, RemoteFile};
use serde::Serialize;
use tauri::AppHandle;

use crate::AppRuntime;
use crate::model_language_table::{
    SupportedLanguageInfo, english_supported_languages, whisper_supported_languages,
};
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
use crate::model_language_table::{
    nemotron_35_supported_languages, nemotron_supported_languages, parakeet_v3_supported_languages,
};
use crate::settings::UserSettings;
use crate::speech::{install, remote};

pub const MODEL_CAPABILITY_DICTIONARY: &str = "dictionary";
pub const MODEL_CAPABILITY_TIMESTAMPS: &str = "timestamps";
pub const MODEL_CAPABILITY_STREAMING: &str = "streaming";
pub const MODEL_CAPABILITY_DIARIZATION: &str = "diarization";
pub const MODEL_CATEGORY_LEGACY: &str = "legacy";

pub fn is_legacy_category(category: &str) -> bool {
    category.eq_ignore_ascii_case(MODEL_CATEGORY_LEGACY)
}

pub fn is_downloadable(manifest: &LocalModelManifest) -> bool {
    !is_legacy_category(manifest.category)
}

pub fn model_is_downloadable(key: &str) -> bool {
    definition(key).is_some_and(is_downloadable)
}

pub use glimpse_speech::models::ModelEngine as LocalModelEngine;

#[derive(Debug, Serialize, Clone)]
pub struct ModelInfo {
    pub key: String,
    pub label: String,
    pub description: String,
    pub size_mb: f32,
    pub engine_id: String,
    pub family: String,
    pub variant: String,
    pub category: String,
    pub downloadable: bool,
    pub tags: Vec<String>,
    pub capabilities: Vec<String>,
    pub supported_languages: Vec<SupportedLanguageInfo>,
    pub ane_size_mb: Option<f32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SpeechModel {
    pub id: String,
    pub key: String,
    pub label: String,
    pub description: String,
    pub size_mb: f32,
    pub engine_id: String,
    pub variant: String,
    pub tags: Vec<String>,
    pub capabilities: Vec<String>,
    pub supported_languages: Vec<SupportedLanguageInfo>,
    pub remote: bool,
    pub installed: bool,
}

struct CatalogFile {
    url: &'static str,
    path: &'static str,
    size_bytes: Option<u64>,
    sha256: Option<&'static str>,
}

pub struct LocalModelManifest {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub tags: &'static [&'static str],
    pub engine: LocalModelEngine,
    pub family: &'static str,
    pub variant: &'static str,
    files: &'static [CatalogFile],
    pub capabilities: &'static [&'static str],
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const PARAKEET_TDT_INT8_FILES: &[CatalogFile] = &[
    CatalogFile {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.int8.onnx",
        path: "encoder-model.int8.onnx",
        size_bytes: Some(652_183_999),
        sha256: Some("6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09"),
    },
    CatalogFile {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/decoder_joint-model.int8.onnx",
        path: "decoder_joint-model.int8.onnx",
        size_bytes: Some(18_202_004),
        sha256: Some("eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70"),
    },
    CatalogFile {
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/vocab.txt",
        path: "vocab.txt",
        size_bytes: Some(93_939),
        sha256: Some("d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
    },
];

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const PARAKEET_UNIFIED_INT8_FILES: &[CatalogFile] = &[
    CatalogFile {
        url: "https://huggingface.co/bobNight/parakeet-unified-en-0.6b-onnx/resolve/main/encoder.int8.onnx",
        path: "encoder.int8.onnx",
        size_bytes: Some(42_606_669),
        sha256: Some("c81adfab77634e00c1668a221a14f244c5fb3409e7c14eeebaf6ac963425910f"),
    },
    CatalogFile {
        url: "https://huggingface.co/bobNight/parakeet-unified-en-0.6b-onnx/resolve/main/encoder.int8.onnx.data",
        path: "encoder.int8.onnx.data",
        size_bytes: Some(611_491_584),
        sha256: Some("3d54dd04646c15677bd2844a84df3770b12cc1ce183481f7b6e0def31c92114a"),
    },
    CatalogFile {
        url: "https://huggingface.co/bobNight/parakeet-unified-en-0.6b-onnx/resolve/main/decoder_joint.int8.onnx",
        path: "decoder_joint.int8.onnx",
        size_bytes: Some(8_995_064),
        sha256: Some("7f76ad5f35035f25630075699c6c942a2c0c05ff42cb398f966f3c256d148e1e"),
    },
    CatalogFile {
        url: "https://huggingface.co/bobNight/parakeet-unified-en-0.6b-onnx/resolve/main/tokenizer.model",
        path: "tokenizer.model",
        size_bytes: Some(251_056),
        sha256: Some("07d4e5a63840a53ab2d4d106d2874768143fb3fbdd47938b3910d2da05bfb0a9"),
    },
];

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const NEMOTRON_STREAMING_FILES: &[CatalogFile] = &[
    CatalogFile {
        url: "https://huggingface.co/altunenes/parakeet-rs/resolve/main/nemotron-speech-streaming-en-0.6b/encoder.onnx",
        path: "encoder.onnx",
        size_bytes: Some(42_159_995),
        sha256: Some("5c5110ca2e961c3ff5edc2b0ff49f29888b5213287624f7865c60f7384ac02f0"),
    },
    CatalogFile {
        url: "https://huggingface.co/altunenes/parakeet-rs/resolve/main/nemotron-speech-streaming-en-0.6b/encoder.onnx.data",
        path: "encoder.onnx.data",
        size_bytes: Some(2_436_567_040),
        sha256: Some("44f65771e1570546f61106b3d0c604a60b398d061476fda8042bb05432601bd4"),
    },
    CatalogFile {
        url: "https://huggingface.co/altunenes/parakeet-rs/resolve/main/nemotron-speech-streaming-en-0.6b/decoder_joint.onnx",
        path: "decoder_joint.onnx",
        size_bytes: Some(35_779_240),
        sha256: Some("8bcfde85fa9039a70caeb90204273f837923d63a706c186bd33e2ada25a91700"),
    },
    CatalogFile {
        url: "https://huggingface.co/altunenes/parakeet-rs/resolve/main/nemotron-speech-streaming-en-0.6b/tokenizer.model",
        path: "tokenizer.model",
        size_bytes: Some(251_056),
        sha256: Some("07d4e5a63840a53ab2d4d106d2874768143fb3fbdd47938b3910d2da05bfb0a9"),
    },
];

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const NEMOTRON_35_STREAMING_FILES: &[CatalogFile] = &[
    CatalogFile {
        url: "https://huggingface.co/altunenes/parakeet-rs/resolve/main/nemotron-3.5-asr-streaming-0.6b-onnx/encoder.onnx",
        path: "encoder.onnx",
        size_bytes: Some(42_164_972),
        sha256: Some("d569fbe78b48fbb04e169d324f5d25463838ceed7b5fc3bfe209872441979bd9"),
    },
    CatalogFile {
        url: "https://huggingface.co/altunenes/parakeet-rs/resolve/main/nemotron-3.5-asr-streaming-0.6b-onnx/encoder.onnx.data",
        path: "encoder.onnx.data",
        size_bytes: Some(2_454_405_120),
        sha256: Some("7584f85df76bc9ae6fbdfa53aa8d97b07a842525d1c501d536d77fd9e4f57ac7"),
    },
    CatalogFile {
        url: "https://huggingface.co/altunenes/parakeet-rs/resolve/main/nemotron-3.5-asr-streaming-0.6b-onnx/decoder_joint.onnx",
        path: "decoder_joint.onnx",
        size_bytes: Some(97_590_054),
        sha256: Some("634dfadf24cb4f73c2fae170b36611d68db48186426882cbc8f7e02ed9f2bb29"),
    },
    CatalogFile {
        url: "https://huggingface.co/altunenes/parakeet-rs/resolve/main/nemotron-3.5-asr-streaming-0.6b-onnx/tokenizer.model",
        path: "tokenizer.model",
        size_bytes: Some(406_554),
        sha256: Some("ce3895e40806f02a26c3a225161b96ef682d6c0054bae32a245dec4258d7d291"),
    },
];

macro_rules! whisper_files {
    ($path:literal, $size_bytes:literal, $sha256:expr_2021) => {
        &[CatalogFile {
            url: concat!(
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/",
                $path
            ),
            path: $path,
            size_bytes: Some($size_bytes),
            sha256: $sha256,
        }]
    };
}

macro_rules! distil_whisper_files {
    ($repo:literal, $path:literal, $size_bytes:literal, $sha256:expr_2021) => {
        &[CatalogFile {
            url: concat!("https://huggingface.co/", $repo, "/resolve/main/", $path),
            path: $path,
            size_bytes: Some($size_bytes),
            sha256: $sha256,
        }]
    };
}

const ANE_SUPPORTED: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

struct AneEncoder {
    family: &'static str,
    size_bytes: u64,
    sha256: &'static str,
}

impl AneEncoder {
    fn dir_name(&self) -> String {
        format!("ggml-{}-encoder.mlmodelc", self.family)
    }
}

const ANE_ENCODERS: &[AneEncoder] = &[
    AneEncoder {
        family: "tiny",
        size_bytes: 15_037_446,
        sha256: "c88cbd2648e1f5415092bcf5256add463a0f19943e6938f46e8d4ffdebd47739",
    },
    AneEncoder {
        family: "base",
        size_bytes: 37_922_638,
        sha256: "7e6ab77041942572f239b5b602f8aaa1c3ed29d73e3d8f20abea03a773541089",
    },
    AneEncoder {
        family: "small",
        size_bytes: 163_083_239,
        sha256: "de43fb9fed471e95c19e60ae67575c2bf09e8fb607016da171b06ddad313988b",
    },
    AneEncoder {
        family: "medium",
        size_bytes: 567_829_413,
        sha256: "79b0b8d436d47d3f24dd3afc91f19447dd686a4f37521b2f6d9c30a642133fbd",
    },
    AneEncoder {
        family: "large-v3",
        size_bytes: 1_175_711_232,
        sha256: "47837be7594a29429ec08620043390c4d6d467f8bd362df09e9390ace76a55a4",
    },
    AneEncoder {
        family: "large-v3-turbo",
        size_bytes: 1_173_393_014,
        sha256: "84bedfe895bd7b5de6e8e89a0803dfc5addf8c0c5bc4c937451716bf7cf7988a",
    },
];

// whisper.cpp strips "-qX_X" too, so one fp16 encoder serves every quant.
fn strip_quant_suffix(stem: &str) -> &str {
    if let Some(pos) = stem.rfind('-') {
        let suffix = &stem.as_bytes()[pos..];
        if suffix.len() == 5 && suffix[1] == b'q' && suffix[3] == b'_' {
            return &stem[..pos];
        }
    }
    stem
}

fn ane_encoder(manifest: &LocalModelManifest) -> Option<&'static AneEncoder> {
    if !ANE_SUPPORTED || manifest.engine != LocalModelEngine::Whisper {
        return None;
    }
    let [file] = manifest.files else {
        return None;
    };
    let family = strip_quant_suffix(file.path.strip_prefix("ggml-")?.strip_suffix(".bin")?);
    ANE_ENCODERS.iter().find(|encoder| encoder.family == family)
}

pub fn ane_encoder_dir(model: &str) -> Option<String> {
    definition(model)
        .and_then(ane_encoder)
        .map(AneEncoder::dir_name)
}

const WHISPER_DESCRIPTION: &str =
    "Local Whisper model with multilingual support and dictionary support.";
const DISTIL_WHISPER_DESCRIPTION: &str =
    "Fast English-only Distil-Whisper Q8 model. Dictionary support is limited.";
const WHISPER_CAPABILITIES: &[&str] = &[MODEL_CAPABILITY_DICTIONARY, MODEL_CAPABILITY_TIMESTAMPS];

const MODEL_MANIFESTS: &[LocalModelManifest] = &[
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    LocalModelManifest {
        id: "apple_speech",
        family: "apple-speech",
        label: "Apple Speech",
        description: "Built into this Mac. Nothing to download.",
        tags: &["Multilingual", "Built in"],
        category: "standard",
        engine: LocalModelEngine::Apple,
        variant: "System",
        files: &[],
        capabilities: &[MODEL_CAPABILITY_TIMESTAMPS],
    },
    LocalModelManifest {
        id: "whisper_large_v3_turbo_q8",
        family: "whisper-large-v3-turbo",
        label: "Whisper Large V3 Turbo",
        description: "Great quality local Whisper model with multilingual support and dictionary support.",
        tags: &["Dictionary", "Multilingual"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Q8_0",
        files: whisper_files!(
            "ggml-large-v3-turbo-q8_0.bin",
            874_188_075,
            Some("317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    LocalModelManifest {
        id: "parakeet_tdt_int8",
        family: "parakeet-tdt",
        label: "Parakeet TDT V3",
        description: "Fast, multilingual and accurate. Based on ONNX for everyday local transcription.",
        tags: &["Multilingual", "Fast"],
        category: "experimental",
        engine: LocalModelEngine::Parakeet,
        variant: "Int8",
        files: PARAKEET_TDT_INT8_FILES,
        capabilities: &[MODEL_CAPABILITY_TIMESTAMPS],
    },
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    LocalModelManifest {
        id: "parakeet_unified_en_int8",
        family: "parakeet-unified",
        label: "Parakeet Unified",
        description: "Fast English local transcription with streaming support.",
        tags: &["English", "Fast", "Streaming"],
        category: "experimental",
        engine: LocalModelEngine::Parakeet,
        variant: "Int8",
        files: PARAKEET_UNIFIED_INT8_FILES,
        capabilities: &[MODEL_CAPABILITY_TIMESTAMPS, MODEL_CAPABILITY_STREAMING],
    },
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    LocalModelManifest {
        id: "nemotron_streaming_en",
        family: "nemotron-streaming",
        label: "Nemotron Streaming",
        description: "Real-time streaming transcription. Text appears as you speak.",
        tags: &["English", "Streaming"],
        category: "legacy",
        engine: LocalModelEngine::Nemotron,
        variant: "Full",
        files: NEMOTRON_STREAMING_FILES,
        capabilities: &[MODEL_CAPABILITY_STREAMING],
    },
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    LocalModelManifest {
        id: "nemotron_35_streaming_multilingual",
        family: "nemotron-35-streaming",
        label: "Nemotron 3.5 Streaming",
        description: "Multilingual streaming transcription with punctuation and capitalization.",
        tags: &["Multilingual", "Streaming"],
        category: "experimental",
        engine: LocalModelEngine::Nemotron,
        variant: "Full",
        files: NEMOTRON_35_STREAMING_FILES,
        capabilities: &[MODEL_CAPABILITY_STREAMING],
    },
    LocalModelManifest {
        id: "whisper_small_q5",
        family: "whisper-small",
        label: "Whisper Small",
        description: "Small & fast with dictionary support.",
        tags: &["Multilingual", "Dictionary", "Compute Friendly"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Q5_1",
        files: whisper_files!(
            "ggml-small-q5_1.bin",
            190_085_487,
            Some("ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "distil_whisper_large_v35",
        family: "distil-large",
        label: "Distil-Whisper Large V3.5",
        description: DISTIL_WHISPER_DESCRIPTION,
        tags: &["English", "Fast"],
        category: "experimental",
        engine: LocalModelEngine::Whisper,
        variant: "Q8_0",
        files: distil_whisper_files!(
            "Pomni/distil-large-v3.5-ggml-allquants",
            "ggml-distil-large-v3.5-q8_0.bin",
            818_305_955,
            Some("7e570abdf13b681354a2ecc93802e25bf204dd6f8c0dd9f6ecb9478b71b231d7")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "distil_whisper_medium_en",
        family: "distil-medium",
        label: "Distil-Whisper Medium",
        description: DISTIL_WHISPER_DESCRIPTION,
        tags: &["English", "Fast"],
        category: "experimental",
        engine: LocalModelEngine::Whisper,
        variant: "Q8_0",
        files: distil_whisper_files!(
            "Pomni/distil-medium.en-ggml-allquants",
            "ggml-distil-medium.en-q8_0.bin",
            429_655_940,
            Some("8dff90cdf0124169e906aa05a208ba2bfc94e60d09b983ba87a60b9ea3aca42a")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "distil_whisper_small_en",
        family: "distil-small",
        label: "Distil-Whisper Small",
        description: DISTIL_WHISPER_DESCRIPTION,
        tags: &["English", "Fast", "Compute Friendly"],
        category: "experimental",
        engine: LocalModelEngine::Whisper,
        variant: "Q8_0",
        files: distil_whisper_files!(
            "Pomni/distil-small.en-ggml-allquants",
            "ggml-distil-small.en-q8_0.bin",
            183_833_897,
            Some("8564c3a318d354992fc4654044f48908514783209b4f09ff043ecb8a0c1ebe8e")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_tiny_q5",
        family: "whisper-tiny",
        label: "Whisper Tiny",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary", "Compute Friendly"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Q5_1",
        files: whisper_files!(
            "ggml-tiny-q5_1.bin",
            32_152_673,
            Some("818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_tiny_q8",
        family: "whisper-tiny",
        label: "Whisper Tiny",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary", "Compute Friendly"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Q8_0",
        files: whisper_files!(
            "ggml-tiny-q8_0.bin",
            43_537_433,
            Some("c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_tiny",
        family: "whisper-tiny",
        label: "Whisper Tiny",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary", "Compute Friendly"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Full",
        files: whisper_files!(
            "ggml-tiny.bin",
            77_691_713,
            Some("be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_base_q5",
        family: "whisper-base",
        label: "Whisper Base",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary", "Compute Friendly"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Q5_1",
        files: whisper_files!(
            "ggml-base-q5_1.bin",
            59_707_625,
            Some("422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_base_q8",
        family: "whisper-base",
        label: "Whisper Base",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary", "Compute Friendly"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Q8_0",
        files: whisper_files!(
            "ggml-base-q8_0.bin",
            81_768_585,
            Some("c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_base",
        family: "whisper-base",
        label: "Whisper Base",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary", "Compute Friendly"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Full",
        files: whisper_files!(
            "ggml-base.bin",
            147_951_465,
            Some("60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_small_q8",
        family: "whisper-small",
        label: "Whisper Small",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary", "Compute Friendly"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Q8_0",
        files: whisper_files!(
            "ggml-small-q8_0.bin",
            264_464_607,
            Some("49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_small",
        family: "whisper-small",
        label: "Whisper Small",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Full",
        files: whisper_files!(
            "ggml-small.bin",
            487_601_967,
            Some("1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_medium_q5",
        family: "whisper-medium",
        label: "Whisper Medium",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Q5_0",
        files: whisper_files!(
            "ggml-medium-q5_0.bin",
            539_212_467,
            Some("19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_medium_q8",
        family: "whisper-medium",
        label: "Whisper Medium",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Q8_0",
        files: whisper_files!(
            "ggml-medium-q8_0.bin",
            823_369_779,
            Some("42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_medium",
        family: "whisper-medium",
        label: "Whisper Medium",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Full",
        files: whisper_files!(
            "ggml-medium.bin",
            1_533_763_059,
            Some("6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_large_v3_q5",
        family: "whisper-large-v3",
        label: "Whisper Large V3",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Q5_0",
        files: whisper_files!(
            "ggml-large-v3-q5_0.bin",
            1_081_140_203,
            Some("d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_large_v3",
        family: "whisper-large-v3",
        label: "Whisper Large V3",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Full",
        files: whisper_files!(
            "ggml-large-v3.bin",
            3_095_033_483,
            Some("64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_large_v3_turbo_q5",
        family: "whisper-large-v3-turbo",
        label: "Whisper Large V3 Turbo",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Q5_0",
        files: whisper_files!(
            "ggml-large-v3-turbo-q5_0.bin",
            574_041_195,
            Some("394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
    LocalModelManifest {
        id: "whisper_large_v3_turbo",
        family: "whisper-large-v3-turbo",
        label: "Whisper Large V3 Turbo",
        description: WHISPER_DESCRIPTION,
        tags: &["Multilingual", "Dictionary"],
        category: "standard",
        engine: LocalModelEngine::Whisper,
        variant: "Full",
        files: whisper_files!(
            "ggml-large-v3-turbo.bin",
            1_624_555_275,
            Some("1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69")
        ),
        capabilities: WHISPER_CAPABILITIES,
    },
];

pub fn local_manifests() -> &'static [LocalModelManifest] {
    MODEL_MANIFESTS
}

pub fn definition(key: &str) -> Option<&'static LocalModelManifest> {
    MODEL_MANIFESTS.iter().find(|manifest| manifest.id == key)
}

pub fn install_spec(model: &str, ane: bool) -> Option<InstallSpec> {
    let manifest = definition(model)?;
    let storage = match manifest.files {
        [single] => ModelStorage::File {
            artifact: single.path.to_string(),
        },
        _ => ModelStorage::Directory,
    };
    let mut files: Vec<RemoteFile> = manifest
        .files
        .iter()
        .map(|file| RemoteFile {
            url: file.url.to_string(),
            path: file.path.to_string(),
            size_bytes: file.size_bytes,
            sha256: file.sha256.map(str::to_string),
            extract: false,
        })
        .collect();
    if ane && let Some(encoder) = ane_encoder(manifest) {
        let dir_name = encoder.dir_name();
        files.push(RemoteFile {
            url: format!(
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{dir_name}.zip"
            ),
            path: dir_name,
            size_bytes: Some(encoder.size_bytes),
            sha256: Some(encoder.sha256.to_string()),
            extract: true,
        });
    }
    Some(InstallSpec {
        id: manifest.id.to_string(),
        engine: manifest.engine,
        layout: Some(model_layout(manifest)),
        storage,
        files,
        variant: Some(manifest.family.to_string()),
    })
}

pub fn model_label(key: &str) -> String {
    definition(key)
        .map(|model| model.label.to_string())
        .unwrap_or_else(|| key.to_string())
}

pub fn model_supports_capability(model_key: &str, capability: &str) -> bool {
    definition(model_key)
        .map(|manifest| {
            manifest
                .capabilities
                .iter()
                .any(|entry| entry.eq_ignore_ascii_case(capability))
        })
        .unwrap_or(false)
}

pub fn is_streaming_model(model_key: &str) -> bool {
    model_supports_capability(model_key, MODEL_CAPABILITY_STREAMING)
}

fn supports_only_english(manifest: &LocalModelManifest) -> bool {
    manifest
        .tags
        .iter()
        .any(|tag| tag.eq_ignore_ascii_case("English"))
        && !manifest
            .tags
            .iter()
            .any(|tag| tag.eq_ignore_ascii_case("Multilingual"))
}

fn supported_languages(manifest: &LocalModelManifest) -> Vec<SupportedLanguageInfo> {
    if supports_only_english(manifest) {
        return english_supported_languages();
    }

    match manifest.engine {
        LocalModelEngine::Whisper => whisper_supported_languages(),
        LocalModelEngine::Nemotron => {
            #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
            {
                if manifest.id == "nemotron_35_streaming_multilingual" {
                    nemotron_35_supported_languages()
                } else {
                    nemotron_supported_languages()
                }
            }

            #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
            {
                Vec::new()
            }
        }
        LocalModelEngine::Parakeet => {
            #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
            {
                parakeet_v3_supported_languages()
            }

            #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
            {
                Vec::new()
            }
        }
        LocalModelEngine::Apple => apple_supported_languages(),
    }
}

fn apple_supported_languages() -> Vec<SupportedLanguageInfo> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        static LANGUAGES: std::sync::OnceLock<Vec<SupportedLanguageInfo>> =
            std::sync::OnceLock::new();
        LANGUAGES
            .get_or_init(|| {
                let mut codes: Vec<String> = glimpse_speech::engines::apple::supported_locales()
                    .iter()
                    .filter_map(|locale| locale.split('-').next())
                    .map(str::to_string)
                    .collect();
                codes.sort();
                codes.dedup();
                crate::model_language_table::supported_languages_for_owned_codes(&codes)
            })
            .clone()
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        Vec::new()
    }
}

pub(crate) fn apple_engine_available() -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        glimpse_speech::engines::apple::available()
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        false
    }
}

fn engine_id(engine: &LocalModelEngine) -> &'static str {
    match engine {
        LocalModelEngine::Nemotron | LocalModelEngine::Parakeet => "nvidia",
        LocalModelEngine::Whisper => "whisper",
        LocalModelEngine::Apple => "apple",
    }
}

fn model_layout(manifest: &LocalModelManifest) -> ModelLayout {
    match manifest.engine {
        LocalModelEngine::Whisper | LocalModelEngine::Apple => ModelLayout::Whisper,
        LocalModelEngine::Nemotron => ModelLayout::Nemotron,
        LocalModelEngine::Parakeet if manifest.family == "parakeet-unified" => {
            ModelLayout::ParakeetUnified
        }
        LocalModelEngine::Parakeet => ModelLayout::ParakeetTdt,
    }
}

fn capability_strings(capabilities: &[&str]) -> Vec<String> {
    capabilities.iter().map(|c| c.to_string()).collect()
}

fn manifest_to_model_info(manifest: &LocalModelManifest) -> ModelInfo {
    ModelInfo {
        key: manifest.id.to_string(),
        label: manifest.label.to_string(),
        description: manifest.description.to_string(),
        size_mb: manifest
            .files
            .iter()
            .map(|file| file.size_bytes.unwrap_or(0))
            .sum::<u64>() as f32
            / 1_000_000.0,
        engine_id: engine_id(&manifest.engine).to_string(),
        family: manifest.family.to_string(),
        variant: manifest.variant.to_string(),
        category: manifest.category.to_string(),
        downloadable: is_downloadable(manifest),
        tags: manifest.tags.iter().map(|tag| tag.to_string()).collect(),
        capabilities: capability_strings(manifest.capabilities),
        supported_languages: supported_languages(manifest),
        ane_size_mb: ane_encoder(manifest).map(|encoder| encoder.size_bytes as f32 / 1_000_000.0),
    }
}

pub fn api_model_infos() -> Vec<glimpse_speech::api::ApiModelInfo> {
    MODEL_MANIFESTS
        .iter()
        .map(|manifest| {
            glimpse_speech::api::ApiModelInfo::new(
                manifest.id.to_string(),
                manifest.label.to_string(),
                manifest.description.to_string(),
                manifest.tags.iter().map(|tag| tag.to_string()).collect(),
                capability_strings(manifest.capabilities),
            )
        })
        .collect()
}

pub fn list_local_models() -> Vec<ModelInfo> {
    MODEL_MANIFESTS
        .iter()
        .filter(|manifest| manifest.engine != LocalModelEngine::Apple || apple_engine_available())
        .map(manifest_to_model_info)
        .collect()
}

pub fn list_models(app: &AppHandle<AppRuntime>, settings: &UserSettings) -> Vec<SpeechModel> {
    let mut models = Vec::new();

    if remote::is_configured(settings) {
        models.push(remote_entry(settings));
    }

    for info in list_local_models() {
        let installed = install::check_model_status(app.clone(), info.key.clone())
            .map(|status| status.installed)
            .unwrap_or(false);
        models.push(from_local(info, installed));
    }

    models
}

/// Headless variant of [`list_models`] that derives installed status from a
/// models directory path instead of an `AppHandle`.
pub(crate) fn list_models_at(
    models_dir: &std::path::Path,
    settings: &UserSettings,
) -> Vec<SpeechModel> {
    let mut models = Vec::new();

    if remote::is_configured(settings) {
        models.push(remote_entry(settings));
    }

    for info in list_local_models() {
        let installed = install::check_model_installed_at(models_dir, &info.key);
        models.push(from_local(info, installed));
    }

    models
}

fn from_local(info: ModelInfo, installed: bool) -> SpeechModel {
    SpeechModel {
        id: info.key.clone(),
        key: info.key,
        label: info.label,
        description: info.description,
        size_mb: info.size_mb,
        engine_id: info.engine_id,
        variant: info.variant,
        tags: info.tags,
        capabilities: info.capabilities,
        supported_languages: info.supported_languages,
        remote: false,
        installed,
    }
}

pub(crate) fn configured_remote_model(settings: &UserSettings) -> Option<SpeechModel> {
    remote::has_valid_config(settings).then(|| remote_entry(settings))
}

fn remote_entry(settings: &UserSettings) -> SpeechModel {
    let id = remote::speech_model_storage_label(settings, None);
    SpeechModel {
        label: label(&id),
        key: id.clone(),
        id,
        description: "Transcribes through your configured remote speech provider.".to_string(),
        size_mb: 0.0,
        engine_id: "remote".to_string(),
        variant: String::new(),
        tags: vec!["Remote".to_string()],
        capabilities: {
            let mut caps = vec![
                MODEL_CAPABILITY_TIMESTAMPS.to_string(),
                MODEL_CAPABILITY_DICTIONARY.to_string(),
            ];
            if glimpse_speech::remote::supports_diarization(&remote::resolved_endpoint(settings)) {
                caps.push(MODEL_CAPABILITY_DIARIZATION.to_string());
            }
            caps
        },
        supported_languages: Vec::new(),
        remote: true,
        installed: true,
    }
}

pub fn label(model_id: &str) -> String {
    if remote::is_remote_model(model_id) {
        token_label(model_id)
    } else {
        model_label(model_id)
    }
}

fn token_label(token: &str) -> String {
    let rest = token
        .trim()
        .strip_prefix(remote::SPEECH_MODEL_REMOTE_PREFIX)
        .unwrap_or(token);
    let mut parts = rest.splitn(2, ':');
    let provider = parts.next().unwrap_or_default();
    let model = parts.next().filter(|value| !value.is_empty());
    let provider_label = provider_display(provider);
    match model {
        Some(model) => format!("{provider_label} · {model}"),
        None => provider_label,
    }
}

fn provider_display(provider: &str) -> String {
    match provider.trim().to_ascii_lowercase().as_str() {
        "openai" => "OpenAI".to_string(),
        "groq" => "Groq".to_string(),
        "mistral" => "Mistral".to_string(),
        "fireworks" => "Fireworks".to_string(),
        "openrouter" => "OpenRouter".to_string(),
        "litellm" => "LiteLLM".to_string(),
        "deepgram" => "Deepgram".to_string(),
        "elevenlabs" => "ElevenLabs".to_string(),
        "vllm" => "vLLM".to_string(),
        "localai" => "LocalAI".to_string(),
        "whisper-cpp" => "whisper.cpp".to_string(),
        "llamaedge" => "LlamaEdge".to_string(),
        "custom" => "Custom".to_string(),
        "" => "Remote".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_models_are_not_downloadable() {
        let legacy = LocalModelManifest {
            id: "legacy_test",
            label: "Legacy Test",
            description: "test",
            category: MODEL_CATEGORY_LEGACY,
            tags: &[],
            engine: LocalModelEngine::Whisper,
            family: "whisper-tiny",
            variant: "Full",
            files: whisper_files!(
                "ggml-tiny.bin",
                77_691_713,
                Some("be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21")
            ),
            capabilities: WHISPER_CAPABILITIES,
        };

        assert!(is_legacy_category(MODEL_CATEGORY_LEGACY));
        assert!(!is_downloadable(&legacy));
    }

    #[test]
    fn active_models_remain_downloadable() {
        let manifest = definition("whisper_tiny").expect("fixture model");
        assert!(is_downloadable(manifest));
        assert!(model_is_downloadable("whisper_tiny"));
    }

    #[test]
    fn unknown_models_are_not_downloadable() {
        assert!(!model_is_downloadable("not_a_real_model"));
    }
}
