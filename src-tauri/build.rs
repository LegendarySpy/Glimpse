fn main() {
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
