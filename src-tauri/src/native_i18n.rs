//! Labels for the tray and macOS menu bar, compiled from the same
//! src/locales/*/messages.po catalogs the frontend uses. See build.rs.

use crate::settings::UserSettings;

include!(concat!(env!("OUT_DIR"), "/native_menu_catalog.rs"));

const DEFAULT_LOCALE: &str = "en";

/// Resolved labels for one locale. Built fresh on every menu rebuild.
pub struct MenuStrings {
    entries: &'static [(&'static str, &'static str)],
    fallback: &'static [(&'static str, &'static str)],
}

fn catalog(locale: &str) -> Option<&'static [(&'static str, &'static str)]> {
    NATIVE_MENU_CATALOG
        .iter()
        .find(|(code, _)| *code == locale)
        .map(|(_, entries)| *entries)
}

/// Exact match first, then the base language, mirroring the frontend's
/// matchSupportedAppLocale so both layers land on the same catalog.
fn match_locale(locale: &str) -> Option<&'static str> {
    let normalized = locale.trim().replace('_', "-").to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    let codes = || NATIVE_MENU_CATALOG.iter().map(|(code, _)| *code);
    // Exact before base, so pt-BR keeps pt-br rather than falling into pt.
    codes().find(|code| *code == normalized).or_else(|| {
        let base = normalized.split('-').next().unwrap_or_default();
        codes().find(|code| *code == base)
    })
}

#[cfg(target_os = "macos")]
fn system_locales() -> Vec<String> {
    use core_foundation::array::CFArray;
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFLocaleCopyPreferredLanguages() -> core_foundation::array::CFArrayRef;
    }

    unsafe {
        let raw = CFLocaleCopyPreferredLanguages();
        if raw.is_null() {
            return Vec::new();
        }
        let languages = CFArray::<CFString>::wrap_under_create_rule(raw);
        languages.iter().map(|lang| lang.to_string()).collect()
    }
}

#[cfg(target_os = "windows")]
fn system_locales() -> Vec<String> {
    use windows::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    use windows::core::PWSTR;

    // Display languages, not the regional format locale, which can differ.
    let mut count = 0u32;
    let mut len = 0u32;
    if unsafe { GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut len) }
        .is_err()
    {
        return Vec::new();
    }

    let mut buffer = vec![0u16; len as usize];
    if unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut len,
        )
    }
    .is_err()
    {
        return Vec::new();
    }

    // Double-null-terminated list, ordered by preference.
    String::from_utf16_lossy(&buffer)
        .split('\0')
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

impl MenuStrings {
    pub fn resolve(settings: &UserSettings) -> Self {
        let locale = if settings.app_locale == "system" {
            system_locales()
                .iter()
                .find_map(|candidate| match_locale(candidate))
                .unwrap_or(DEFAULT_LOCALE)
        } else {
            match_locale(&settings.app_locale).unwrap_or(DEFAULT_LOCALE)
        };

        Self {
            entries: catalog(locale).unwrap_or(&[]),
            fallback: catalog(DEFAULT_LOCALE).unwrap_or(&[]),
        }
    }

    /// Falls back to English, then to the key itself so a missing entry is
    /// visible rather than blank.
    pub fn get(&self, key: &'static str) -> &'static str {
        let lookup = |table: &'static [(&'static str, &'static str)]| {
            table
                .iter()
                .find(|(entry, _)| *entry == key)
                .map(|(_, value)| *value)
        };
        lookup(self.entries)
            .or_else(|| lookup(self.fallback))
            .unwrap_or(key)
    }

    pub fn format(&self, key: &'static str, args: &[(&str, &str)]) -> String {
        let mut text = self.get(key).to_string();
        for (name, value) in args {
            text = text.replace(&format!("{{{name}}}"), value);
        }
        text
    }
}
