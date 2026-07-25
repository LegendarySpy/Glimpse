use crate::native_i18n::MenuStrings;
use crate::{AppRuntime, AppState, assistive, toast};
use tauri::menu::{MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Manager};

pub const MENU_ID_RECENT_TRANSCRIPTION_PREFIX: &str = "menu_recent_transcription_";
const MENU_ID_RECENT_TRANSCRIPTION_EMPTY: &str = "menu_recent_transcription_empty";
const MENU_ID_RECENT_TRANSCRIPTION_ERROR: &str = "menu_recent_transcription_error";
const RECENT_TRANSCRIPTIONS_LIMIT: usize = 5;
const RECENT_TRANSCRIPTIONS_PREVIEW_LEN: usize = 60;

pub fn build_recent_transcriptions_menu(
    app: &AppHandle<AppRuntime>,
    strings: &MenuStrings,
) -> tauri::Result<tauri::menu::Submenu<AppRuntime>> {
    let mut submenu = SubmenuBuilder::new(app, strings.get("native.menu.recent"));
    if let Some(state) = app.try_state::<AppState>() {
        match state
            .storage()
            .get_recent_transcriptions(RECENT_TRANSCRIPTIONS_LIMIT)
        {
            Ok(records) if !records.is_empty() => {
                for record in records {
                    let preview = format_transcription_preview(
                        &record.text,
                        RECENT_TRANSCRIPTIONS_PREVIEW_LEN,
                        strings.get("native.menu.recent_empty_item"),
                    );
                    let item = MenuItem::with_id(
                        app,
                        format!("{MENU_ID_RECENT_TRANSCRIPTION_PREFIX}{}", record.id),
                        preview,
                        true,
                        None::<&str>,
                    )?;
                    submenu = submenu.item(&item);
                }
            }
            Ok(_) => {
                let item = MenuItem::with_id(
                    app,
                    MENU_ID_RECENT_TRANSCRIPTION_EMPTY,
                    strings.get("native.menu.recent_empty"),
                    false,
                    None::<&str>,
                )?;
                submenu = submenu.item(&item);
            }
            Err(err) => {
                tracing::error!("Failed to load recent transcriptions for menu: {err}");
                let item = MenuItem::with_id(
                    app,
                    MENU_ID_RECENT_TRANSCRIPTION_ERROR,
                    strings.get("native.menu.recent_error"),
                    false,
                    None::<&str>,
                )?;
                submenu = submenu.item(&item);
            }
        }
    } else {
        let item = MenuItem::with_id(
            app,
            MENU_ID_RECENT_TRANSCRIPTION_EMPTY,
            strings.get("native.menu.recent_empty"),
            false,
            None::<&str>,
        )?;
        submenu = submenu.item(&item);
    }

    submenu.build()
}

pub fn copy_transcription_to_clipboard(app: &AppHandle<AppRuntime>, transcription_id: &str) {
    let record = app
        .state::<AppState>()
        .storage()
        .get_by_id(transcription_id);
    let Some(record) = record else {
        emit_copy_error_toast(app, "Transcription no longer available");
        refresh_recent_menus(app);
        return;
    };
    let text = record.text.trim();
    if text.is_empty() {
        emit_copy_error_toast(app, "Transcription is empty");
        refresh_recent_menus(app);
        return;
    }
    if let Err(err) = assistive::copy_text_to_clipboard(text) {
        tracing::error!("Failed to copy transcription to clipboard: {err}");
        emit_copy_error_toast(app, "Unable to copy to clipboard");
        return;
    }

    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "success".to_string(),
            title: None,
            message: "Copied to clipboard".to_string(),
            auto_dismiss: Some(true),
            duration: Some(1200),
            retry_id: None,
            mode: None,
            action: None,
            action_label: None,
            secondary_action: None,
            secondary_action_label: None,
        },
    );
}

fn emit_copy_error_toast(app: &AppHandle<AppRuntime>, message: &str) {
    toast::emit_toast(
        app,
        toast::Payload {
            toast_type: "error".to_string(),
            title: None,
            message: message.to_string(),
            auto_dismiss: Some(true),
            duration: Some(1600),
            retry_id: None,
            mode: None,
            action: None,
            action_label: None,
            secondary_action: None,
            secondary_action_label: None,
        },
    );
}

fn refresh_recent_menus(app: &AppHandle<AppRuntime>) {
    let settings = app.state::<AppState>().current_settings();
    if let Err(err) = crate::tray::refresh_tray_menu(app, &settings) {
        tracing::error!("Failed to refresh tray menu: {err}");
    }
    #[cfg(target_os = "macos")]
    if let Err(err) = crate::set_app_menu(app, &settings) {
        tracing::error!("Failed to refresh app menu: {err}");
    }
}

fn format_transcription_preview(text: &str, max_len: usize, empty_label: &str) -> String {
    let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return empty_label.to_string();
    }

    let mut chars = cleaned.chars();
    let preview: String = chars.by_ref().take(max_len).collect();
    if chars.next().is_some() {
        let trim_len = max_len.saturating_sub(3);
        let mut shortened: String = preview.chars().take(trim_len).collect();
        shortened.push_str("...");
        shortened
    } else {
        preview
    }
}
