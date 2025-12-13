use crate::AppRuntime;
use anyhow::{anyhow, Context, Result};
use tauri::Manager;
use tauri::{AppHandle, WebviewWindow};
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt,
};

tauri_panel! {
    panel!(OverlayHUD {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            becomes_key_only_if_needed: true,
            is_floating_panel: true,
            hides_on_deactivate: false
        }
    })
}

pub fn init(app: &AppHandle<AppRuntime>, overlay_window: &WebviewWindow<AppRuntime>) -> Result<()> {
    overlay_window
        .to_panel::<OverlayHUD>()
        .map_err(|err| anyhow!(format!("{err:?}")))
        .context("convert main overlay window to macOS NSPanel")?;

    let panel = app
        .get_webview_panel(crate::MAIN_WINDOW_LABEL)
        .map_err(|err| anyhow!(format!("{err:?}")))
        .context("get macOS overlay panel")?;

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

    Ok(())
}

pub fn show(
    _app: &AppHandle<AppRuntime>,
    overlay_window: &WebviewWindow<AppRuntime>,
) -> Result<()> {
    // IMPORTANT: Do not call NSPanel methods here.
    // Shortcuts/recording events may run on background threads; AppKit APIs must be main-thread.
    let _ = overlay_window.show();
    Ok(())
}

pub fn hide(
    _app: &AppHandle<AppRuntime>,
    overlay_window: &WebviewWindow<AppRuntime>,
) -> Result<()> {
    let _ = overlay_window.hide();
    Ok(())
}
