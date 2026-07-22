use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct SupportedLanguageInfo {
    pub code: String,
    pub name: String,
}

const LANGUAGE_NAMES: &[(&str, &str)] = &[
    ("en", "English"),
    ("zh", "Chinese"),
    ("de", "German"),
    ("es", "Spanish"),
    ("ru", "Russian"),
    ("ko", "Korean"),
    ("fr", "French"),
    ("ja", "Japanese"),
    ("pt", "Portuguese"),
    ("tr", "Turkish"),
    ("pl", "Polish"),
    ("ca", "Catalan"),
    ("nl", "Dutch"),
    ("ar", "Arabic"),
    ("sv", "Swedish"),
    ("it", "Italian"),
    ("id", "Indonesian"),
    ("hi", "Hindi"),
    ("fi", "Finnish"),
    ("vi", "Vietnamese"),
    ("he", "Hebrew"),
    ("uk", "Ukrainian"),
    ("el", "Greek"),
    ("ms", "Malay"),
    ("cs", "Czech"),
    ("ro", "Romanian"),
    ("da", "Danish"),
    ("hu", "Hungarian"),
    ("ta", "Tamil"),
    ("nb", "Norwegian Bokmål"),
    ("no", "Norwegian"),
    ("th", "Thai"),
    ("ur", "Urdu"),
    ("hr", "Croatian"),
    ("bg", "Bulgarian"),
    ("lt", "Lithuanian"),
    ("la", "Latin"),
    ("mi", "Maori"),
    ("ml", "Malayalam"),
    ("cy", "Welsh"),
    ("sk", "Slovak"),
    ("te", "Telugu"),
    ("fa", "Persian"),
    ("lv", "Latvian"),
    ("bn", "Bengali"),
    ("sr", "Serbian"),
    ("az", "Azerbaijani"),
    ("sl", "Slovenian"),
    ("kn", "Kannada"),
    ("et", "Estonian"),
    ("mk", "Macedonian"),
    ("br", "Breton"),
    ("eu", "Basque"),
    ("is", "Icelandic"),
    ("hy", "Armenian"),
    ("ne", "Nepali"),
    ("mn", "Mongolian"),
    ("bs", "Bosnian"),
    ("kk", "Kazakh"),
    ("sq", "Albanian"),
    ("sw", "Swahili"),
    ("gl", "Galician"),
    ("mr", "Marathi"),
    ("pa", "Punjabi"),
    ("si", "Sinhala"),
    ("km", "Khmer"),
    ("sn", "Shona"),
    ("yo", "Yoruba"),
    ("so", "Somali"),
    ("af", "Afrikaans"),
    ("oc", "Occitan"),
    ("ka", "Georgian"),
    ("be", "Belarusian"),
    ("tg", "Tajik"),
    ("sd", "Sindhi"),
    ("gu", "Gujarati"),
    ("am", "Amharic"),
    ("yi", "Yiddish"),
    ("lo", "Lao"),
    ("uz", "Uzbek"),
    ("fo", "Faroese"),
    ("ht", "Haitian Creole"),
    ("ps", "Pashto"),
    ("tk", "Turkmen"),
    ("nn", "Nynorsk"),
    ("mt", "Maltese"),
    ("sa", "Sanskrit"),
    ("lb", "Luxembourgish"),
    ("my", "Myanmar"),
    ("bo", "Tibetan"),
    ("tl", "Tagalog"),
    ("mg", "Malagasy"),
    ("as", "Assamese"),
    ("tt", "Tatar"),
    ("haw", "Hawaiian"),
    ("ln", "Lingala"),
    ("ha", "Hausa"),
    ("ba", "Bashkir"),
    ("jw", "Javanese"),
    ("su", "Sundanese"),
    ("yue", "Cantonese"),
];

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const NVIDIA_PARAKEET_V3_LANGUAGE_CODES: &[&str] = &[
    "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt",
    "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
];

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const NVIDIA_NEMOTRON_35_LANGUAGE_CODES: &[&str] = &[
    "ar", "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "he", "hi", "hr", "hu", "it",
    "ja", "ko", "lt", "lv", "mt", "nb", "nl", "nn", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "th",
    "tr", "uk", "vi", "zh",
];

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn language_name(code: &str) -> Option<&'static str> {
    LANGUAGE_NAMES
        .iter()
        .find_map(|(c, name)| if *c == code { Some(*name) } else { None })
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn supported_languages_for_codes(codes: &[&str]) -> Vec<SupportedLanguageInfo> {
    codes
        .iter()
        .map(|code| SupportedLanguageInfo {
            code: (*code).to_string(),
            name: language_name(code).unwrap_or(code).to_string(),
        })
        .collect()
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn supported_languages_for_owned_codes(codes: &[String]) -> Vec<SupportedLanguageInfo> {
    codes
        .iter()
        .map(|code| SupportedLanguageInfo {
            code: code.clone(),
            name: language_name(code).unwrap_or(code).to_string(),
        })
        .collect()
}

pub fn whisper_supported_languages() -> Vec<SupportedLanguageInfo> {
    LANGUAGE_NAMES
        .iter()
        .map(|(code, name)| SupportedLanguageInfo {
            code: (*code).to_string(),
            name: (*name).to_string(),
        })
        .collect()
}

pub fn english_supported_languages() -> Vec<SupportedLanguageInfo> {
    vec![SupportedLanguageInfo {
        code: "en".to_string(),
        name: "English".to_string(),
    }]
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
pub fn parakeet_v3_supported_languages() -> Vec<SupportedLanguageInfo> {
    supported_languages_for_codes(NVIDIA_PARAKEET_V3_LANGUAGE_CODES)
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
pub fn nemotron_supported_languages() -> Vec<SupportedLanguageInfo> {
    english_supported_languages()
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
pub fn nemotron_35_supported_languages() -> Vec<SupportedLanguageInfo> {
    supported_languages_for_codes(NVIDIA_NEMOTRON_35_LANGUAGE_CODES)
}
