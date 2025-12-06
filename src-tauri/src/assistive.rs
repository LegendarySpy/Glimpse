use anyhow::{anyhow, Result};

#[cfg(target_os = "macos")]
use accessibility::AXUIElement;
#[cfg(target_os = "macos")]
use accessibility_sys::{
    kAXErrorSuccess, kAXFocusedUIElementAttribute, kAXValueAttribute, AXUIElementCopyAttributeValue,
    AXUIElementCreateSystemWide, AXUIElementIsAttributeSettable, AXUIElementSetAttributeValue,
    AXUIElementRef,
};
#[cfg(target_os = "macos")]
use arboard::Clipboard;
#[cfg(target_os = "macos")]
use std::{ffi::c_void, thread, time::Duration};
#[cfg(target_os = "macos")]
use core_foundation::{
    base::{CFType, TCFType},
    string::CFString,
};
#[cfg(target_os = "macos")]
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
#[cfg(target_os = "macos")]
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

#[cfg(target_os = "macos")]
pub fn paste_text(text: &str) -> Result<()> {
    let api_attempt = try_accessibility_paste(text);

    if matches!(api_attempt, Ok(true)) {
        return Ok(());
    }

    let fallback = dirty_paste(text);

    match (api_attempt, fallback) {
        (_, Ok(())) => Ok(()),
        (Err(api_err), Err(dirty_err)) => Err(anyhow!(
            "Accessibility paste failed ({api_err}); fallback paste failed ({dirty_err})"
        )),
        (_, Err(dirty_err)) => Err(dirty_err),
    }
}

#[cfg(target_os = "macos")]
fn try_accessibility_paste(text: &str) -> Result<bool> {
    unsafe {
        // Wrap to ensure release on all paths
        let system = AXUIElement::wrap_under_create_rule(AXUIElementCreateSystemWide());
        let attr_focused = CFString::from_static_string(kAXFocusedUIElementAttribute);
        let attr_value = CFString::from_static_string(kAXValueAttribute);

        let mut raw_focused: *const c_void = std::ptr::null();
        let focus_err = AXUIElementCopyAttributeValue(
            system.as_concrete_TypeRef(),
            attr_focused.as_concrete_TypeRef(),
            &mut raw_focused,
        );

        if focus_err != kAXErrorSuccess || raw_focused.is_null() {
            return Ok(false);
        }

        let focused = AXUIElement::wrap_under_create_rule(raw_focused as AXUIElementRef);

        let mut settable = false;
        let settable_err = AXUIElementIsAttributeSettable(
            focused.as_concrete_TypeRef(),
            attr_value.as_concrete_TypeRef(),
            &mut settable,
        );

        if settable_err != kAXErrorSuccess || !settable {
            return Ok(false);
        }

        let cf_text = CFString::from(text);
        let set_err = AXUIElementSetAttributeValue(
            focused.as_concrete_TypeRef(),
            attr_value.as_concrete_TypeRef(),
            cf_text.as_concrete_TypeRef() as _,
        );

        if set_err != kAXErrorSuccess {
            return Ok(false);
        }

        let mut after: *const c_void = std::ptr::null();
        let read_err = AXUIElementCopyAttributeValue(
            focused.as_concrete_TypeRef(),
            attr_value.as_concrete_TypeRef(),
            &mut after,
        );

        if read_err != kAXErrorSuccess || after.is_null() {
            return Ok(false);
        }

        let cf_type = CFType::wrap_under_create_rule(after);
        if let Some(as_string) = cf_type.downcast::<CFString>() {
            if as_string.to_string() == text {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

#[cfg(target_os = "macos")]
fn dirty_paste(text: &str) -> Result<()> {
    let mut clipboard = Clipboard::new().map_err(|err| anyhow!("Clipboard unavailable: {err}"))?;
    struct ClipboardBackup {
        text: Option<String>,
        html: Option<String>,
    }

    let backup = ClipboardBackup {
        text: clipboard.get_text().ok(),
        html: clipboard.get().html().ok(),
    };

    clipboard
        .set_text(text.to_string())
        .map_err(|err| anyhow!("Unable to set clipboard text: {err}"))?;

    let send_result = send_cmd_v();
    // Give the target app a brief window to read from the clipboard before its restored
    thread::sleep(Duration::from_millis(150));

    if let Some(html) = backup.html {
        let _ = clipboard.set_html(html, backup.text.as_deref().map(str::to_string));
    } else if let Some(text_prev) = backup.text {
        let _ = clipboard.set_text(text_prev);
    } else {
        let _ = clipboard.clear();
    }

    // Return the send_cmd_v result after attempting restoration so clipboard is always restored.
    send_result
}

#[cfg(target_os = "macos")]
fn send_cmd_v() -> Result<()> {
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
