use anyhow::{anyhow, Result};

#[cfg(target_os = "macos")]
pub fn paste_text(text: &str) -> Result<()> {
    use arboard::Clipboard;
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let mut clipboard = Clipboard::new().map_err(|err| anyhow!("Clipboard unavailable: {err}"))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|err| anyhow!("Unable to set clipboard text: {err}"))?;

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|err| anyhow!("Unable to create event source: {:?}", err))?;

    // macOS virtual key code for the "V" key.
    const V_KEY_CODE: CGKeyCode = 9;

    let key_down = CGEvent::new_keyboard_event(source.clone(), V_KEY_CODE, true)
        .map_err(|err| anyhow!("Unable to craft keyDown event: {:?}", err))?;
    key_down.set_flags(CGEventFlags::CGEventFlagCommand);
    key_down.post(CGEventTapLocation::HID);

    let key_up = CGEvent::new_keyboard_event(source, V_KEY_CODE, false)
        .map_err(|err| anyhow!("Unable to craft keyUp event: {:?}", err))?;
    key_up.set_flags(CGEventFlags::CGEventFlagCommand);
    key_up.post(CGEventTapLocation::HID);

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn paste_text(_text: &str) -> Result<()> {
    Err(anyhow!("Accessibility paste is only supported on macOS"))
}
