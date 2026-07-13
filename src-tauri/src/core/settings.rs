use serde::Deserialize;
use tauri::AppHandle;

use super::hotkeys;
use crate::settings::{
    AutoDeleteTarget, MediaAction, RecordingPrunePolicy, ShortcutBinding, ShortcutBindings,
    ThemeMode, TranscriptionMode, UserSettings, canonicalize_app_locale,
    canonicalize_app_locale_or_default,
};

use crate::{AppRuntime, AppState, analytics, auto_dictionary, model_manager, pill, tray};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateSettingsArgs {
    pub smart_shortcut: String,
    pub smart_enabled: bool,
    pub hold_shortcut: String,
    pub hold_enabled: bool,
    pub toggle_shortcut: String,
    pub toggle_enabled: bool,
    pub shortcut_bindings: ShortcutBindings,
    pub transcription_mode: TranscriptionMode,
    pub local_model: String,
    #[serde(default)]
    pub remote_speech_enabled: bool,
    #[serde(default = "crate::settings::default_remote_speech_provider")]
    pub remote_speech_provider: String,
    #[serde(default = "crate::settings::default_remote_speech_endpoint")]
    pub remote_speech_endpoint: String,
    #[serde(default)]
    pub remote_speech_api_key: String,
    #[serde(default = "crate::settings::default_remote_speech_model")]
    pub remote_speech_model: String,
    pub microphone_device: Option<String>,
    pub language: String,
    pub app_locale: String,
    pub theme_mode: ThemeMode,
    pub llm_enabled: bool,

    pub cleanup_enabled: bool,
    pub llm_provider: String,
    pub llm_endpoint: String,
    pub llm_api_key: String,
    pub llm_model: String,
    pub edit_mode_enabled: bool,
    pub auto_dictionary_enabled: bool,
    #[serde(default)]
    pub media_action: MediaAction,
    pub auto_update_enabled: bool,
    pub auto_launch_enabled: bool,
    pub start_in_background: bool,
    pub auto_delete_target: AutoDeleteTarget,
    pub auto_delete_duration: RecordingPrunePolicy,
    pub analytics_enabled: bool,
    pub local_api_key: String,
    pub local_api_port: u16,
    pub local_api_model: String,
    pub local_api_host: String,
    pub local_api_start_on_launch: bool,
    pub local_api_cors: bool,
}

fn canonicalize_shortcut_for_storage(shortcut: &str) -> Result<String, String> {
    let hotkey = hotkeys::parse_shortcut(shortcut).map_err(|err| err.to_string())?;
    hotkeys::validate_recording_shortcut(&hotkey).map_err(|err| err.to_string())?;
    Ok(hotkey.to_string())
}

fn canonicalize_shortcut_binding(binding: &ShortcutBinding) -> Result<ShortcutBinding, String> {
    Ok(ShortcutBinding {
        shortcut: canonicalize_shortcut_for_storage(&binding.shortcut)?,
        temporary: binding.temporary,
        cleanup_enabled: binding.cleanup_enabled,
    })
}

fn canonicalize_shortcut_bindings(args: &UpdateSettingsArgs) -> Result<ShortcutBindings, String> {
    let normalize_mode = |bindings: &[ShortcutBinding]| -> Result<Vec<ShortcutBinding>, String> {
        let mut normalized = Vec::new();
        for binding in bindings.iter().take(3) {
            if binding.shortcut.trim().is_empty() {
                continue;
            }
            normalized.push(canonicalize_shortcut_binding(binding)?);
        }
        Ok(normalized)
    };

    Ok(ShortcutBindings {
        smart: normalize_mode(&args.shortcut_bindings.smart)?,
        hold: normalize_mode(&args.shortcut_bindings.hold)?,
        toggle: normalize_mode(&args.shortcut_bindings.toggle)?,
    })
}

fn collect_enabled_shortcuts(
    enabled_shortcuts: &mut Vec<(&'static str, hotkeys::Hotkey)>,
    mode_name: &'static str,
    enabled: bool,
    bindings: &[ShortcutBinding],
) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }

    for binding in bindings.iter().take(3) {
        let raw = binding.shortcut.trim();
        if raw.is_empty() {
            continue;
        }
        let normalized = hotkeys::parse_shortcut(raw)
            .map_err(|err| format!("{mode_name} shortcut is invalid: {err}"))?;
        hotkeys::validate_recording_shortcut(&normalized)
            .map_err(|err| format!("{mode_name} shortcut is invalid: {err}"))?;
        enabled_shortcuts.push((mode_name, normalized));
    }

    Ok(())
}

fn validate_update_settings_args(args: &UpdateSettingsArgs) -> Result<(), String> {
    if !args.smart_enabled && !args.hold_enabled && !args.toggle_enabled {
        return Err("At least one recording mode must be enabled".into());
    }

    let mut enabled_shortcuts: Vec<(&str, hotkeys::Hotkey)> = vec![];
    collect_enabled_shortcuts(
        &mut enabled_shortcuts,
        "Smart",
        args.smart_enabled,
        &args.shortcut_bindings.smart,
    )?;
    collect_enabled_shortcuts(
        &mut enabled_shortcuts,
        "Hold",
        args.hold_enabled,
        &args.shortcut_bindings.hold,
    )?;
    collect_enabled_shortcuts(
        &mut enabled_shortcuts,
        "Toggle",
        args.toggle_enabled,
        &args.shortcut_bindings.toggle,
    )?;

    if args.smart_enabled && !enabled_shortcuts.iter().any(|(name, _)| *name == "Smart") {
        return Err("Smart shortcut cannot be empty when enabled".into());
    }
    if args.hold_enabled && !enabled_shortcuts.iter().any(|(name, _)| *name == "Hold") {
        return Err("Hold shortcut cannot be empty when enabled".into());
    }
    if args.toggle_enabled && !enabled_shortcuts.iter().any(|(name, _)| *name == "Toggle") {
        return Err("Toggle shortcut cannot be empty when enabled".into());
    }

    for i in 0..enabled_shortcuts.len() {
        for j in (i + 1)..enabled_shortcuts.len() {
            let (name1, normalized1) = &enabled_shortcuts[i];
            let (name2, normalized2) = &enabled_shortcuts[j];
            if normalized1 == normalized2 {
                return Err(format!(
                    "{} and {} shortcuts cannot be the same",
                    name1, name2
                ));
            }

            if hotkeys::shortcuts_conflict(normalized1, normalized2) {
                return Err(format!(
                    "{} shortcut overlaps {} shortcut. Choose a more specific combination.",
                    name1, name2
                ));
            }
        }
    }

    if model_manager::definition(&args.local_model).is_none() {
        return Err("Unknown model selection".into());
    }

    if args.remote_speech_enabled {
        if args.remote_speech_endpoint.trim().is_empty() {
            return Err("Remote speech endpoint cannot be empty".into());
        }
        if crate::remote_speech::provider_requires_api_key(&args.remote_speech_provider)
            && args.remote_speech_api_key.trim().is_empty()
        {
            return Err("Remote speech API key cannot be empty".into());
        }
        if crate::remote_speech::resolve_model(
            &args.remote_speech_provider,
            &args.remote_speech_model,
        )
        .is_none()
        {
            return Err("Choose a remote speech model before enabling remote transcription".into());
        }
    }

    if canonicalize_app_locale(&args.app_locale).is_none() {
        return Err("Unknown app language selection".into());
    }

    if args.llm_enabled && args.llm_provider == "none" {
        return Err("LLM cannot be enabled when provider is None".into());
    }

    let shortcut_cleanup_enabled = args
        .shortcut_bindings
        .smart
        .iter()
        .chain(args.shortcut_bindings.hold.iter())
        .chain(args.shortcut_bindings.toggle.iter())
        .any(|binding| binding.cleanup_enabled);
    if (args.cleanup_enabled || shortcut_cleanup_enabled) && !args.llm_enabled {
        return Err("AI Cleanup cannot be enabled without an active language model".into());
    }

    if args.llm_enabled {
        if args.llm_endpoint.trim().is_empty() {
            return Err("Language model endpoint cannot be empty".into());
        }
        if args.llm_model.trim().is_empty() {
            return Err("Choose a language model before enabling AI features".into());
        }
    }

    if args.local_api_port == 0 {
        return Err("Local API port must be between 1 and 65535".into());
    }

    if args.local_api_model != "auto" && model_manager::definition(&args.local_api_model).is_none()
    {
        return Err("Unknown local API model selection".into());
    }

    if args.local_api_host != "127.0.0.1" && args.local_api_host != "0.0.0.0" {
        return Err("Unknown local API host selection".into());
    }

    Ok(())
}

pub(crate) fn complete_onboarding(
    app: &AppHandle<AppRuntime>,
    state: &AppState,
) -> Result<(), String> {
    let mut settings = state.current_settings_unmasked();
    settings.onboarding_completed = true;
    let next = state
        .persist_settings(settings)
        .map_err(|err| err.to_string())?;

    state.emit_settings_changed(app, &next);

    analytics::track_onboarding_completed(app);
    Ok(())
}

pub(crate) fn reset_onboarding(
    app: &AppHandle<AppRuntime>,
    state: &AppState,
) -> Result<(), String> {
    let mut settings = state.current_settings_unmasked();
    settings.onboarding_completed = false;
    let next = state
        .persist_settings(settings)
        .map_err(|err| err.to_string())?;

    state.emit_settings_changed(app, &next);

    Ok(())
}

pub(crate) fn update_settings(
    args: UpdateSettingsArgs,
    app: &AppHandle<AppRuntime>,
    state: &AppState,
) -> Result<UserSettings, String> {
    validate_update_settings_args(&args)?;
    let shortcut_cleanup_enabled = args
        .shortcut_bindings
        .smart
        .iter()
        .chain(args.shortcut_bindings.hold.iter())
        .chain(args.shortcut_bindings.toggle.iter())
        .any(|binding| binding.cleanup_enabled);
    let license_gated_requested = args.llm_enabled
        || args.cleanup_enabled
        || shortcut_cleanup_enabled
        || args.edit_mode_enabled;
    if license_gated_requested {
        crate::license::require_license_gate(&state.settings_store, "AI writing and Edit Mode")?;
    }
    if args.local_api_start_on_launch {
        crate::license::require_active_license(&state.settings_store, "the API server")?;
    }
    let license_active = crate::license::license_gate_active(&state.settings_store);
    let active_license = crate::license::active_license_gate(&state.settings_store);
    let shortcut_bindings = canonicalize_shortcut_bindings(&args)?;

    let requested_auto_launch_enabled = args.auto_launch_enabled;
    let launch_changed =
        state.current_settings_unmasked().auto_launch_enabled != requested_auto_launch_enabled;
    if launch_changed {
        crate::sync_launch_at_login(app, requested_auto_launch_enabled)?;
    }

    let result = state.persist_settings_with(|prev, next| {
        next.shortcut_bindings = shortcut_bindings;
        next.smart_shortcut = next
            .shortcut_bindings
            .smart
            .first()
            .map(|binding| binding.shortcut.clone())
            .unwrap_or(args.smart_shortcut);
        next.smart_enabled = args.smart_enabled;
        next.hold_shortcut = next
            .shortcut_bindings
            .hold
            .first()
            .map(|binding| binding.shortcut.clone())
            .unwrap_or(args.hold_shortcut);
        next.hold_enabled = args.hold_enabled;
        next.toggle_shortcut = next
            .shortcut_bindings
            .toggle
            .first()
            .map(|binding| binding.shortcut.clone())
            .unwrap_or(args.toggle_shortcut);
        next.toggle_enabled = args.toggle_enabled;
        next.transcription_mode = args.transcription_mode;
        next.local_model = args.local_model;
        next.remote_speech_enabled = args.remote_speech_enabled;
        next.remote_speech_provider = args.remote_speech_provider;
        next.remote_speech_endpoint = args.remote_speech_endpoint.trim().to_string();
        next.remote_speech_api_key = args.remote_speech_api_key;
        next.remote_speech_model = args.remote_speech_model.trim().to_string();
        next.microphone_device = args.microphone_device;
        next.language = args.language;
        next.app_locale = canonicalize_app_locale_or_default(&args.app_locale);
        next.theme_mode = args.theme_mode;
        if license_active {
            next.llm_enabled = args.llm_enabled;
            next.cleanup_enabled = args.cleanup_enabled;
            next.edit_mode_enabled = args.edit_mode_enabled;
        } else {
            for (next_bindings, prev_bindings) in [
                (
                    &mut next.shortcut_bindings.smart,
                    &prev.shortcut_bindings.smart,
                ),
                (
                    &mut next.shortcut_bindings.hold,
                    &prev.shortcut_bindings.hold,
                ),
                (
                    &mut next.shortcut_bindings.toggle,
                    &prev.shortcut_bindings.toggle,
                ),
            ] {
                for (out, before) in next_bindings.iter_mut().zip(prev_bindings.iter()) {
                    out.cleanup_enabled = before.cleanup_enabled;
                }
            }
        }
        next.local_api_start_on_launch = active_license && args.local_api_start_on_launch;
        next.llm_provider = args.llm_provider;
        next.llm_endpoint = args.llm_endpoint;
        next.llm_api_key = args.llm_api_key;
        next.llm_model = args.llm_model.trim().to_string();
        next.auto_dictionary_enabled = args.auto_dictionary_enabled;
        next.media_action = args.media_action;
        next.auto_update_enabled = args.auto_update_enabled;
        next.auto_launch_enabled = args.auto_launch_enabled;
        next.start_in_background = args.auto_launch_enabled && args.start_in_background;
        next.auto_delete_target = args.auto_delete_target;
        next.auto_delete_duration = args.auto_delete_duration;
        next.analytics_enabled = args.analytics_enabled;
        next.local_api_key = args.local_api_key.trim().to_string();
        next.local_api_port = args.local_api_port;
        next.local_api_model = args.local_api_model;
        next.local_api_host = crate::settings::canonicalize_local_api_host(&args.local_api_host);
        next.local_api_cors = args.local_api_cors;
    });

    let (prev, next) = match result {
        Ok(pair) => pair,
        Err(err) => {
            if launch_changed
                && let Err(rollback_err) =
                    crate::sync_launch_at_login(app, !requested_auto_launch_enabled)
            {
                return Err(format!(
                    "{} (also failed to roll back launch at login from {} back to {}: {})",
                    err,
                    requested_auto_launch_enabled,
                    !requested_auto_launch_enabled,
                    rollback_err
                ));
            }
            return Err(err.to_string());
        }
    };
    auto_dictionary::sync_ignored_dictionary_entries(&next.dictionary);

    state.request_preflight_refresh();

    pill::register_shortcuts(app).map_err(|err| err.to_string())?;

    if prev.transcription_mode != next.transcription_mode
        || prev.local_model != next.local_model
        || prev.remote_speech_enabled != next.remote_speech_enabled
        || prev.remote_speech_provider != next.remote_speech_provider
        || prev.remote_speech_model != next.remote_speech_model
        || prev.microphone_device != next.microphone_device
    {
        if let Err(err) = tray::refresh_tray_menu(app, &next) {
            tracing::error!("Failed to refresh tray menu: {err}");
        }
        #[cfg(target_os = "macos")]
        if let Err(err) = crate::set_app_menu(app, &next) {
            tracing::error!("Failed to refresh app menu: {err}");
        }
    }

    state.emit_settings_changed(app, &next);

    analytics::track_settings_changes(app, &prev, &next);

    if prev.analytics_enabled && !next.analytics_enabled {
        analytics::track_analytics_opt_out(app);
    } else if !prev.analytics_enabled && next.analytics_enabled {
        // Re-init in case analytics was off at launch and the client never started.
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            analytics::init(&handle).await;
        });
    }

    if crate::settings::auto_delete_recording_policy(&prev)
        != crate::settings::auto_delete_recording_policy(&next)
    {
        crate::schedule_recording_prune(app.clone(), next.clone());
    }

    if crate::settings::auto_delete_transcription_policy(&prev)
        != crate::settings::auto_delete_transcription_policy(&next)
    {
        crate::schedule_transcription_prune(app.clone(), next.clone());
    }

    Ok(state.settings_for_response(next))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{default_local_model, default_shortcut_bindings};

    fn base_args() -> UpdateSettingsArgs {
        UpdateSettingsArgs {
            smart_shortcut: "Control+Space".to_string(),
            smart_enabled: true,
            hold_shortcut: "Control+Shift+Space".to_string(),
            hold_enabled: false,
            toggle_shortcut: "Control+Alt+Space".to_string(),
            toggle_enabled: false,
            shortcut_bindings: default_shortcut_bindings(),
            transcription_mode: TranscriptionMode::Local,
            local_model: default_local_model(),
            remote_speech_enabled: false,
            remote_speech_provider: "openai".to_string(),
            remote_speech_endpoint: crate::settings::default_remote_speech_endpoint(),
            remote_speech_api_key: String::new(),
            remote_speech_model: crate::settings::default_remote_speech_model(),
            microphone_device: None,
            language: "en".to_string(),
            app_locale: "system".to_string(),
            theme_mode: ThemeMode::default(),
            llm_enabled: false,

            cleanup_enabled: false,
            llm_provider: "none".to_string(),
            llm_endpoint: String::new(),
            llm_api_key: String::new(),
            llm_model: String::new(),
            edit_mode_enabled: false,
            auto_dictionary_enabled: false,
            media_action: MediaAction::Pause,
            auto_update_enabled: true,
            auto_launch_enabled: false,
            start_in_background: true,
            auto_delete_target: AutoDeleteTarget::Transcripts,
            auto_delete_duration: RecordingPrunePolicy::Never,
            analytics_enabled: true,
            local_api_key: String::new(),
            local_api_port: crate::settings::default_local_api_port(),
            local_api_model: crate::settings::default_local_api_model(),
            local_api_host: crate::settings::default_local_api_host(),
            local_api_start_on_launch: false,
            local_api_cors: crate::settings::default_local_api_cors(),
        }
    }

    fn set_primary_shortcut(args: &mut UpdateSettingsArgs, mode: &str, shortcut: &str) {
        let binding = ShortcutBinding {
            shortcut: shortcut.to_string(),
            temporary: false,
            cleanup_enabled: false,
        };

        match mode {
            "Smart" => {
                args.smart_shortcut = shortcut.to_string();
                args.shortcut_bindings.smart = vec![binding];
            }
            "Hold" => {
                args.hold_shortcut = shortcut.to_string();
                args.shortcut_bindings.hold = vec![binding];
            }
            "Toggle" => {
                args.toggle_shortcut = shortcut.to_string();
                args.shortcut_bindings.toggle = vec![binding];
            }
            _ => unreachable!("unknown shortcut mode"),
        }
    }

    #[test]
    fn rejects_enabling_llm_without_provider() {
        let mut args = base_args();
        args.llm_enabled = true;

        let err = validate_update_settings_args(&args).unwrap_err();

        assert_eq!(err, "LLM cannot be enabled when provider is None");
    }

    #[test]
    fn rejects_enabling_cleanup_without_llm() {
        let mut args = base_args();
        args.cleanup_enabled = true;

        let err = validate_update_settings_args(&args).unwrap_err();

        assert_eq!(
            err,
            "AI Cleanup cannot be enabled without an active language model"
        );
    }

    #[test]
    fn accepts_remote_speech_with_auto_model_for_known_provider() {
        let mut args = base_args();
        args.remote_speech_enabled = true;
        args.remote_speech_provider = "openai".to_string();
        args.remote_speech_api_key = "sk-test".to_string();
        args.remote_speech_model = "auto".to_string();

        assert!(validate_update_settings_args(&args).is_ok());
    }

    #[test]
    fn rejects_key_required_remote_speech_without_api_key() {
        let mut args = base_args();
        args.remote_speech_enabled = true;
        args.remote_speech_provider = "openai".to_string();
        args.remote_speech_api_key = "   ".to_string();

        let err = validate_update_settings_args(&args).unwrap_err();

        assert_eq!(err, "Remote speech API key cannot be empty");
    }

    #[test]
    fn rejects_remote_speech_without_endpoint() {
        let mut args = base_args();
        args.remote_speech_enabled = true;
        args.remote_speech_endpoint = "   ".to_string();

        let err = validate_update_settings_args(&args).unwrap_err();

        assert_eq!(err, "Remote speech endpoint cannot be empty");
    }

    #[test]
    fn rejects_remote_speech_when_model_cannot_resolve() {
        let mut args = base_args();
        args.remote_speech_enabled = true;
        args.remote_speech_provider = "totally-unknown-provider".to_string();
        args.remote_speech_model = "auto".to_string();

        let err = validate_update_settings_args(&args).unwrap_err();

        assert_eq!(
            err,
            "Choose a remote speech model before enabling remote transcription"
        );
    }

    #[test]
    fn rejects_shortcut_collisions_after_normalization() {
        let mut args = base_args();
        args.hold_enabled = true;
        set_primary_shortcut(&mut args, "Hold", "Ctrl+Space");

        let err = validate_update_settings_args(&args).unwrap_err();

        assert_eq!(err, "Smart and Hold shortcuts cannot be the same");
    }

    #[test]
    fn accepts_modifier_only_recording_shortcut() {
        let mut args = base_args();
        set_primary_shortcut(&mut args, "Smart", "Ctrl");

        validate_update_settings_args(&args).unwrap();
    }

    #[test]
    fn rejects_capslock_recording_shortcut() {
        let mut args = base_args();
        set_primary_shortcut(&mut args, "Smart", "CapsLock");

        let err = validate_update_settings_args(&args).unwrap_err();

        assert_eq!(
            err,
            "Smart shortcut is invalid: CapsLock cannot be used as a recording shortcut"
        );
    }

    #[test]
    fn rejects_enabling_llm_without_explicit_model_selection() {
        let mut args = base_args();
        args.llm_enabled = true;
        args.llm_provider = "ollama".to_string();
        args.llm_endpoint = "http://localhost:11434/v1".to_string();

        let err = validate_update_settings_args(&args).unwrap_err();

        assert_eq!(err, "Choose a language model before enabling AI features");
    }
}
