use crate::native_i18n::MenuStrings;
use crate::recent_transcriptions::{
    MENU_ID_RECENT_TRANSCRIPTION_PREFIX, build_recent_transcriptions_menu,
    copy_transcription_to_clipboard,
};
use crate::settings::UserSettings;
use crate::speech::menu::{
    build_model_status_items, build_models_submenu, handle_speech_menu_event,
};
use crate::{AppRuntime, AppState, FEEDBACK_URL, SETTINGS_WINDOW_LABEL, audio};
use parking_lot::Mutex;
use std::sync::{OnceLock, atomic::Ordering};
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, Submenu, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri_plugin_opener::OpenerExt;

pub(crate) const MENU_ID_MIC_PREFIX: &str = "menu_mic_";
pub(crate) const MENU_ID_MIC_DEFAULT: &str = "menu_mic_default";
const MENU_ID_FEEDBACK: &str = "menu_send_feedback";
const MENU_ID_CHECK_UPDATES: &str = "menu_check_updates";
pub(crate) const EVENT_SETTINGS_RENDERER_READY: &str = "settings:renderer_ready";

#[derive(Clone, Copy)]
pub(crate) enum SettingsPage {
    About,
    History,
    Models,
    Account,
    Dictionary,
    Personalization,
    Library,
}

impl SettingsPage {
    fn event(self) -> &'static str {
        match self {
            Self::About => "navigate:about",
            Self::History => "navigate:history",
            Self::Models => "navigate:models",
            Self::Account => "navigate:account",
            Self::Dictionary => "navigate:dictionary",
            Self::Personalization => "navigate:personalization",
            Self::Library => "navigate:library",
        }
    }
}

#[derive(Default)]
struct PendingSettingsNavigation {
    renderer_ready: bool,
    target: Option<SettingsPage>,
}

fn pending_settings_navigation() -> &'static Mutex<PendingSettingsNavigation> {
    static PENDING: OnceLock<Mutex<PendingSettingsNavigation>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(PendingSettingsNavigation::default()))
}

fn flush_pending_settings_navigation(app: &AppHandle<AppRuntime>) {
    let target = {
        let mut pending = pending_settings_navigation().lock();
        if !pending.renderer_ready {
            return;
        }
        pending.target.take()
    };

    if let Some(page) = target {
        let _ = app.emit(page.event(), ());
    }
}

pub(crate) fn mark_settings_renderer_ready(app: &AppHandle<AppRuntime>) {
    pending_settings_navigation().lock().renderer_ready = true;
    flush_pending_settings_navigation(app);
}

pub(crate) fn open_settings_page(
    app: &AppHandle<AppRuntime>,
    page: SettingsPage,
) -> tauri::Result<()> {
    pending_settings_navigation().lock().target = Some(page);
    if let Err(err) = toggle_settings_window(app) {
        pending_settings_navigation().lock().target = None;
        return Err(err);
    }
    flush_pending_settings_navigation(app);
    Ok(())
}

pub(crate) fn build_microphone_submenu(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
    strings: &MenuStrings,
) -> tauri::Result<Submenu<AppRuntime>> {
    let mut mic_submenu = SubmenuBuilder::new(app, strings.get("native.menu.microphone"));
    let default_mic = CheckMenuItemBuilder::with_id(
        MENU_ID_MIC_DEFAULT,
        strings.get("native.menu.mic_system_default"),
    )
    .checked(settings.microphone_device.is_none())
    .build(app)?;
    mic_submenu = mic_submenu.item(&default_mic);

    match audio::list_input_devices() {
        Ok(devices) => {
            if devices.is_empty() {
                let unavailable = MenuItem::with_id(
                    app,
                    "menu_mic_none",
                    strings.get("native.menu.mic_none"),
                    false,
                    None::<&str>,
                )?;
                mic_submenu = mic_submenu.item(&unavailable);
            } else {
                for device in devices {
                    let label = if device.is_default {
                        strings.format("native.menu.mic_default_suffix", &[("name", &device.name)])
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
                strings.format(
                    "native.menu.mic_unavailable",
                    &[("error", &err.to_string())],
                ),
                false,
                None::<&str>,
            )?;
            mic_submenu = mic_submenu.item(&unavailable);
        }
    }
    mic_submenu.build()
}

fn build_tray_menu(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
) -> tauri::Result<Menu<AppRuntime>> {
    let strings = MenuStrings::resolve(settings);
    let app_name = app.package_info().name.clone();
    let mut menu = MenuBuilder::new(app);

    let check_updates = MenuItem::with_id(
        app,
        MENU_ID_CHECK_UPDATES,
        strings.get("native.menu.check_updates"),
        true,
        None::<&str>,
    )?;
    menu = menu.item(&check_updates);
    menu = menu.separator();
    let status_items = build_model_status_items(app, settings)?;
    for item in &status_items {
        menu = menu.item(item);
    }
    if !status_items.is_empty() {
        menu = menu.separator();
    }

    menu = menu.item(&build_models_submenu(app, settings)?);

    menu = menu.item(&build_microphone_submenu(app, settings, &strings)?);

    menu = menu.separator();
    let recent_submenu = build_recent_transcriptions_menu(app, &strings)?;
    menu = menu.item(&recent_submenu);
    menu = menu.separator();

    let send_feedback = MenuItem::with_id(
        app,
        MENU_ID_FEEDBACK,
        strings.get("native.menu.send_feedback"),
        true,
        None::<&str>,
    )?;
    menu = menu.item(&send_feedback);
    menu = menu.separator();

    let open_settings = MenuItem::with_id(
        app,
        "open_settings",
        strings.format("native.tray.open", &[("app", &app_name)]),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit_glimpse",
        strings.format("native.tray.quit", &[("app", &app_name)]),
        true,
        None::<&str>,
    )?;
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

fn refresh_speech_menus(app: &AppHandle<AppRuntime>, settings: &UserSettings) {
    if let Err(err) = refresh_tray_menu(app, settings) {
        tracing::error!("Failed to refresh tray menu: {err}");
    }
    #[cfg(target_os = "macos")]
    if let Err(err) = crate::set_app_menu(app, settings) {
        tracing::error!("Failed to refresh app menu: {err}");
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
            refresh_speech_menus(app, &saved);
            if let Err(err) = app.emit(crate::EVENT_SETTINGS_CHANGED, &saved) {
                tracing::error!("Failed to emit settings change: {err}");
            }
        }
        Err(err) => tracing::error!("Failed to update microphone selection: {err}"),
    }
}

fn handle_tray_menu_event(app: &AppHandle<AppRuntime>, id: &str) {
    if let Some(saved) = handle_speech_menu_event(app, id) {
        refresh_speech_menus(app, &saved);
        return;
    }

    match id {
        MENU_ID_MIC_DEFAULT => set_microphone_from_menu(app, None),
        MENU_ID_FEEDBACK => {
            if let Err(err) = app.opener().open_url(FEEDBACK_URL, None::<&str>) {
                tracing::error!("Failed to open feedback link: {err}");
            }
        }
        MENU_ID_CHECK_UPDATES => {
            if crate::platform::is_store_build() {
                // Store installs update through the Store's Downloads and Updates page.
                if let Err(err) = app
                    .opener()
                    .open_url("ms-windows-store://downloadsandupdates", None::<&str>)
                {
                    tracing::error!("Failed to open Microsoft Store updates: {err}");
                }
            } else if let Err(err) = open_settings_page(app, SettingsPage::About) {
                tracing::error!("Failed to open settings for update check: {err}");
            }
        }
        _ => {
            if let Some(transcription_id) = id.strip_prefix(MENU_ID_RECENT_TRANSCRIPTION_PREFIX) {
                copy_transcription_to_clipboard(app, transcription_id);
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

    let builder = TrayIconBuilder::new();

    #[cfg(target_os = "macos")]
    let builder = {
        let icon_bytes = include_bytes!("../icons/tray.png");
        let icon = tauri::image::Image::from_bytes(icon_bytes)?.to_owned();
        builder.icon(icon).icon_as_template(true)
    };

    #[cfg(target_os = "windows")]
    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => builder,
    };

    builder
        .menu(&menu)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button,
                button_state,
                ..
            } if button == MouseButton::Left && button_state == MouseButtonState::Up => {
                if let Err(err) = toggle_settings_window(tray.app_handle()) {
                    tracing::error!("Failed to toggle settings window: {err}");
                }
            }
            _ => {}
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_settings" => {
                if let Err(err) = toggle_settings_window(app) {
                    tracing::error!("Failed to open settings window: {err}");
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

    let window = match app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        Some(existing) => existing,
        _ => {
            reset_close_flag = true;
            let builder =
                WebviewWindowBuilder::new(app, SETTINGS_WINDOW_LABEL, WebviewUrl::default())
                    .title("Glimpse")
                    .inner_size(900.0, 750.0)
                    .min_inner_size(900.0, 750.0)
                    .resizable(true)
                    .visible(false);

            #[cfg(target_os = "macos")]
            let builder = builder
                .hidden_title(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay);

            #[cfg(target_os = "windows")]
            let builder = builder.decorations(false);

            builder.build()?
        }
    };

    if reset_close_flag {
        state
            .settings_close_handler_registered
            .store(false, Ordering::SeqCst);
    }

    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Regular);

    if window.is_minimized().unwrap_or(false) {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()?;

    // Show a toast if the app just restarted via auto-update
    if state.take_auto_update_completed() {
        let current_version = env!("CARGO_PKG_VERSION");
        crate::toast::emit_toast(
            app,
            crate::toast::Payload {
                toast_type: "success".to_string(),
                message: format!("Glimpse updated to v{current_version}."),
                auto_dismiss: Some(true),
                duration: Some(5000),
                ..Default::default()
            },
        );
    }

    let already_registered = state
        .settings_close_handler_registered
        .swap(true, Ordering::SeqCst);
    if !already_registered {
        #[cfg(target_os = "macos")]
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
