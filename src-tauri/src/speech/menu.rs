use tauri::menu::{CheckMenuItemBuilder, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Manager};

use crate::native_i18n::MenuStrings;
use crate::settings::UserSettings;
use crate::speech::{self, catalog, install, remote};
use crate::{AppRuntime, AppState};

pub const MENU_ID_MODEL_PREFIX: &str = "menu_model_";
pub const MENU_ID_MODEL_STATUS_PREFIX: &str = "menu_model_status_";

/// Select a local speech model by key from the CLI. Validates the key and that
/// the model is installed, then persists and refreshes the menu/tray.
pub(crate) fn cli_set_local_model(
    app: &AppHandle<AppRuntime>,
    model_key: &str,
) -> Result<(), String> {
    if catalog::definition(model_key).is_none() {
        return Err(format!("Unknown model: {model_key}"));
    }
    match install::check_model_status(app.clone(), model_key.to_string()) {
        Ok(status) if status.installed => {}
        Ok(_) => return Err(format!("Model not installed: {model_key}")),
        Err(err) => return Err(format!("Failed to check model status: {err}")),
    }

    let state = app.state::<AppState>();
    let mut settings = state.current_settings_unmasked();
    settings.local_model = model_key.to_string();
    settings.remote_speech_enabled = false;
    persist_menu_settings(app, settings).ok_or_else(|| "Failed to persist settings".to_string())?;
    Ok(())
}

/// Enable remote speech from the CLI. Requires a valid remote configuration.
pub(crate) fn cli_enable_remote(app: &AppHandle<AppRuntime>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut settings = state.current_settings_unmasked();
    if !remote::has_valid_config(&settings) {
        return Err("Remote speech is not configured. Set it up in Settings → Models.".to_string());
    }
    settings.remote_speech_enabled = true;
    persist_menu_settings(app, settings).ok_or_else(|| "Failed to persist settings".to_string())?;
    Ok(())
}

pub fn model_status_lines(settings: &UserSettings) -> Vec<String> {
    if remote::is_configured(settings) {
        let active = catalog::label(&speech::selected_model(settings));
        let fallback = install::model_label(&settings.local_model);
        let label = MenuStrings::resolve(settings)
            .format("native.menu.model_fallback", &[("model", &fallback)]);
        vec![active, label]
    } else {
        vec![install::model_label(&settings.local_model)]
    }
}

pub fn build_model_status_items(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
) -> tauri::Result<Vec<MenuItem<AppRuntime>>> {
    let mut items = Vec::new();
    for (idx, line) in model_status_lines(settings).into_iter().enumerate() {
        items.push(MenuItem::with_id(
            app,
            format!("{MENU_ID_MODEL_STATUS_PREFIX}{idx}"),
            line,
            false,
            None::<&str>,
        )?);
    }
    Ok(items)
}

pub fn build_models_submenu(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
) -> tauri::Result<tauri::menu::Submenu<AppRuntime>> {
    let speech_models = catalog::list_models(app, settings);
    let remote_active = remote::is_configured(settings);
    let mut model_submenu = SubmenuBuilder::new(
        app,
        MenuStrings::resolve(settings).get("native.menu.models"),
    );

    let remote_model = speech_models
        .iter()
        .find(|model| model.remote)
        .cloned()
        .or_else(|| catalog::configured_remote_model(settings));
    let local_models: Vec<_> = speech_models
        .iter()
        .filter(|model| !model.remote && model.installed)
        .collect();

    if let Some(model) = &remote_model {
        model_submenu = model_submenu.item(&build_model_item(app, settings, model, remote_active)?);
    }

    if remote_model.is_some() && !local_models.is_empty() {
        model_submenu = model_submenu.separator();
    }

    for model in local_models {
        model_submenu =
            model_submenu.item(&build_model_item(app, settings, model, !remote_active)?);
    }

    model_submenu.build()
}

fn build_model_item(
    app: &AppHandle<AppRuntime>,
    settings: &UserSettings,
    model: &catalog::SpeechModel,
    can_be_active: bool,
) -> tauri::Result<tauri::menu::CheckMenuItem<AppRuntime>> {
    let checked = if model.remote {
        remote::is_configured(settings)
    } else {
        can_be_active && settings.local_model == model.key
    };

    CheckMenuItemBuilder::with_id(
        format!("{MENU_ID_MODEL_PREFIX}{}", model.key),
        model.label.clone(),
    )
    .checked(checked)
    .build(app)
}

pub fn handle_speech_menu_event(app: &AppHandle<AppRuntime>, id: &str) -> Option<UserSettings> {
    if id.starts_with(MENU_ID_MODEL_STATUS_PREFIX) {
        return None;
    }

    if let Some(model_key) = id.strip_prefix(MENU_ID_MODEL_PREFIX) {
        if remote::is_remote_model(model_key) {
            return toggle_remote_model_from_menu(app);
        }
        return set_local_model_from_menu(app, model_key);
    }

    None
}

fn set_local_model_from_menu(app: &AppHandle<AppRuntime>, model_key: &str) -> Option<UserSettings> {
    if install::definition(model_key).is_none() {
        tracing::error!("Ignoring unknown model selection: {model_key}");
        return None;
    }

    match install::check_model_status(app.clone(), model_key.to_string()) {
        Ok(status) if status.installed => {}
        Ok(_) => {
            tracing::error!("Model not installed: {model_key}");
            return None;
        }
        Err(err) => {
            tracing::error!("Failed to check model status for {model_key}: {err}");
            return None;
        }
    }

    let state = app.state::<AppState>();
    let mut settings = state.current_settings_unmasked();
    if settings.local_model == model_key && !settings.remote_speech_enabled {
        return None;
    }
    settings.local_model = model_key.to_string();
    settings.remote_speech_enabled = false;
    persist_menu_settings(app, settings)
}

fn toggle_remote_model_from_menu(app: &AppHandle<AppRuntime>) -> Option<UserSettings> {
    let state = app.state::<AppState>();
    let mut settings = state.current_settings_unmasked();

    let next_enabled = !settings.remote_speech_enabled;
    if next_enabled && !remote::has_valid_config(&settings) {
        remote::emit_not_configured_toast(app, &settings);
        return None;
    }

    settings.remote_speech_enabled = next_enabled;
    persist_menu_settings(app, settings)
}

fn persist_menu_settings(
    app: &AppHandle<AppRuntime>,
    settings: UserSettings,
) -> Option<UserSettings> {
    let state = app.state::<AppState>();
    let previous = state.current_settings_unmasked();
    match state.persist_settings(settings) {
        Ok(saved) => {
            crate::analytics::track_settings_changes(app, &previous, &saved);
            state.emit_settings_changed(app, &saved);
            Some(saved)
        }
        Err(err) => {
            tracing::error!("Failed to update speech menu settings: {err}");
            None
        }
    }
}
