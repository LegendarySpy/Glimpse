use crate::AppRuntime;
use crate::toast;
use anyhow::{Context, Result, anyhow};
use tauri::Manager;
use tauri::{AppHandle, WebviewWindow};
use tauri_nspanel::{
    CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt, tauri_panel,
};

tauri_panel! {
    panel!(ToastPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            becomes_key_only_if_needed: true,
            is_floating_panel: true,
            hides_on_deactivate: false
        }
    })
}

pub fn init(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) -> Result<()> {
    toast_window
        .to_panel::<ToastPanel>()
        .map_err(|err| anyhow!(format!("{err:?}")))
        .with_context(|| format!("convert '{}' window to macOS NSPanel", toast::WINDOW_LABEL))?;

    if let Ok(panel) = app.get_webview_panel(toast::WINDOW_LABEL) {
        let style = StyleMask::empty().borderless().nonactivating_panel();
        panel.set_style_mask(style.into());
        panel.set_level(PanelLevel::Floating.into());

        let behavior = CollectionBehavior::new()
            .can_join_all_spaces()
            .stationary()
            .ignores_cycle()
            .full_screen_auxiliary();
        panel.set_collection_behavior(behavior.into());

        panel.set_becomes_key_only_if_needed(true);
        panel.set_floating_panel(true);
        panel.set_hides_on_deactivate(false);
        panel.hide();
    }

    Ok(())
}

pub fn show(app: &AppHandle<AppRuntime>, _toast_window: &WebviewWindow<AppRuntime>) -> Result<()> {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(panel) = app_clone.get_webview_panel(toast::WINDOW_LABEL) {
            panel.as_panel().orderFront(None);
        }
    });
    Ok(())
}

pub fn hide(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) -> Result<()> {
    let _ = toast_window.set_position(tauri::PhysicalPosition::new(-9999, -9999)); //if toast window doesnt wanna move, send it into the sun.
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(panel) = app_clone.get_webview_panel(toast::WINDOW_LABEL) {
            panel.hide();
        }
    });
    Ok(())
}
