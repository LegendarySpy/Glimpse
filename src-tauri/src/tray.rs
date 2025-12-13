use crate::settings::{TranscriptionMode, UserSettings};
use crate::{
    audio, model_manager, AppRuntime, AppState, EVENT_SETTINGS_CHANGED, FEEDBACK_URL,
    SETTINGS_WINDOW_LABEL,
};
use std::sync::atomic::Ordering;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri_plugin_opener::OpenerExt;

const MENU_ID_MODE_LOCAL: &str = "menu_mode_local";
const MENU_ID_MODE_CLOUD: &str = "menu_mode_cloud";
const MENU_ID_MODEL_PREFIX: &str = "menu_model_";
const MENU_ID_MIC_PREFIX: &str = "menu_mic_";
const MENU_ID_MIC_DEFAULT: &str = "menu_mic_default";
const MENU_ID_FEEDBACK: &str = "menu_send_feedback";
const MENU_ID_CHECK_UPDATES: &str = "menu_check_updates";

fn build_tray_menu(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
) -> tauri::Result<Menu<AppRuntime>> {
    let mut menu = MenuBuilder::new(app);

    let mode_cloud = CheckMenuItemBuilder::with_id(MENU_ID_MODE_CLOUD, "Cloud")
        .checked(matches!(
            settings.transcription_mode,
            TranscriptionMode::Cloud
        ))
        .build(app)?;
    let mode_local = CheckMenuItemBuilder::with_id(MENU_ID_MODE_LOCAL, "Local")
        .checked(matches!(
            settings.transcription_mode,
            TranscriptionMode::Local
        ))
        .build(app)?;
    let mode_submenu = SubmenuBuilder::new(app, "Mode")
        .item(&mode_cloud)
        .item(&mode_local)
        .build()?;
    menu = menu.item(&mode_submenu);

    let mut mic_submenu = SubmenuBuilder::new(app, "Microphone");
    let default_mic = CheckMenuItemBuilder::with_id(MENU_ID_MIC_DEFAULT, "System Default")
        .checked(settings.microphone_device.is_none())
        .build(app)?;
    mic_submenu = mic_submenu.item(&default_mic);

    match audio::list_input_devices() {
        Ok(devices) => {
            if devices.is_empty() {
                let unavailable = MenuItem::with_id(
                    app,
                    "menu_mic_none",
                    "No input devices found",
                    false,
                    None::<&str>,
                )?;
                mic_submenu = mic_submenu.item(&unavailable);
            } else {
                for device in devices {
                    let label = if device.is_default {
                        format!("{} (Default)", device.name)
                    } else {
                        device.name.clone()
                    };
                    let checked = settings.microphone_device.as_deref() == Some(device.id.as_str());
                    let item = CheckMenuItemBuilder::with_id(
                        format!("{MENU_ID_MIC_PREFIX}dev:{}", device.id),
                        label,
                    )
                    .checked(checked)
                    .build(app)?;
                    mic_submenu = mic_submenu.item(&item);
                }
            }
        }
        Err(err) => {
            let unavailable = MenuItem::with_id(
                app,
                "menu_mic_error",
                format!("Microphone unavailable ({err})"),
                false,
                None::<&str>,
            )?;
            mic_submenu = mic_submenu.item(&unavailable);
        }
    }
    menu = menu.item(&mic_submenu.build()?);

    if matches!(settings.transcription_mode, TranscriptionMode::Local) {
        let mut model_submenu = SubmenuBuilder::new(app, "Model");
        for model in model_manager::list_models() {
            let installed = model_manager::check_model_status(app.clone(), model.key.clone())
                .map(|s| s.installed)
                .unwrap_or(false);
            let label = if installed {
                model.label.clone()
            } else {
                format!("{} (Not downloaded)", model.label)
            };
            let item = CheckMenuItemBuilder::with_id(
                format!("{MENU_ID_MODEL_PREFIX}{}", model.key),
                label,
            )
            .enabled(installed)
            .checked(installed && settings.local_model == model.key)
            .build(app)?;
            model_submenu = model_submenu.item(&item);
        }
        menu = menu.item(&model_submenu.build()?);
    }

    menu = menu.separator();
    let check_updates = MenuItem::with_id(
        app,
        MENU_ID_CHECK_UPDATES,
        "Check for Updates",
        true,
        None::<&str>,
    )?;
    let send_feedback =
        MenuItem::with_id(app, MENU_ID_FEEDBACK, "Send Feedback", true, None::<&str>)?;
    menu = menu.item(&check_updates).item(&send_feedback);
    menu = menu.separator();

    let open_settings =
        MenuItem::with_id(app, "open_settings", "Open Glimpse", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit_glimpse", "Quit Glimpse", true, None::<&str>)?;
    menu = menu.item(&open_settings).item(&quit);

    menu.build()
}

pub(crate) fn refresh_tray_menu(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    if let Some(tray) = state.tray.lock().clone() {
        let menu = build_tray_menu(app, settings)?;
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

fn set_transcription_mode_from_menu(app: &AppHandle<AppRuntime>, mode: TranscriptionMode) {
    let state = app.state::<AppState>();
    let mut settings = state.current_settings();
    if settings.transcription_mode == mode {
        return;
    }
    settings.transcription_mode = mode;
    match state.persist_settings(settings.clone()) {
        Ok(saved) => {
            if let Err(err) = refresh_tray_menu(app, &saved) {
                eprintln!("Failed to refresh tray menu: {err}");
            }
            if let Err(err) = app.emit(EVENT_SETTINGS_CHANGED, &saved) {
                eprintln!("Failed to emit settings change: {err}");
            }
        }
        Err(err) => eprintln!("Failed to update transcription mode: {err}"),
    }
}

fn set_local_model_from_menu(app: &AppHandle<AppRuntime>, model_key: &str) {
    if model_manager::definition(model_key).is_none() {
        eprintln!("Ignoring unknown model selection: {model_key}");
        return;
    }

    match model_manager::check_model_status(app.clone(), model_key.to_string()) {
        Ok(status) if status.installed => {}
        Ok(_) => {
            eprintln!("Model not installed: {model_key}");
            return;
        }
        Err(err) => {
            eprintln!("Failed to check model status for {model_key}: {err}");
            return;
        }
    }

    let state = app.state::<AppState>();
    let mut settings = state.current_settings();
    if settings.local_model == model_key {
        return;
    }
    settings.local_model = model_key.to_string();
    match state.persist_settings(settings.clone()) {
        Ok(saved) => {
            if let Err(err) = refresh_tray_menu(app, &saved) {
                eprintln!("Failed to refresh tray menu: {err}");
            }
            if let Err(err) = app.emit(EVENT_SETTINGS_CHANGED, &saved) {
                eprintln!("Failed to emit settings change: {err}");
            }
        }
        Err(err) => eprintln!("Failed to update model selection: {err}"),
    }
}

fn set_microphone_from_menu(app: &AppHandle<AppRuntime>, device_id: Option<&str>) {
    let state = app.state::<AppState>();
    let mut settings = state.current_settings();
    if settings.microphone_device.as_deref() == device_id {
        return;
    }
    settings.microphone_device = device_id.map(|id| id.to_string());
    match state.persist_settings(settings.clone()) {
        Ok(saved) => {
            if let Err(err) = refresh_tray_menu(app, &saved) {
                eprintln!("Failed to refresh tray menu: {err}");
            }
            if let Err(err) = app.emit(EVENT_SETTINGS_CHANGED, &saved) {
                eprintln!("Failed to emit settings change: {err}");
            }
        }
        Err(err) => eprintln!("Failed to update microphone selection: {err}"),
    }
}

fn handle_tray_menu_event(app: &AppHandle<AppRuntime>, id: &str) {
    match id {
        MENU_ID_MODE_LOCAL => set_transcription_mode_from_menu(app, TranscriptionMode::Local),
        MENU_ID_MODE_CLOUD => set_transcription_mode_from_menu(app, TranscriptionMode::Cloud),
        MENU_ID_MIC_DEFAULT => set_microphone_from_menu(app, None),
        MENU_ID_FEEDBACK => {
            if let Err(err) = app.opener().open_url(FEEDBACK_URL, None::<&str>) {
                eprintln!("Failed to open feedback link: {err}");
            }
        }
        MENU_ID_CHECK_UPDATES => {
            if let Err(err) = toggle_settings_window(app) {
                eprintln!("Failed to open settings for update check: {err}");
            }
            let _ = app.emit("navigate:about", ());
        }
        _ => {
            if let Some(model_key) = id.strip_prefix(MENU_ID_MODEL_PREFIX) {
                set_local_model_from_menu(app, model_key);
            } else if let Some(device_id_raw) = id.strip_prefix(MENU_ID_MIC_PREFIX) {
                let device_id = device_id_raw.strip_prefix("dev:").unwrap_or(device_id_raw);
                set_microphone_from_menu(app, Some(device_id));
            }
        }
    }
}

pub fn build_tray(app: &AppHandle<AppRuntime>) -> tauri::Result<TrayIcon<AppRuntime>> {
    let settings = app.state::<AppState>().current_settings();
    let menu = build_tray_menu(app, &settings)?;

    let icon_bytes = include_bytes!("../icons/tray.png");
    let icon = tauri::image::Image::from_bytes(icon_bytes)?.to_owned();

    TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button,
                button_state,
                ..
            } if button == MouseButton::Left && button_state == MouseButtonState::Up => {
                if let Err(err) = toggle_settings_window(tray.app_handle()) {
                    eprintln!("Failed to toggle settings window: {err}");
                }
            }
            _ => {}
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_settings" => {
                if let Err(err) = toggle_settings_window(app) {
                    eprintln!("Failed to open settings window: {err}");
                }
            }
            "quit_glimpse" => {
                app.exit(0);
            }
            other => handle_tray_menu_event(app, other),
        })
        .build(app)
}

pub fn toggle_settings_window(app: &AppHandle<AppRuntime>) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let mut reset_close_flag = false;

    let window = if let Some(existing) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        existing
    } else {
        reset_close_flag = true;
        WebviewWindowBuilder::new(app, SETTINGS_WINDOW_LABEL, WebviewUrl::default())
            .title("Glimpse Settings")
            .inner_size(900.0, 650.0)
            .min_inner_size(625.0, 400.0)
            .resizable(true)
            .visible(false)
            .hidden_title(true)
            .build()?
    };

    if reset_close_flag {
        state
            .settings_close_handler_registered
            .store(false, Ordering::SeqCst);
    }

    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Regular);

    window.show()?;
    window.set_focus()?;

    let already_registered = state
        .settings_close_handler_registered
        .swap(true, Ordering::SeqCst);
    if !already_registered {
        let app_handle = app.clone();
        let window_clone = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window_clone.hide();
                #[cfg(target_os = "macos")]
                let _ = app_handle.set_activation_policy(ActivationPolicy::Accessory);
            }
        });
    }

    Ok(())
}
