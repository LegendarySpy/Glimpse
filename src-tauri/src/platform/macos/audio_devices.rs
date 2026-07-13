use std::os::raw::c_void;
use std::ptr::NonNull;

use crossbeam_channel::Sender;
use objc2_core_audio::{
    AudioObjectAddPropertyListener, AudioObjectID, AudioObjectPropertyAddress,
    AudioObjectPropertySelector, AudioObjectRemovePropertyListener, kAudioHardwareNoError,
    kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDevices,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::{AppRuntime, AppState, SETTINGS_WINDOW_LABEL, set_app_menu, tray};

pub const EVENT_INPUT_DEVICES_CHANGED: &str = "audio:input-devices-changed";

pub fn init(app: &AppHandle<AppRuntime>) -> Result<(), String> {
    let app = app.clone();
    std::thread::Builder::new()
        .name("audio-device-watcher".to_string())
        .spawn(move || {
            if let Err(err) = run_input_device_watcher(app) {
                tracing::error!("Failed to start input device watcher: {err}");
            }
        })
        .map(|_| ())
        .map_err(|err| format!("Failed to spawn input device watcher: {err}"))
}

fn run_input_device_watcher(app: AppHandle<AppRuntime>) -> Result<(), String> {
    let (sender, receiver) = crossbeam_channel::bounded(1);
    let _devices_listener =
        AudioPropertyListener::new(kAudioHardwarePropertyDevices, sender.clone())?;
    let _default_input_listener =
        AudioPropertyListener::new(kAudioHardwarePropertyDefaultInputDevice, sender)?;

    while receiver.recv().is_ok() {
        refresh_native_menus(&app);
        let _ = app.emit_to(SETTINGS_WINDOW_LABEL, EVENT_INPUT_DEVICES_CHANGED, ());
    }

    Ok(())
}

fn refresh_native_menus(app: &AppHandle<AppRuntime>) {
    let settings = app.state::<AppState>().current_settings();
    if let Err(err) = set_app_menu(app, &settings) {
        tracing::error!("Failed to refresh app menu after input device change: {err}");
    }
    if let Err(err) = tray::refresh_tray_menu(app, &settings) {
        tracing::error!("Failed to refresh tray menu after input device change: {err}");
    }
}

struct ListenerState {
    sender: Sender<()>,
}

struct AudioPropertyListener {
    address: AudioObjectPropertyAddress,
    state: Box<ListenerState>,
}

impl AudioPropertyListener {
    fn new(selector: AudioObjectPropertySelector, sender: Sender<()>) -> Result<Self, String> {
        let address = AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let state = Box::new(ListenerState { sender });
        let status = unsafe {
            AudioObjectAddPropertyListener(
                kAudioObjectSystemObject as AudioObjectID,
                NonNull::from(&address),
                Some(audio_property_listener),
                &*state as *const ListenerState as *mut c_void,
            )
        };

        if status != kAudioHardwareNoError {
            return Err(format!("CoreAudio listener failed with status {status}"));
        }

        Ok(Self { address, state })
    }
}

impl Drop for AudioPropertyListener {
    fn drop(&mut self) {
        let _ = unsafe {
            AudioObjectRemovePropertyListener(
                kAudioObjectSystemObject as AudioObjectID,
                NonNull::from(&self.address),
                Some(audio_property_listener),
                &*self.state as *const ListenerState as *mut c_void,
            )
        };
    }
}

unsafe extern "C-unwind" fn audio_property_listener(
    _: AudioObjectID,
    _: u32,
    _: NonNull<AudioObjectPropertyAddress>,
    client_data: *mut c_void,
) -> i32 {
    unsafe {
        let Some(state) = (client_data as *mut ListenerState).as_ref() else {
            return 0;
        };
        let _ = state.sender.try_send(());
        0
    }
}
