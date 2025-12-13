use crate::toast;
use crate::AppRuntime;
use anyhow::{anyhow, Context, Result};
use tauri::Manager;
use tauri::{AppHandle, WebviewWindow};
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt,
};

tauri_panel! {
    panel!(ToastPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            becomes_key_only_if_needed: true,
            is_floating_panel: true
        }
    })
}

pub fn init(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) -> Result<()> {
    // Convert once during app setup (main thread). After conversion, regular
    // `toast_window.show()/hide()` will use the NSPanel-backed window.
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
    }
    let _ = toast_window.set_ignore_cursor_events(true);

    let _ = app;
    let _ = toast_window.hide();

    Ok(())
}

pub fn show(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) -> Result<()> {
    let _ = app;
    let _ = toast_window.set_ignore_cursor_events(false);
    let _ = toast_window.show();
    Ok(())
}

pub fn hide(app: &AppHandle<AppRuntime>, toast_window: &WebviewWindow<AppRuntime>) -> Result<()> {
    let _ = app;
    let _ = toast_window.hide();
    let _ = toast_window.set_ignore_cursor_events(true);

    Ok(())
}
