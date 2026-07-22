//! Microsoft Store (MSIX) integration.
//!
//! Store installs run inside an MSIX package: updates come from the Store
//! (the built-in updater stays off) and launch-at-login goes through the
//! StartupTask declared in the AppxManifest instead of the Run registry key.

use std::sync::OnceLock;
use windows::ApplicationModel::{StartupTask, StartupTaskState};
use windows::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
use windows::core::HSTRING;

/// Must match the StartupTask TaskId in src-tauri/msix/AppxManifest.xml.
const STARTUP_TASK_ID: &str = "GlimpseStartup";

/// True when running from an MSIX package (Microsoft Store install).
pub fn is_msix_packaged() -> bool {
    static PACKAGED: OnceLock<bool> = OnceLock::new();
    *PACKAGED.get_or_init(|| {
        let mut length = 0u32;
        let err = unsafe { GetCurrentPackageFullName(&mut length, None) };
        err == ERROR_INSUFFICIENT_BUFFER
    })
}

/// join() must not block the STA main thread; workers use the implicit MTA.
fn on_worker<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    std::thread::spawn(task)
        .join()
        .map_err(|_| "Startup task worker panicked".to_string())?
}

fn startup_task() -> Result<StartupTask, String> {
    StartupTask::GetAsync(&HSTRING::from(STARTUP_TASK_ID))
        .and_then(|op| op.join())
        .map_err(|err| format!("Failed to open startup task: {err}"))
}

pub fn startup_task_enabled() -> Result<bool, String> {
    on_worker(|| {
        let state = startup_task()?
            .State()
            .map_err(|err| format!("Failed to read startup task state: {err}"))?;
        Ok(matches!(
            state,
            StartupTaskState::Enabled | StartupTaskState::EnabledByPolicy
        ))
    })
}

pub fn set_startup_task_enabled(enabled: bool) -> Result<(), String> {
    on_worker(move || set_startup_task_enabled_blocking(enabled))
}

fn set_startup_task_enabled_blocking(enabled: bool) -> Result<(), String> {
    let task = startup_task()?;
    if enabled {
        let state = task
            .RequestEnableAsync()
            .and_then(|op| op.join())
            .map_err(|err| format!("Failed to enable launch at login: {err}"))?;
        if !matches!(
            state,
            StartupTaskState::Enabled | StartupTaskState::EnabledByPolicy
        ) {
            return Err(
                "Launch at login is turned off for Glimpse in Windows Settings > Apps > Startup."
                    .to_string(),
            );
        }
    } else {
        task.Disable()
            .map_err(|err| format!("Failed to disable launch at login: {err}"))?;
    }
    Ok(())
}

/// True when this process was launched by the StartupTask (login).
/// StartupTask launches carry no command-line args, so detection goes
/// through the WinRT activation kind instead of `--autostart`.
pub fn launched_via_startup_task() -> bool {
    use windows::ApplicationModel::Activation::ActivationKind;
    use windows::ApplicationModel::AppInstance;

    AppInstance::GetActivatedEventArgs()
        .and_then(|args| args.Kind())
        .map(|kind| kind == ActivationKind::StartupTask)
        .unwrap_or(false)
}
