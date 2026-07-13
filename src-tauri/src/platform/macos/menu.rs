use crate::AppRuntime;
use crate::audio;
use crate::recent_transcriptions::build_recent_transcriptions_menu;
use crate::settings::UserSettings;
use crate::speech::menu::{build_model_status_items, build_models_submenu};
use tauri::AppHandle;
use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem,
    SubmenuBuilder,
};

// Shared menu IDs - also used by lib.rs event handler
pub const MENU_ID_CHECK_UPDATES: &str = "menu_check_updates";
pub const MENU_ID_WEBSITE: &str = "menu_website";
pub const MENU_ID_REPORT_ISSUE: &str = "menu_report_issue";
pub const MENU_ID_MIC_DEFAULT: &str = "menu_mic_default";
pub const MENU_ID_MIC_PREFIX: &str = "menu_mic_";

pub fn build_app_menu(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
) -> tauri::Result<Menu<AppRuntime>> {
    let app_name = app.package_info().name.clone();

    let mut app_submenu = SubmenuBuilder::new(app, &app_name)
        .item(&MenuItemBuilder::with_id(MENU_ID_CHECK_UPDATES, "Check for Updates...").build(app)?)
        .separator();

    let status_items = build_model_status_items(app, settings)?;
    for item in &status_items {
        app_submenu = app_submenu.item(item);
    }
    if !status_items.is_empty() {
        app_submenu = app_submenu.separator();
    }

    // TODO: add back Mode submenu when cloud is added.
    // let mode_submenu = SubmenuBuilder::new(app, "Mode") ...

    app_submenu = app_submenu.item(&build_models_submenu(app, settings)?);

    // Microphone submenu
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
    app_submenu = app_submenu.item(&mic_submenu.build()?);

    let recent_submenu = build_recent_transcriptions_menu(app, "Last Transcriptions")?;

    app_submenu = app_submenu
        .separator()
        .item(&recent_submenu)
        .separator()
        .item(&PredefinedMenuItem::services(app, Some("Services"))?)
        .separator()
        .item(&PredefinedMenuItem::hide(
            app,
            Some(&format!("Hide {}", app_name)),
        )?)
        .item(&PredefinedMenuItem::hide_others(app, Some("Hide Others"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("Show All"))?)
        .separator()
        .item(&PredefinedMenuItem::quit(
            app,
            Some(&format!("Quit {}", app_name)),
        )?);
    let app_menu = app_submenu.build()?;

    // View menu
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&PredefinedMenuItem::close_window(
            app,
            Some("Close Window"),
        )?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(
            app,
            Some("Toggle Full Screen"),
        )?)
        .separator()
        .item(&PredefinedMenuItem::minimize(app, Some("Minimize"))?)
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .build()?;

    // Edit menu (enables standard copy/paste shortcuts)
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, Some("Undo"))?)
        .item(&PredefinedMenuItem::redo(app, Some("Redo"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("Cut"))?)
        .item(&PredefinedMenuItem::copy(app, Some("Copy"))?)
        .item(&PredefinedMenuItem::paste(app, Some("Paste"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("Select All"))?)
        .build()?;

    // Help menu
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id(MENU_ID_WEBSITE, "Github").build(app)?)
        .item(&MenuItemBuilder::with_id(MENU_ID_REPORT_ISSUE, "Send Feedback").build(app)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu, &help_menu])
        .build()
}
