/// Unescapes one PO string body (the text between the quotes).
fn unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// Pulls the quoted body out of a PO line, including bare continuation lines.
fn quoted_body(line: &str) -> Option<&str> {
    let start = line.find('"')?;
    let end = line.rfind('"')?;
    if end > start {
        Some(&line[start + 1..end])
    } else {
        None
    }
}

/// Reads `native.*` entries from a lingui PO catalog as (key, translation).
/// msgid holds the key and msgstr the text, which is lingui's explicit-id shape.
fn parse_native_entries(contents: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    let mut key = String::new();
    let mut value = String::new();
    let mut in_msgstr = false;

    // Keys are filtered on flush, not on the msgid line: gettext wraps long
    // ids onto continuation lines, so the prefix is not visible up front.
    // An empty msgstr is left out too, which is how a locale falls back.
    // `#, fuzzy` entries are kept, because lingui compiles them into the
    // frontend catalog and the two layers have to agree.
    macro_rules! flush {
        () => {
            if in_msgstr && key.starts_with("native.") && !value.is_empty() {
                entries.push((std::mem::take(&mut key), std::mem::take(&mut value)));
            }
        };
    }

    for line in contents.lines() {
        let line = line.trim();
        // `#~` marks obsolete entries; every other comment is metadata.
        if line.starts_with('#') || line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix("msgid ") {
            flush!();
            key = quoted_body(rest).map(unescape).unwrap_or_default();
            value.clear();
            in_msgstr = false;
        } else if let Some(rest) = line.strip_prefix("msgstr ") {
            in_msgstr = true;
            value = quoted_body(rest).map(unescape).unwrap_or_default();
        } else if line.starts_with("msgctxt ")
            || line.starts_with("msgid_plural ")
            || line.starts_with("msgstr[")
        {
            // Keywords this parser ignores. Close the open entry first, or
            // their wrapped continuation lines land on the previous msgstr.
            flush!();
            key.clear();
            value.clear();
            in_msgstr = false;
        } else if line.starts_with('"') {
            // Continuation of whichever field is open.
            let part = quoted_body(line).map(unescape).unwrap_or_default();
            if in_msgstr {
                value.push_str(&part);
            } else {
                key.push_str(&part);
            }
        }
    }
    flush!();

    entries
}

/// The locales the app actually ships. A `src/locales/` directory that is not
/// listed here is stale, and shipping it would give the tray a language the
/// window cannot render.
fn shipped_locales(manifest: &std::path::Path) -> Vec<String> {
    let path = manifest.join("../supported-app-locales.json");
    println!("cargo:rerun-if-changed=../supported-app-locales.json");
    let contents = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    // Validated as a flat array of lowercase strings by appLocales.ts.
    let locales: Vec<String> = contents
        .split('"')
        .skip(1)
        .step_by(2)
        .map(|code| code.trim().to_lowercase())
        .collect();
    assert!(
        !locales.is_empty(),
        "supported-app-locales.json listed no locales"
    );
    locales
}

/// Compiles the `native.*` messages of every shipped catalog into a Rust table,
/// so the tray and macOS menu read the same PO files the frontend does.
fn generate_native_menu_catalog() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let locales_dir = manifest.join("../src/locales");
    println!("cargo:rerun-if-changed=../src/locales");
    let shipped = shipped_locales(manifest);

    let mut locales: Vec<(String, Vec<(String, String)>)> = Vec::new();
    if let Ok(dir) = std::fs::read_dir(&locales_dir) {
        for entry in dir.flatten() {
            // Lowercased to match the frontend's extractLocaleCode.
            let locale = entry.file_name().to_string_lossy().trim().to_lowercase();
            if !shipped.contains(&locale) {
                continue;
            }
            let catalog = entry.path().join("messages.po");
            let Ok(contents) = std::fs::read_to_string(&catalog) else {
                continue;
            };
            println!("cargo:rerun-if-changed={}", catalog.display());
            let mut entries = parse_native_entries(&contents);
            entries.sort();
            if !entries.is_empty() {
                locales.push((locale, entries));
            }
        }
    }
    locales.sort();

    let mut out = String::from("// @generated by build.rs from src/locales/*/messages.po\n");
    out.push_str("pub static NATIVE_MENU_CATALOG: &[(&str, &[(&str, &str)])] = &[\n");
    for (locale, entries) in &locales {
        out.push_str(&format!("    ({locale:?}, &[\n"));
        for (key, value) in entries {
            out.push_str(&format!("        ({key:?}, {value:?}),\n"));
        }
        out.push_str("    ]),\n");
    }
    out.push_str("];\n");

    let dest = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR"))
        .join("native_menu_catalog.rs");
    std::fs::write(&dest, out).expect("write native menu catalog");
}

fn main() {
    generate_native_menu_catalog();

    // Forward build-time env vars from workspace .env and the build environment.
    let compile_time_keys = [
        "POSTHOG_API_KEY",
        "POSTHOG_HOST",
        "GLIMPSE_FORCE_LICENSE_GATE",
        "GLIMPSE_POLAR_API_BASE",
        "GLIMPSE_POLAR_BENEFIT_COMMERCIAL",
        "GLIMPSE_POLAR_BENEFIT_CONTRIBUTOR",
        "GLIMPSE_POLAR_BENEFIT_FOUNDER",
        "GLIMPSE_POLAR_BENEFIT_PERSONAL",
        "GLIMPSE_POLAR_ORGANIZATION_ID",
    ];
    let mut forwarded = std::collections::HashSet::new();
    let workspace_env = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env");
    if let Ok(contents) = std::fs::read_to_string(&workspace_env) {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim();
                if compile_time_keys.contains(&key) {
                    println!("cargo:rustc-env={key}={value}");
                    forwarded.insert(key.to_string());
                }
            }
        }
    }
    println!("cargo:rerun-if-changed=../.env");

    for key in compile_time_keys {
        if forwarded.contains(key) {
            continue;
        }
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                println!("cargo:rustc-env={key}={value}");
            }
        }
    }

    // Swift rpath for glimpse-speech's Apple shim. FoundationModels must stay
    // weak-linked: a hard link aborts launch below macOS 26 (app supports 14+).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64")
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,FoundationModels");
    }

    tauri_build::build()
}
