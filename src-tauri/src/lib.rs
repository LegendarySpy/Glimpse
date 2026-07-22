mod accessibility_context;
mod analytics;
mod assistive;
mod audio;
mod auto_dictionary;
mod cli_install;
mod core;
mod crypto;
mod dictionary;
mod import;
mod integrations;
mod library;
mod license;
mod llm_cleanup;
mod local_api;
mod mode_context;
mod model_language_table;
mod music;
mod permissions;
mod personalization;
mod personalization_snippets;
mod pill;
mod platform;
mod recent_transcriptions;
mod recorder;
mod settings;
mod speech;
mod storage;
mod streaming_transcription;
mod toast;
mod transcribe;
mod transcription_api;
mod tray;
mod update_checker;

pub(crate) use speech::engine as local_transcription;
pub(crate) use speech::install as model_manager;
pub(crate) use speech::remote as remote_speech;

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use anyhow::{Context, Result};
use chrono::{DateTime, Local};
use pill::PillController;
use recorder::{CompletedRecording, RecorderManager, RecordingRejectionReason, validate_recording};
use reqwest::Client;
use serde::Serialize;
use settings::{
    RecordingPrunePolicy, SettingsStore, TranscriptionMode, UserSettings, default_local_model,
};
use tauri::Emitter;
use tauri::Listener;
use tauri::async_runtime;
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_opener::OpenerExt;

static LOG_GUARD: std::sync::OnceLock<tracing_appender::non_blocking::WorkerGuard> =
    std::sync::OnceLock::new();

/// Writes app logs to daily-rotated files in the OS log dir (kept 7 days)
fn init_logging(app: &AppHandle<AppRuntime>) {
    use tracing_subscriber::fmt::writer::MakeWriterExt;
    use tracing_subscriber::layer::SubscriberExt;

    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);

    let appender = match tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("glimpse")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&dir)
    {
        Ok(appender) => appender,
        Err(err) => {
            eprintln!("Failed to create log file appender: {err}");
            return;
        }
    };
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let filter = tracing_subscriber::filter::Targets::new()
        .with_default(tracing::level_filters::LevelFilter::WARN)
        .with_target("glimpse_lib", tracing::level_filters::LevelFilter::INFO)
        .with_target("glimpse_speech", tracing::level_filters::LevelFilter::INFO);
    let subscriber = tracing_subscriber::fmt()
        .with_writer(writer.and(std::io::stderr))
        .with_ansi(false)
        .finish()
        .with(filter);
    if tracing::subscriber::set_global_default(subscriber).is_ok() {
        let _ = LOG_GUARD.set(guard);
    }
}

pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
pub(crate) const SETTINGS_WINDOW_LABEL: &str = "settings";
pub(crate) const EVENT_RECORDING_START: &str = "recording:start";
pub(crate) const EVENT_AUDIO_SPECTRUM: &str = "audio:spectrum";
pub(crate) const EVENT_TRANSCRIPTION_COMPLETE: &str = "transcription:complete";
pub(crate) const EVENT_TRANSCRIPTION_ERROR: &str = "transcription:error";
pub(crate) const EVENT_SETTINGS_CHANGED: &str = "settings:changed";
pub(crate) const EVENT_LICENSE_CHECKOUT_RETURNED: &str = "license:checkout-returned";
pub(crate) const FEEDBACK_URL: &str = "https://github.com/glimpse-hq/Glimpse/issues/new/choose";
#[cfg(target_os = "windows")]
pub(crate) const FFMPEG_HELP_URL: &str =
    "https://github.com/glimpse-hq/Glimpse/wiki/ffmpeg-windows";
#[cfg(not(target_os = "windows"))]
pub(crate) const FFMPEG_HELP_URL: &str = "https://github.com/glimpse-hq/Glimpse/wiki/ffmpeg-mac";

fn launched_via_autostart() -> bool {
    if std::env::args_os().any(|arg| arg == "--autostart") {
        return true;
    }
    // Store builds start via the MSIX StartupTask, which passes no args.
    #[cfg(target_os = "windows")]
    if platform::windows::store::is_msix_packaged() {
        return platform::windows::store::launched_via_startup_task();
    }
    false
}

fn should_start_in_background(launched_via_autostart: bool, start_in_background: bool) -> bool {
    launched_via_autostart && start_in_background
}

fn register_deep_link_handlers(app: &tauri::App<AppRuntime>) {
    let handle = app.handle().clone();

    if let Ok(Some(urls)) = app.deep_link().get_current() {
        handle_deep_link_urls(&handle, urls.into_iter().map(|url| url.to_string()));
    }

    app.deep_link().on_open_url(move |event| {
        handle_deep_link_urls(&handle, event.urls().iter().map(|url| url.to_string()));
    });
}

fn handle_deep_link_urls<I, S>(app: &AppHandle<AppRuntime>, urls: I)
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for raw_url in urls {
        let raw_url = raw_url.as_ref();
        if !license::is_license_deep_link(raw_url) {
            continue;
        }

        if let Err(err) = license::handle_deep_link(app) {
            tracing::error!("{err}");
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn sync_launch_at_login(
    app: &AppHandle<AppRuntime>,
    enabled: bool,
) -> Result<(), String> {
    // MSIX virtualizes the Run registry key, so store builds go through
    // the StartupTask declared in the package manifest instead.
    #[cfg(target_os = "windows")]
    if platform::windows::store::is_msix_packaged() {
        if platform::windows::store::startup_task_enabled()? == enabled {
            return Ok(());
        }
        return platform::windows::store::set_startup_task_enabled(enabled);
    }

    let autostart = app.autolaunch();
    let currently_enabled = autostart
        .is_enabled()
        .map_err(|err| format!("Failed to read launch at login status: {err}"))?;

    if currently_enabled == enabled {
        return Ok(());
    }

    if enabled {
        autostart
            .enable()
            .map_err(|err| format!("Failed to enable launch at login: {err}"))?;
    } else {
        autostart
            .disable()
            .map_err(|err| format!("Failed to disable launch at login: {err}"))?;
    }

    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn sync_launch_at_login(
    _app: &AppHandle<AppRuntime>,
    _enabled: bool,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn handle_app_menu_event(app: &AppHandle<AppRuntime>, id: &str) {
    use crate::recent_transcriptions::{
        MENU_ID_RECENT_TRANSCRIPTION_PREFIX, copy_transcription_to_clipboard,
    };
    use crate::speech::menu::handle_speech_menu_event;
    use platform::macos::menu::{
        MENU_ID_CHECK_UPDATES, MENU_ID_MIC_DEFAULT, MENU_ID_MIC_PREFIX, MENU_ID_REPORT_ISSUE,
        MENU_ID_WEBSITE,
    };
    use tauri_plugin_opener::OpenerExt;

    if let Some(saved) = handle_speech_menu_event(app, id) {
        refresh_speech_menus(app, &saved);
        return;
    }

    match id {
        MENU_ID_CHECK_UPDATES => {
            let _ = tray::open_settings_about(app);
        }
        MENU_ID_WEBSITE => {
            let _ = app
                .opener()
                .open_url("https://tryglimpse.cc/", None::<&str>);
        }
        MENU_ID_REPORT_ISSUE => {
            let _ = app.opener().open_url(FEEDBACK_URL, None::<&str>);
        }
        MENU_ID_MIC_DEFAULT => {
            set_microphone(app, None);
        }
        _ => {
            if let Some(transcription_id) = id.strip_prefix(MENU_ID_RECENT_TRANSCRIPTION_PREFIX) {
                copy_transcription_to_clipboard(app, transcription_id);
            } else if let Some(device_id_raw) = id.strip_prefix(MENU_ID_MIC_PREFIX) {
                let device_id = device_id_raw.strip_prefix("dev:").unwrap_or(device_id_raw);
                set_microphone(app, Some(device_id));
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn refresh_speech_menus(app: &AppHandle<AppRuntime>, settings: &settings::UserSettings) {
    if let Err(err) = set_app_menu(app, settings) {
        tracing::error!("Failed to refresh app menu: {err}");
    }
    if let Err(err) = tray::refresh_tray_menu(app, settings) {
        tracing::error!("Failed to refresh tray menu: {err}");
    }
}

#[cfg(target_os = "macos")]
fn set_microphone(app: &AppHandle<AppRuntime>, device_id: Option<&str>) {
    let state = app.state::<AppState>();
    let mut current = state.current_settings_unmasked();
    if current.microphone_device.as_deref() == device_id {
        return;
    }
    let previous = current.clone();
    current.microphone_device = device_id.map(|id| id.to_string());
    match state.persist_settings(current.clone()) {
        Ok(saved) => {
            analytics::track_settings_changes(app, &previous, &saved);
            refresh_speech_menus(app, &saved);
            state.emit_settings_changed(app, &saved);
        }
        Err(err) => tracing::error!("Failed to update microphone selection: {err}"),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn set_app_menu(
    app: &AppHandle<AppRuntime>,
    settings: &settings::UserSettings,
) -> tauri::Result<()> {
    let menu = platform::macos::menu::build_app_menu(app, settings)?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn run_cli() -> Result<()> {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    if let Some(integration_args) = normalized_integration_args(&args) {
        let context = app_context();
        return integrations::dispatch(&context.config().identifier, &integration_args);
    }

    if cli_help_requested(std::env::args_os().skip(1)) {
        // Top-level `--help`/`-h`/`help` renders one unified listing here; a
        // subcommand's own help (e.g. `models --help`) is left to glimpse-speech.
        if is_top_level_help(&args) {
            integrations::print_help();
            return Ok(());
        }
        return glimpse_speech::cli::run_blocking();
    }

    let context = app_context();
    let settings_store = SettingsStore::for_cli(&context.config().identifier)?;
    let cache_active_before_refresh = license::active_license_gate(&settings_store);
    if license::secure_grant_refresh_needed(&settings_store).map_err(anyhow::Error::msg)? {
        let runtime = tokio::runtime::Runtime::new()?;
        if let Err(err) = runtime.block_on(license::refresh_license(Client::new(), &settings_store))
            && !cache_active_before_refresh
        {
            anyhow::bail!(
                "An active Glimpse license is required to use the CLI.\n\
                     The saved license could not be refreshed: {err}\n\
                     Open Glimpse > Settings > Account to check or activate your license."
            );
        }
    }
    if !license::active_license_gate(&settings_store) {
        anyhow::bail!(
            "An active Glimpse license is required to use the CLI.\n\
             Open Glimpse > Settings > Account to check or activate your license."
        );
    }

    glimpse_speech::cli::run_blocking()
}

fn normalized_integration_args(args: &[String]) -> Option<Vec<String>> {
    let mut index = 0;
    let mut json = false;

    while let Some(arg) = args.get(index) {
        match arg.as_str() {
            "--json" => {
                json = true;
                index += 1;
            }
            "--cache-dir" => {
                args.get(index + 1)?;
                index += 2;
            }
            value if value.starts_with("--cache-dir=") => index += 1,
            _ => break,
        }
    }

    let verb = args.get(index)?;
    if !integrations::is_integration_command(verb) {
        return None;
    }

    let mut normalized = Vec::with_capacity(args.len());
    normalized.push(verb.clone());
    normalized.extend_from_slice(&args[index + 1..]);
    if json && !normalized.iter().any(|arg| arg == "--json") {
        normalized.push("--json".to_string());
    }
    Some(normalized)
}

fn app_context() -> tauri::Context<AppRuntime> {
    tauri::generate_context!()
}

fn cli_help_requested(args: impl IntoIterator<Item = std::ffi::OsString>) -> bool {
    for (index, arg) in args.into_iter().enumerate() {
        if arg == "--" {
            return false;
        }
        if matches!(arg.to_str(), Some("-h" | "--help")) {
            return true;
        }
        if index == 0 && arg == "help" {
            return true;
        }
    }

    false
}

fn is_top_level_help(args: &[String]) -> bool {
    matches!(args, [arg] if matches!(arg.as_str(), "-h" | "--help" | "help"))
}

pub fn run() {
    let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
    let _guard = rt.enter();
    tauri::async_runtime::set(rt.handle().clone());

    let builder = tauri::Builder::default();

    #[cfg(target_os = "windows")]
    let builder = builder.device_event_filter(tauri::DeviceEventFilter::Always);

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        if let Err(err) = tray::toggle_settings_window(app) {
            tracing::error!("Failed to focus window on second instance: {err}");
        }

        handle_deep_link_urls(app, argv.into_iter().skip(1));
    }));

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        Some(vec!["--autostart"]),
    ));

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_permissions::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    #[cfg(target_os = "macos")]
    let builder = builder.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        handle_app_menu_event(app, id);
    });

    builder
        .setup(|app| {
            analytics::set_crash_phase("setup_start");
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);

            let handle = app.handle();
            analytics::set_crash_phase("logging");
            init_logging(handle);
            analytics::set_crash_phase("crash_handler");
            let crash_marker = handle
                .path()
                .app_data_dir()
                .ok()
                .map(|dir| dir.join("last_crash.txt"));
            let crash_log = handle.path().app_log_dir().ok().map(|dir| {
                let _ = std::fs::create_dir_all(&dir);
                dir.join("crash.log")
            });
            if let Some(path) = crash_marker.clone() {
                analytics::install_crash_handler(path.clone(), crash_log);
                #[cfg(target_os = "windows")]
                if let Ok(log_dir) = handle.path().app_log_dir() {
                    platform::windows::crash::install(log_dir, path);
                }
            }
            analytics::set_crash_phase("settings_load");
            let settings_store = Arc::new(SettingsStore::new(handle)?);
            let mut settings = settings_store.load().unwrap_or_default();
            if model_manager::definition(&settings.local_model).is_none() {
                settings.local_model = default_local_model();
                if let Err(err) = settings_store.save(&settings) {
                    tracing::error!("Failed to persist default local model: {err}");
                }
            }

            analytics::set_crash_phase("app_state");
            app.manage(AppState::new(Arc::clone(&settings_store), settings, handle));
            {
                let h = handle.clone();
                async_runtime::spawn(async move {
                    let state = h.state::<AppState>();
                    match license::secure_grant_refresh_needed(&state.settings_store) {
                        Ok(true) => {
                            if let Err(err) =
                                license::refresh_license(state.http(), &state.settings_store).await
                            {
                                tracing::warn!("Could not refresh the saved license: {err}");
                            }
                        }
                        Ok(false) => {}
                        Err(err) => tracing::warn!("Could not inspect the saved license: {err}"),
                    }

                    // Start after the refresh so the license gate reflects current state.
                    let settings = state.current_settings();
                    local_api::start_from_settings(&h, &settings);
                });
            }
            analytics::set_crash_phase("services");
            integrations::start_control_server(handle.clone());
            library::commands::recover_interrupted_library_items(handle);
            register_deep_link_handlers(app);

            #[cfg(target_os = "macos")]
            {
                let h = handle.clone();
                handle.listen(library::EVENT_LIBRARY_RENDERER_READY, move |_| {
                    library::commands::mark_library_import_renderer_ready(&h);
                });
            }

            {
                let h = handle.clone();
                handle.listen(tray::EVENT_SETTINGS_RENDERER_READY, move |_| {
                    tray::mark_settings_renderer_ready(&h);
                });
            }

            {
                let handle = app.handle();
                let settings = handle.state::<AppState>().current_settings();
                if let Err(err) = sync_launch_at_login(handle, settings.auto_launch_enabled) {
                    tracing::error!("Failed to sync launch at login state: {err}");
                }
            }

            #[cfg(target_os = "macos")]
            {
                let handle = app.handle();
                let settings = handle.state::<AppState>().current_settings();
                if let Err(err) = set_app_menu(handle, &settings) {
                    tracing::error!("Failed to set app menu: {err}");
                }
                if let Err(err) = platform::macos::audio_devices::init(handle) {
                    tracing::error!("Failed to initialize input device watcher: {err}");
                }
            }

            if let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.hide();
                platform::overlay::init(handle, &window);
            }

            if let Some(toast_window) = handle.get_webview_window(toast::WINDOW_LABEL) {
                let _ = toast_window.hide();
                platform::toast::init(handle, &toast_window);
            }

            if let Some(settings_window) = handle.get_webview_window(SETTINGS_WINDOW_LABEL) {
                platform::settings_window::init(&settings_window);
            }

            analytics::set_crash_phase("tray_shortcuts");
            if let Ok(tray) = tray::build_tray(handle) {
                handle.state::<AppState>().store_tray(tray);
            }

            if let Err(err) = pill::register_shortcuts(handle) {
                tracing::error!("Failed to register shortcuts: {err}");
            }

            let state = handle.state::<AppState>();
            if state.should_open_settings_on_startup() {
                let _ = tray::toggle_settings_window(handle);
            }

            update_checker::check_post_auto_update(handle);

            analytics::set_crash_phase("background_tasks");
            if platform::is_store_build() {
                tracing::info!("store build: built-in updater disabled");
            } else {
                let update_handle = handle.clone();
                let update_state = handle.state::<AppState>().update_state().clone();
                update_checker::start_background_checker(update_handle, update_state);
            }

            handle
                .state::<AppState>()
                .start_preflight_loop(handle.clone());

            {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    analytics::set_crash_phase("analytics_init");
                    analytics::init(&h).await;
                    if let Some(path) = crash_marker {
                        analytics::report_pending_crash(&h, &path);
                    }
                    if h.state::<AppState>().analytics_first_run() {
                        analytics::track_app_installed(&h);
                    }
                    analytics::track_app_started(&h);
                    analytics::set_crash_phase("running");
                });
            }

            analytics::set_crash_phase("recording_recovery");
            transcribe::recover_interrupted_recordings(handle);

            analytics::set_crash_phase("running");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_shortcut_capture_active,
            update_settings,
            get_license_state,
            activate_license,
            refresh_license,
            deactivate_license,
            get_dictation_stats,
            preview_recording_prune,
            preview_transcription_prune,
            dictionary::set_dictionary,
            dictionary::get_replacements,
            dictionary::set_replacements,
            auto_dictionary::accept_auto_dictionary_suggestion,
            auto_dictionary::reject_auto_dictionary_suggestion,
            personalization::get_personalities,
            personalization::set_personalities,
            personalization::list_installed_apps,
            personalization::list_website_icons,
            import::commands::detect_importable_apps,
            import::commands::preview_import,
            import::commands::apply_import,
            get_app_info,
            open_data_dir,
            get_transcriptions_page,
            get_today_dictation_stats,
            delete_transcription,
            retry_transcription,
            retry_llm_cleanup,
            undo_llm_cleanup,
            cancel_retry_transcription,
            library::commands::create_library_item,
            library::commands::get_library_items_page,
            library::commands::update_library_item,
            library::commands::delete_library_item,
            library::commands::cancel_library_transcription,
            library::commands::retry_library_transcription,
            library::commands::export_library_item_to_path,
            library::commands::get_library_tags,
            library::commands::probe_library_import_files,
            model_manager::list_models,
            model_manager::check_model_status,
            model_manager::download_model,
            model_manager::delete_model,
            model_manager::cancel_download,
            list_speech_models,
            local_api::get_local_api_status,
            local_api::start_local_api,
            local_api::stop_local_api,
            local_api::clear_local_api_logs,
            cli_install::get_cli_install_status,
            cli_install::install_cli,
            cli_install::remove_cli,
            audio::list_input_devices,
            toast::toast_dismissed,
            open_accessibility_settings,
            check_accessibility_permission,
            check_microphone_permission,
            request_microphone_permission,
            open_microphone_settings,
            open_input_monitoring_settings,
            open_llm_cleanup_settings,
            open_ffmpeg_install,
            complete_onboarding,
            cancel_recording,
            view_recovered_transcriptions,
            copy_last_transcription,
            reset_onboarding,
            toast::debug_show_toast,
            analytics::report_frontend_crash,
            analytics::track_onboarding_step_viewed,
            fetch_llm_models,
            apple_llm_availability,
            fetch_remote_speech_models,
            open_about_page,
            reveal_logs,
            update_checker::get_update_status,
            update_checker::check_for_updates,
            update_checker::download_and_install_update
        ])
        .build(app_context())
        .expect("error while building tauri application")
        .run(|handler, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                if let Err(err) = library::handle_opened_paths(handler, paths) {
                    tracing::error!("Failed to handle opened files: {err}");
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                if !has_visible_windows {
                    let _ = tray::toggle_settings_window(handler);
                }
            }
            tauri::RunEvent::Exit => {
                // Quit-time panics (e.g. tao's Windows event-loop teardown)
                // should not report as crashes while running.
                analytics::set_crash_phase("shutdown");
                let state = handler.state::<AppState>();
                state.local_transcriber.unload();
                state.stop_preflight_loop();
                let now = Instant::now();
                let counters = state.session_counters.lock();
                analytics::track_app_exited(
                    handler,
                    (now - state.session_started_at).as_secs_f64(),
                    counters.transcription_count,
                );
            }
            _ => {}
        });
}

#[cfg(test)]
mod cli_tests {
    use super::{cli_help_requested, is_top_level_help, normalized_integration_args};
    use std::ffi::OsString;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn cli_help_does_not_require_a_license() {
        assert!(cli_help_requested(args(&["--help"])));
        assert!(cli_help_requested(args(&["transcribe", "--help"])));
        assert!(cli_help_requested(args(&["help", "transcribe"])));
    }

    #[test]
    fn cli_commands_and_positional_help_names_require_a_license() {
        assert!(!cli_help_requested(args(&["models", "list"])));
        assert!(!cli_help_requested(args(&["transcribe", "--", "--help",])));
    }

    #[test]
    fn top_level_help_excludes_subcommand_help() {
        assert!(is_top_level_help(&["--help".into()]));
        assert!(is_top_level_help(&["-h".into()]));
        assert!(is_top_level_help(&["help".into()]));
        assert!(!is_top_level_help(&["help".into(), "models".into()]));
        assert!(!is_top_level_help(&["models".into(), "--help".into()]));
    }

    #[test]
    fn integration_commands_accept_leading_global_options() {
        assert_eq!(
            normalized_integration_args(&[
                "--cache-dir".into(),
                "/tmp/models".into(),
                "--json".into(),
                "history".into(),
                "list".into(),
            ]),
            Some(vec!["history".into(), "list".into(), "--json".into()])
        );
        assert!(normalized_integration_args(&["--cache-dir".into(), "status".into(),]).is_none());
    }
}

pub(crate) type AppRuntime = Wry;

type GlimpseResult<T> = Result<T>;

#[derive(Clone)]
pub struct LibraryJob {
    pub id: String,
    pub kind: LibraryJobKind,
}

#[derive(Clone)]
pub enum LibraryJobKind {
    Import {
        source_path: PathBuf,
        store_original: bool,
    },
    TranscribeExisting,
}

pub struct AppState {
    pill: Arc<PillController>,
    http: Client,
    pub(crate) local_transcriber: Arc<local_transcription::LocalTranscriber>,
    storage: Arc<storage::StorageManager>,
    pub(crate) settings_store: Arc<SettingsStore>,
    settings: parking_lot::Mutex<UserSettings>,
    hotkeys: core::hotkeys::HotkeyCoordinator,
    shortcut_capture_active: AtomicBool,
    pub(crate) tray: parking_lot::Mutex<Option<TrayIcon<AppRuntime>>>,
    pub(crate) settings_close_handler_registered: AtomicBool,
    transcription_cancelled: AtomicBool,
    transcription_token: parking_lot::Mutex<Option<CancellationToken>>,
    ffmpeg_toast_shown: AtomicBool,
    pending_recording_path: parking_lot::Mutex<Option<PathBuf>>,
    pending_selected_text: parking_lot::Mutex<Option<String>>,
    download_tokens: parking_lot::Mutex<HashMap<String, CancellationToken>>,
    library_tokens: parking_lot::Mutex<HashMap<String, CancellationToken>>,
    library_queue: parking_lot::Mutex<VecDeque<LibraryJob>>,
    library_active: parking_lot::Mutex<Option<String>>,
    retry_tokens: parking_lot::Mutex<HashMap<String, CancellationToken>>,
    pub(crate) local_api: Arc<local_api::LocalApiController>,
    update_state: update_checker::SharedUpdateState,
    auto_update_completed: AtomicBool,
    preflight_cancel: CancellationToken,
    preflight_started: AtomicBool,
    preflight_notify: Arc<Notify>,
    session_started_at: Instant,
    session_counters: parking_lot::Mutex<SessionCounters>,
    streaming_session: parking_lot::Mutex<Option<streaming_transcription::StreamingSession>>,
    should_start_in_background: bool,
}

#[derive(Clone, Copy)]
struct SessionCounters {
    transcription_count: u32,
}

impl AppState {
    pub fn new(
        settings_store: Arc<SettingsStore>,
        settings: UserSettings,
        app_handle: &AppHandle<AppRuntime>,
    ) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("Failed to build HTTP client");

        let storage_path = app_handle
            .path()
            .app_data_dir()
            .expect("Failed to resolve app data directory")
            .join("transcriptions.db");

        let storage = storage::StorageManager::new(storage_path)
            .expect("Failed to initialize transcription storage");

        let recorder = Arc::new(RecorderManager::new());
        let should_start_in_background =
            should_start_in_background(launched_via_autostart(), settings.start_in_background);

        let model_cache_dir = model_manager::model_cache_dir(app_handle)
            .expect("Failed to resolve local model cache directory");
        let local_transcriber =
            Arc::new(local_transcription::LocalTranscriber::new(model_cache_dir));
        local_transcriber.start_idle_monitor();

        Self {
            pill: Arc::new(PillController::new(Arc::clone(&recorder))),
            http,
            local_transcriber,
            storage: Arc::new(storage),
            settings_store,
            settings: parking_lot::Mutex::new(settings),
            hotkeys: core::hotkeys::HotkeyCoordinator::default(),
            shortcut_capture_active: AtomicBool::new(false),
            tray: parking_lot::Mutex::new(None),
            settings_close_handler_registered: AtomicBool::new(false),
            transcription_cancelled: AtomicBool::new(false),
            transcription_token: parking_lot::Mutex::new(None),
            ffmpeg_toast_shown: AtomicBool::new(false),
            pending_recording_path: parking_lot::Mutex::new(None),
            pending_selected_text: parking_lot::Mutex::new(None),
            download_tokens: parking_lot::Mutex::new(HashMap::new()),
            library_tokens: parking_lot::Mutex::new(HashMap::new()),
            library_queue: parking_lot::Mutex::new(VecDeque::new()),
            library_active: parking_lot::Mutex::new(None),
            retry_tokens: parking_lot::Mutex::new(HashMap::new()),
            local_api: Arc::new(local_api::LocalApiController::default()),
            update_state: update_checker::create_state(),
            auto_update_completed: AtomicBool::new(false),
            preflight_cancel: CancellationToken::new(),
            preflight_started: AtomicBool::new(false),
            preflight_notify: Arc::new(Notify::new()),
            session_started_at: Instant::now(),
            session_counters: parking_lot::Mutex::new(SessionCounters {
                transcription_count: 0,
            }),
            streaming_session: parking_lot::Mutex::new(None),
            should_start_in_background,
        }
    }

    pub fn should_open_settings_on_startup(&self) -> bool {
        !self.should_start_in_background
    }

    pub fn start_streaming_session(
        &self,
        app: &AppHandle<AppRuntime>,
        model: &model_manager::ReadyModel,
    ) {
        let _ = self.stop_streaming_session(app);
        let session = streaming_transcription::StreamingSession::start(app, model);
        *self.streaming_session.lock() = Some(session);
    }

    pub fn stop_streaming_session(&self, app: &AppHandle<AppRuntime>) -> Option<String> {
        let session = self.streaming_session.lock().take()?;
        Some(session.stop(app))
    }

    pub fn has_streaming_session(&self) -> bool {
        self.streaming_session.lock().is_some()
    }

    /// Read analytics state from the in-memory cache (single lock acquisition).
    pub fn analytics_state(&self) -> (bool, String) {
        let s = self.settings.lock();
        (s.analytics_enabled, s.analytics_install_id.clone())
    }

    pub fn analytics_first_run(&self) -> bool {
        self.settings.lock().analytics_first_run
    }

    /// Read auto-update setting from the in-memory cache (no DB hit).
    pub fn is_auto_update_enabled(&self) -> bool {
        self.settings.lock().auto_update_enabled
    }

    pub fn is_backend_idle(&self) -> bool {
        self.download_tokens.lock().is_empty()
            && self.library_active.lock().is_none()
            && self.library_queue.lock().is_empty()
            && self.retry_tokens.lock().is_empty()
    }

    pub fn set_auto_update_completed(&self) {
        self.auto_update_completed.store(true, Ordering::SeqCst);
    }

    pub fn take_auto_update_completed(&self) -> bool {
        self.auto_update_completed.swap(false, Ordering::SeqCst)
    }

    pub fn current_settings(&self) -> UserSettings {
        self.settings_for_response(self.settings.lock().clone())
    }

    pub(crate) fn current_settings_unmasked(&self) -> UserSettings {
        self.settings.lock().clone()
    }

    pub(crate) fn settings_for_response(&self, mut settings: UserSettings) -> UserSettings {
        if !license::license_gate_active(&self.settings_store) {
            disable_license_gated_settings(&mut settings);
        }
        if !license::active_license_gate(&self.settings_store) {
            settings.local_api_start_on_launch = false;
        }
        settings
    }

    pub(crate) fn emit_settings_changed(
        &self,
        app: &AppHandle<AppRuntime>,
        settings: &UserSettings,
    ) {
        let response = self.settings_for_response(settings.clone());
        if let Err(err) = app.emit(EVENT_SETTINGS_CHANGED, &response) {
            tracing::error!("Failed to emit settings change: {err}");
        }
    }

    pub fn persist_settings(&self, next: UserSettings) -> GlimpseResult<UserSettings> {
        let mut guard = self.settings.lock();
        let next = Self::canonicalize_and_save(&self.settings_store, next)?;
        *guard = next.clone();
        Ok(next)
    }

    pub(crate) fn persist_settings_with(
        &self,
        mutate: impl FnOnce(&UserSettings, &mut UserSettings),
    ) -> GlimpseResult<(UserSettings, UserSettings)> {
        let mut guard = self.settings.lock();
        let prev = guard.clone();
        let mut next = prev.clone();
        mutate(&prev, &mut next);
        let next = Self::canonicalize_and_save(&self.settings_store, next)?;
        *guard = next.clone();
        Ok((prev, next))
    }

    fn canonicalize_and_save(
        store: &SettingsStore,
        mut next: UserSettings,
    ) -> GlimpseResult<UserSettings> {
        if matches!(next.transcription_mode, TranscriptionMode::Cloud) {
            next.transcription_mode = TranscriptionMode::Local;
        }
        settings::sync_legacy_shortcuts_from_bindings(&mut next);
        next.auto_delete_duration =
            settings::canonicalize_recording_prune_policy(next.auto_delete_duration);

        store.save(&next)?;
        Ok(next)
    }

    pub fn pill(&self) -> &PillController {
        &self.pill
    }

    pub fn set_shortcut_capture_active(&self, active: bool) {
        self.shortcut_capture_active.store(active, Ordering::SeqCst);
    }

    pub fn is_shortcut_capture_active(&self) -> bool {
        self.shortcut_capture_active.load(Ordering::SeqCst)
    }

    pub fn record_transcription_completed(&self) {
        self.session_counters.lock().transcription_count += 1;
    }

    pub(crate) fn http(&self) -> Client {
        self.http.clone()
    }

    pub(crate) fn local_transcriber(&self) -> Arc<local_transcription::LocalTranscriber> {
        Arc::clone(&self.local_transcriber)
    }

    fn storage(&self) -> Arc<storage::StorageManager> {
        Arc::clone(&self.storage)
    }

    pub fn store_tray(&self, tray: TrayIcon<AppRuntime>) {
        *self.tray.lock() = Some(tray);
    }

    pub fn request_cancellation(&self) {
        self.transcription_cancelled.store(true, Ordering::SeqCst);
        if let Some(token) = self.transcription_token.lock().as_ref() {
            token.cancel();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.transcription_cancelled.load(Ordering::SeqCst)
    }

    pub fn clear_cancellation(&self) {
        self.transcription_cancelled.store(false, Ordering::SeqCst);
        *self.transcription_token.lock() = None;
    }

    pub fn create_transcription_token(&self) -> CancellationToken {
        let token = CancellationToken::new();
        *self.transcription_token.lock() = Some(token.clone());
        token
    }

    pub fn should_show_ffmpeg_toast(&self) -> bool {
        self.ffmpeg_toast_shown
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn set_pending_path(&self, path: Option<PathBuf>) {
        *self.pending_recording_path.lock() = path;
    }

    pub fn take_pending_path(&self) -> Option<PathBuf> {
        self.pending_recording_path.lock().take()
    }

    pub fn set_pending_selected_text(&self, text: Option<String>) {
        *self.pending_selected_text.lock() = text;
    }

    pub fn take_pending_selected_text(&self) -> Option<String> {
        self.pending_selected_text.lock().take()
    }

    pub fn create_download_token(&self, model: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.download_tokens
            .lock()
            .insert(model.to_string(), token.clone());
        token
    }

    pub fn cancel_download(&self, model: &str) -> bool {
        match self.download_tokens.lock().remove(model) {
            Some(token) => {
                token.cancel();
                true
            }
            _ => false,
        }
    }

    pub fn clear_download_token(&self, model: &str) {
        self.download_tokens.lock().remove(model);
    }

    pub fn register_library_transcription(&self, id: String) -> CancellationToken {
        let mut tokens = self.library_tokens.lock();
        if let Some(token) = tokens.get(&id) {
            return token.clone();
        }
        let token = CancellationToken::new();
        tokens.insert(id, token.clone());
        token
    }

    pub fn enqueue_library_job(&self, job: LibraryJob) -> bool {
        if self.library_tokens.lock().contains_key(&job.id) {
            return false;
        }
        if self.library_active.lock().as_deref() == Some(&job.id) {
            return false;
        }
        let mut queue = self.library_queue.lock();
        if queue.iter().any(|queued| queued.id == job.id) {
            return false;
        }
        queue.push_back(job);
        true
    }

    pub fn claim_next_library_job(&self) -> Option<LibraryJob> {
        let mut active = self.library_active.lock();
        if active.is_some() {
            return None;
        }
        let mut queue = self.library_queue.lock();
        let next = queue.pop_front()?;
        *active = Some(next.id.clone());
        Some(next)
    }

    pub fn clear_active_library_job(&self, id: &str) {
        let mut active = self.library_active.lock();
        if active.as_deref() == Some(id) {
            *active = None;
        }
    }

    pub fn remove_library_job(&self, id: &str) -> bool {
        let mut queue = self.library_queue.lock();
        let before = queue.len();
        queue.retain(|queued| queued.id != id);
        before != queue.len()
    }

    pub fn cancel_library_transcription(&self, id: &str) {
        if let Some(token) = self.library_tokens.lock().get(id) {
            token.cancel();
        }
    }

    pub fn clear_library_transcription(&self, id: &str) {
        self.library_tokens.lock().remove(id);
    }

    pub fn register_retry_transcription(&self, id: String) -> CancellationToken {
        let token = CancellationToken::new();
        self.retry_tokens.lock().insert(id, token.clone());
        token
    }

    pub fn cancel_retry_transcription(&self, id: &str) -> bool {
        match self.retry_tokens.lock().remove(id) {
            Some(token) => {
                token.cancel();
                true
            }
            _ => false,
        }
    }

    pub fn clear_retry_transcription(&self, id: &str) {
        self.retry_tokens.lock().remove(id);
    }

    pub fn start_preflight_loop(&self, app: AppHandle<AppRuntime>) {
        if self.preflight_started.swap(true, Ordering::SeqCst) {
            return;
        }

        let token = self.preflight_cancel.clone();
        let notify = Arc::clone(&self.preflight_notify);

        async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(llm_cleanup::PREFLIGHT_TTL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut refresh_pending = false;

            loop {
                tokio::select! {
                    _ = token.cancelled() => break,
                    _ = notify.notified() => {
                        refresh_pending = true;
                    }
                    _ = ticker.tick() => {}
                }

                if token.is_cancelled() {
                    break;
                }

                if !refresh_pending {
                    // If woken by ticker, check if cache is still fresh (< TTL).
                    // Returns None when cache is expired, triggering refresh below.
                    if llm_cleanup::cached_preflight_available().is_some() {
                        continue;
                    }
                }

                let state = app.state::<AppState>();
                let settings = state.current_settings();
                llm_cleanup::run_preflight(state.http(), settings).await;
                refresh_pending = false;
            }
        });
    }

    pub fn stop_preflight_loop(&self) {
        self.preflight_cancel.cancel();
    }

    pub fn request_preflight_refresh(&self) {
        llm_cleanup::clear_preflight_cache();
        self.preflight_notify.notify_one();
    }

    pub fn update_state(&self) -> &update_checker::SharedUpdateState {
        &self.update_state
    }
}

fn disable_license_gated_settings(settings: &mut UserSettings) {
    settings.llm_enabled = false;
    settings.cleanup_enabled = false;
    settings.edit_mode_enabled = false;
    for binding in settings
        .shortcut_bindings
        .smart
        .iter_mut()
        .chain(settings.shortcut_bindings.hold.iter_mut())
        .chain(settings.shortcut_bindings.toggle.iter_mut())
    {
        binding.cleanup_enabled = false;
    }
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Result<UserSettings, String> {
    Ok(state.current_settings())
}

#[tauri::command]
fn set_shortcut_capture_active(active: bool, app: AppHandle<AppRuntime>) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.set_shortcut_capture_active(active);

    if active {
        state.hotkeys.stop_registration();
        if let Err(err) = state.hotkeys.start_capture(&app) {
            state.set_shortcut_capture_active(false);
            if let Err(register_err) = pill::register_shortcuts(&app) {
                tracing::error!(
                    "Failed to restore shortcuts after capture start error: {register_err}"
                );
            }
            return Err(err.to_string());
        }
        return Ok(());
    }

    state.hotkeys.stop_capture();
    pill::register_shortcuts(&app).map_err(|err| err.to_string())
}

#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    permissions::open_accessibility_settings()
}

#[tauri::command]
fn check_accessibility_permission() -> bool {
    permissions::check_accessibility_permission()
}

#[tauri::command]
fn check_microphone_permission() -> bool {
    permissions::check_microphone_permission()
}

#[tauri::command]
fn request_microphone_permission() -> Result<(), String> {
    permissions::request_microphone_permission()
}

#[tauri::command]
fn open_microphone_settings() -> Result<(), String> {
    permissions::open_microphone_settings()
}

#[tauri::command]
fn open_input_monitoring_settings() -> Result<(), String> {
    permissions::open_input_monitoring_settings()
}

#[tauri::command]
fn open_llm_cleanup_settings(app: AppHandle<AppRuntime>) -> Result<(), String> {
    tray::open_settings_models(&app).map_err(|err| {
        tracing::error!("Failed to open settings window: {err}");
        err.to_string()
    })
}

#[tauri::command]
fn open_ffmpeg_install(app: AppHandle<AppRuntime>) -> Result<(), String> {
    app.opener()
        .open_url(FFMPEG_HELP_URL, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn complete_onboarding(
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    core::settings::complete_onboarding(&app, &state)
}

#[tauri::command]
fn reset_onboarding(
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    core::settings::reset_onboarding(&app, &state)
}

#[tauri::command]
fn update_settings(
    args: core::settings::UpdateSettingsArgs,
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<UserSettings, String> {
    core::settings::update_settings(args, &app, &state)
}

#[tauri::command]
fn get_license_state(state: tauri::State<AppState>) -> Result<license::LicenseState, String> {
    license::get_license_state(&state.settings_store)
}

#[tauri::command]
async fn activate_license(
    state: tauri::State<'_, AppState>,
    args: license::ActivateLicenseArgs,
) -> Result<license::LicenseState, String> {
    license::activate_license(state.http(), &state.settings_store, args).await
}

#[tauri::command]
async fn refresh_license(
    state: tauri::State<'_, AppState>,
) -> Result<license::LicenseState, String> {
    license::refresh_license(state.http(), &state.settings_store).await
}

#[tauri::command]
async fn deactivate_license(
    state: tauri::State<'_, AppState>,
) -> Result<license::LicenseState, String> {
    license::deactivate_license(state.http(), &state.settings_store).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationStats {
    total_words: u64,
    total_duration_ms: u64,
    total_dictations: u64,
}

#[tauri::command]
fn get_dictation_stats(state: tauri::State<AppState>) -> Result<DictationStats, String> {
    let stats = state
        .storage()
        .lifetime_stats()
        .map_err(|err| err.to_string())?;
    Ok(DictationStats {
        total_words: stats.words,
        total_duration_ms: stats.duration_ms,
        total_dictations: stats.dictations,
    })
}

#[derive(Serialize)]
struct RecordingPrunePreview {
    candidate_count: u32,
}

#[tauri::command]
async fn preview_recording_prune(
    policy: RecordingPrunePolicy,
    app: AppHandle<AppRuntime>,
) -> Result<RecordingPrunePreview, String> {
    let candidate_count =
        async_runtime::spawn_blocking(move || preview_recording_prune_for_policy(&app, policy))
            .await
            .map_err(|err| err.to_string())?
            .map_err(|err| err.to_string())?;

    Ok(RecordingPrunePreview { candidate_count })
}

#[tauri::command]
async fn preview_transcription_prune(
    policy: RecordingPrunePolicy,
    app: AppHandle<AppRuntime>,
) -> Result<RecordingPrunePreview, String> {
    let candidate_count = async_runtime::spawn_blocking(move || {
        transcribe::preview_transcription_prune_for_policy(&app, policy)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;

    Ok(RecordingPrunePreview { candidate_count })
}

#[derive(Serialize)]
struct StorageBreakdown {
    recordings_bytes: u64,
    library_bytes: u64,
    databases_bytes: u64,
    models_bytes: u64,
    total_bytes: u64,
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    data_dir_size_bytes: u64,
    data_dir_path: String,
    storage_breakdown: StorageBreakdown,
    store_build: bool,
    os_major: u32,
}

#[cfg(target_os = "macos")]
fn macos_major_version() -> u32 {
    static MAJOR: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *MAJOR.get_or_init(|| {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|version| version.trim().split('.').next()?.parse().ok())
            .unwrap_or(0)
    })
}

#[cfg(not(target_os = "macos"))]
fn macos_major_version() -> u32 {
    0
}

#[tauri::command]
fn get_app_info(app: AppHandle<AppRuntime>) -> Result<AppInfo, String> {
    let version = env!("CARGO_PKG_VERSION").to_string();

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let data_dir_path = data_dir.display().to_string();

    let recordings_bytes = calculate_dir_size(&data_dir.join("recordings")).unwrap_or(0);
    let library_bytes = calculate_dir_size(&data_dir.join("library")).unwrap_or(0);

    let databases_bytes = [
        "transcriptions.db",
        "transcriptions.db-wal",
        "transcriptions.db-shm",
    ]
    .iter()
    .map(|name| {
        std::fs::metadata(data_dir.join(name))
            .map(|m| m.len())
            .unwrap_or(0)
    })
    .sum::<u64>();

    let models_bytes = model_manager::model_cache_dir(&app)
        .ok()
        .map(|p| calculate_dir_size(&p).unwrap_or(0))
        .unwrap_or(0);

    let total_bytes = calculate_dir_size(&data_dir).unwrap_or(0);

    Ok(AppInfo {
        version,
        data_dir_size_bytes: total_bytes,
        data_dir_path,
        storage_breakdown: StorageBreakdown {
            recordings_bytes,
            library_bytes,
            databases_bytes,
            models_bytes,
            total_bytes,
        },
        store_build: platform::is_store_build(),
        os_major: macos_major_version(),
    })
}

#[tauri::command]
fn apple_llm_availability() -> String {
    use glimpse_speech::cleanup::AppleAvailability;
    match glimpse_speech::cleanup::CleanupProvider::apple_availability() {
        AppleAvailability::Available => "available",
        AppleAvailability::NotEnabled => "not_enabled",
        AppleAvailability::NotReady => "not_ready",
        AppleAvailability::Unsupported => "unsupported",
    }
    .to_string()
}

#[tauri::command]
async fn fetch_llm_models(
    endpoint: String,
    api_key: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    llm_cleanup::fetch_available_models(&state.http(), &endpoint, &api_key)
        .await
        .map_err(|error| llm_cleanup::llm_issue_message(&error))
}

#[tauri::command]
fn list_speech_models(
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
) -> Vec<speech::SpeechModel> {
    let settings = state.current_settings();
    speech::list_models(&app, &settings)
}

#[tauri::command]
async fn fetch_remote_speech_models(
    endpoint: String,
    api_key: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    if endpoint.trim().is_empty() {
        return Ok(Vec::new());
    }
    let config = glimpse_speech::provider::remote_config(endpoint, api_key, None);
    glimpse_speech::remote::RemoteEngine::new(state.http().clone(), config)
        .list_models()
        .await
        .map_err(|error| error.user_message())
}

#[tauri::command]
fn open_about_page(app: AppHandle<AppRuntime>) {
    if let Err(err) = tray::open_settings_about(&app) {
        tracing::error!("Failed to open settings window: {err}");
    }
}

#[tauri::command]
fn reveal_logs(app: AppHandle<AppRuntime>) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|err| err.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn open_data_dir(path: Option<String>, app: AppHandle<AppRuntime>) -> Result<(), String> {
    let path = path.ok_or_else(|| "Path is empty".to_string())?;
    let path = PathBuf::from(&path);

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;

    let canonical_path = path
        .canonicalize()
        .map_err(|_| "Path does not exist".to_string())?;
    let canonical_data_dir = data_dir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize data dir: {e}"))?;

    if !canonical_path.starts_with(&canonical_data_dir) {
        return Err("Path is outside app data directory".to_string());
    }

    app.opener()
        .reveal_item_in_dir(&canonical_path)
        .map_err(|err| format!("Failed to open path: {err}"))
}

fn calculate_dir_size(path: &std::path::Path) -> Result<u64> {
    let mut total_size = 0u64;

    if !path.exists() {
        return Ok(0);
    }

    if path.is_file() {
        return Ok(path.metadata()?.len());
    }

    if path.is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            let metadata = entry.metadata()?;

            if metadata.is_file() {
                total_size += metadata.len();
            } else if metadata.is_dir() {
                total_size += calculate_dir_size(&entry.path())?;
            }
        }
    }

    Ok(total_size)
}

#[tauri::command]
fn get_transcriptions_page(
    search: Option<String>,
    after_ms: Option<i64>,
    before_ms: Option<i64>,
    sort: storage::TranscriptionSort,
    limit: usize,
    offset: usize,
    state: tauri::State<AppState>,
) -> Result<storage::TranscriptionPage, String> {
    state
        .storage()
        .get_transcriptions_page(
            search.as_deref(),
            after_ms,
            before_ms,
            sort,
            limit.clamp(1, 200),
            offset,
        )
        .map_err(|err| format!("Failed to get transcriptions: {err}"))
}

#[tauri::command]
fn get_today_dictation_stats(
    start_ms: i64,
    end_ms: i64,
    state: tauri::State<AppState>,
) -> Result<storage::TodayDictationStats, String> {
    state
        .storage()
        .today_dictation_stats(start_ms, end_ms)
        .map_err(|err| format!("Failed to get today's dictation stats: {err}"))
}

#[tauri::command]
fn delete_transcription(
    id: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<bool, String> {
    let result = match state.storage().delete(&id) {
        Ok(Some(audio_path)) => {
            let path = PathBuf::from(audio_path);
            if path.exists() {
                let _ = std::fs::remove_file(path);
            }
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(err) => Err(format!("Failed to delete transcription: {err}")),
    }?;

    let settings = state.current_settings();
    if let Err(err) = tray::refresh_tray_menu(&app, &settings) {
        tracing::error!("Failed to refresh tray menu: {err}");
    }
    #[cfg(target_os = "macos")]
    if let Err(err) = set_app_menu(&app, &settings) {
        tracing::error!("Failed to refresh app menu: {err}");
    }

    Ok(result)
}

#[tauri::command]
async fn retry_transcription(
    id: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    core::transcriptions::retry_transcription(id, &app, &state)
}

#[tauri::command]
fn cancel_retry_transcription(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.cancel_retry_transcription(&id))
}

#[tauri::command]
async fn retry_llm_cleanup(
    id: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    core::transcriptions::retry_llm_cleanup(id, &app, &state)
}

#[tauri::command]
async fn undo_llm_cleanup(
    id: String,
    app: AppHandle<AppRuntime>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    core::transcriptions::undo_llm_cleanup(id, &app, &state)
}

pub(crate) fn hide_overlay(app: &AppHandle<AppRuntime>) {
    app.state::<AppState>().pill().reset(app);
}

pub(crate) fn stop_active_recording(app: &AppHandle<AppRuntime>) {
    app.state::<AppState>().pill().cancel(app);
}

#[tauri::command]
fn cancel_recording(app: AppHandle<AppRuntime>) {
    let state = app.state::<AppState>();
    if state.pill().status() == pill::PillStatus::Processing {
        state.pill().cancel_processing(&app);
    } else {
        stop_active_recording(&app);
        hide_overlay(&app);
    }
}

pub(crate) fn persist_recording_async(
    app: AppHandle<AppRuntime>,
    recording: CompletedRecording,
    settings: settings::UserSettings,
    temporary: bool,
    cancel_token: CancellationToken,
) {
    let input = if settings.microphone_device.is_some() {
        "selected"
    } else {
        "default"
    };
    let base_dir = match recordings_root(&app) {
        Ok(path) => path,
        Err(err) => {
            analytics::track_recording_failed(
                &app,
                "persist",
                analytics::classify_failure_reason(&err.to_string()),
                input,
            );
            emit_error(
                &app,
                format!("Failed to resolve recordings directory: {err}"),
            );
            return;
        }
    };

    // Validate before persisting so rejected recordings never touch disk.
    if let Err(rejection) = validate_recording(&recording) {
        let reason = match rejection {
            RecordingRejectionReason::TooShort {
                duration_ms,
                min_ms,
            } => {
                format!("Recording too short ({duration_ms}ms < {min_ms}ms minimum)")
            }
            RecordingRejectionReason::TooQuiet { rms, threshold } => {
                format!("Recording too quiet (energy {rms:.4} < {threshold} threshold)")
            }
            RecordingRejectionReason::NoSpeechDetected => {
                "No speech detected in recording".to_string()
            }
            RecordingRejectionReason::EmptyBuffer => "Recording buffer is empty".to_string(),
        };
        tracing::error!("Recording rejected: {reason}");

        if let Some(path) = recording.pending_path.as_deref() {
            let _ = std::fs::remove_file(path);
        }

        app.state::<AppState>().pill().finish_processing(&app);
        return;
    }

    async_runtime::spawn(async move {
        let task = async_runtime::spawn_blocking(move || {
            recorder::persist_recording(base_dir, &recording).map(|saved| (saved, recording))
        });
        match task.await {
            Ok(Ok((saved, recording))) => transcribe::queue_transcription(
                &app,
                saved,
                recording,
                settings,
                temporary,
                cancel_token,
            ),
            Ok(Err(err)) => {
                analytics::track_recording_failed(
                    &app,
                    "persist",
                    analytics::classify_failure_reason(&err.to_string()),
                    input,
                );
                emit_error(&app, format!("Unable to save recording: {err}"));
            }
            Err(err) => {
                analytics::track_recording_failed(
                    &app,
                    "persist",
                    analytics::classify_failure_reason(&err.to_string()),
                    input,
                );
                emit_error(&app, format!("Recording task failed: {err}"));
            }
        }
    });
}

pub(crate) fn emit_error(app: &AppHandle<AppRuntime>, message: String) {
    app.state::<AppState>()
        .pill()
        .transition_to_error(app, &message);
}

pub(crate) fn emit_event<T: Serialize + Clone>(
    app: &AppHandle<AppRuntime>,
    event: &str,
    payload: T,
) {
    if let Err(err) = app.emit(event, payload) {
        tracing::error!("Failed to emit {event}: {err}");
    }
}

pub(crate) fn recordings_root(app: &AppHandle<AppRuntime>) -> GlimpseResult<PathBuf> {
    let mut data_dir = app
        .path()
        .app_data_dir()
        .context("App data directory not found")?;
    data_dir.push("recordings");
    Ok(data_dir)
}

#[tauri::command]
fn view_recovered_transcriptions(app: AppHandle<AppRuntime>) -> Result<(), String> {
    tray::open_settings_history(&app).map_err(|err| err.to_string())
}

#[tauri::command]
fn copy_last_transcription(
    app: AppHandle<AppRuntime>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let recent = state
        .storage()
        .get_recent_transcriptions(1)
        .map_err(|err| format!("Failed to load transcriptions: {err}"))?;
    let Some(record) = recent.into_iter().next() else {
        return Err("No transcription to copy".to_string());
    };
    recent_transcriptions::copy_transcription_to_clipboard(&app, &record.id);
    Ok(())
}

pub(crate) fn schedule_recording_prune(app: AppHandle<AppRuntime>, settings: UserSettings) {
    if matches!(
        settings::auto_delete_recording_policy(&settings),
        RecordingPrunePolicy::Never
    ) {
        return;
    }

    async_runtime::spawn(async move {
        let app_handle = app.clone();
        match async_runtime::spawn_blocking(move || {
            prune_recordings_for_settings(&app_handle, &settings)
        })
        .await
        {
            Ok(Ok(count)) => emit_recording_history_refresh(&app, count),
            Ok(Err(err)) => tracing::error!("Failed to prune recordings: {err}"),
            Err(err) => tracing::error!("Recording prune task failed: {err}"),
        }
    });
}

pub(crate) fn schedule_transcription_prune(app: AppHandle<AppRuntime>, settings: UserSettings) {
    async_runtime::spawn(async move {
        let app_handle = app.clone();
        match async_runtime::spawn_blocking(move || {
            transcribe::run_transcription_prune_for_settings(&app_handle, &settings)
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(err)) => tracing::error!("Failed to prune transcriptions: {err}"),
            Err(err) => tracing::error!("Transcription prune task failed: {err}"),
        }
    });
}

fn emit_recording_history_refresh(app: &AppHandle<AppRuntime>, deleted_count: u32) {
    if deleted_count > 0 {
        let _ = app.emit(
            EVENT_TRANSCRIPTION_COMPLETE,
            TranscriptionCompletePayload {
                transcript: String::new(),
                auto_paste: false,
                record: None,
            },
        );
    }
}

fn prune_recordings_for_settings(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
) -> GlimpseResult<u32> {
    count_or_prune_recordings(
        app,
        settings::auto_delete_recording_policy(settings),
        Local::now(),
        RecordingPruneAction::Delete,
    )
}

fn preview_recording_prune_for_policy(
    app: &AppHandle<AppRuntime>,
    policy: RecordingPrunePolicy,
) -> GlimpseResult<u32> {
    count_or_prune_recordings(app, policy, Local::now(), RecordingPruneAction::Count)
}

enum RecordingPruneAction {
    Count,
    Delete,
}

fn count_or_prune_recordings(
    app: &AppHandle<AppRuntime>,
    policy: RecordingPrunePolicy,
    now: DateTime<Local>,
    action: RecordingPruneAction,
) -> GlimpseResult<u32> {
    let root = recordings_root(app)?;
    if !root.exists() || matches!(policy, RecordingPrunePolicy::Never) {
        return Ok(0);
    }

    let cutoff = settings::recording_prune_cutoff(policy, now);
    let (count, _) = match action {
        RecordingPruneAction::Count => count_prunable_recording_tree(&root, policy, cutoff)?,
        RecordingPruneAction::Delete => prune_recording_tree(&root, policy, cutoff)?,
    };
    Ok(count)
}

fn prune_recording_tree(
    path: &Path,
    policy: RecordingPrunePolicy,
    cutoff: Option<DateTime<Local>>,
) -> GlimpseResult<(u32, bool)> {
    let mut deleted_count = 0;
    let mut is_empty = true;

    for entry in fs::read_dir(path)
        .with_context(|| format!("Failed to read recordings directory {}", path.display()))?
    {
        let entry = entry?;
        let child_path = entry.path();
        let metadata = entry.metadata()?;

        if metadata.is_dir() {
            if is_pending_recordings_dir(&child_path) {
                is_empty = false;
                continue;
            }
            let (child_deleted, child_empty) = prune_recording_tree(&child_path, policy, cutoff)?;
            deleted_count += child_deleted;
            if child_empty {
                fs::remove_dir(&child_path).with_context(|| {
                    format!(
                        "Failed to remove empty recordings directory {}",
                        child_path.display()
                    )
                })?;
            } else {
                is_empty = false;
            }
            continue;
        }

        if should_prune_recording_file(&child_path, &metadata, policy, cutoff) {
            fs::remove_file(&child_path)
                .with_context(|| format!("Failed to remove recording {}", child_path.display()))?;
            deleted_count += 1;
        } else {
            is_empty = false;
        }
    }

    Ok((deleted_count, is_empty))
}

fn count_prunable_recording_tree(
    path: &Path,
    policy: RecordingPrunePolicy,
    cutoff: Option<DateTime<Local>>,
) -> GlimpseResult<(u32, bool)> {
    let mut candidate_count = 0;
    let mut is_empty = true;

    for entry in fs::read_dir(path)
        .with_context(|| format!("Failed to read recordings directory {}", path.display()))?
    {
        let entry = entry?;
        let child_path = entry.path();
        let metadata = entry.metadata()?;

        if metadata.is_dir() {
            if is_pending_recordings_dir(&child_path) {
                is_empty = false;
                continue;
            }
            let (child_count, child_empty) =
                count_prunable_recording_tree(&child_path, policy, cutoff)?;
            candidate_count += child_count;
            if !child_empty {
                is_empty = false;
            }
            continue;
        }

        if should_prune_recording_file(&child_path, &metadata, policy, cutoff) {
            candidate_count += 1;
        } else {
            is_empty = false;
        }
    }

    Ok((candidate_count, is_empty))
}

fn is_pending_recordings_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == recorder::PENDING_DIR_NAME)
}

fn should_prune_recording_file(
    path: &Path,
    metadata: &fs::Metadata,
    policy: RecordingPrunePolicy,
    cutoff: Option<DateTime<Local>>,
) -> bool {
    if !metadata.is_file() {
        return false;
    }

    let is_wav = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("wav"));
    if !is_wav {
        return false;
    }

    if matches!(policy, RecordingPrunePolicy::Immediately) {
        return true;
    }

    let Some(cutoff) = cutoff else {
        return false;
    };

    metadata
        .modified()
        .ok()
        .map(|modified| DateTime::<Local>::from(modified) <= cutoff)
        .unwrap_or(false)
}

#[derive(Serialize, Clone)]
pub(crate) struct RecordingStartPayload {
    pub(crate) started_at: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct AudioSpectrumPayload {
    pub(crate) bins: Vec<u8>,
}

#[derive(Serialize, Clone)]
pub(crate) struct TranscriptionCompletePayload {
    pub(crate) transcript: String,
    pub(crate) auto_paste: bool,
    pub(crate) record: Option<storage::TranscriptionRecord>,
}

#[derive(Serialize, Clone)]
pub(crate) struct TranscriptionErrorPayload {
    pub(crate) message: String,
    pub(crate) stage: String,
}
