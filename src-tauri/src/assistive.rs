use anyhow::{anyhow, Result};

#[cfg(target_os = "macos")]
use arboard::{Clipboard, ImageData, SetExtApple};
#[cfg(target_os = "macos")]
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
#[cfg(target_os = "macos")]
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
#[cfg(target_os = "macos")]
use std::{thread, time::Duration};

#[cfg(target_os = "macos")]
pub fn get_selected_text_ax() -> Option<String> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::CFString;
    use std::ffi::c_void;
    use std::ptr;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> *mut c_void;
        fn AXUIElementCopyAttributeValue(
            element: *mut c_void,
            attribute: *const c_void,
            value: *mut *mut c_void,
        ) -> i32;
        fn CFRelease(cf: *const c_void);
    }

    unsafe {
        let system_wide = AXUIElementCreateSystemWide();
        if system_wide.is_null() {
            return None;
        }

        let focused_attr = CFString::new("AXFocusedUIElement");
        let mut focused_element: *mut c_void = ptr::null_mut();
        let result = AXUIElementCopyAttributeValue(
            system_wide,
            focused_attr.as_concrete_TypeRef() as *const c_void,
            &mut focused_element,
        );
        CFRelease(system_wide);

        if result != 0 || focused_element.is_null() {
            return None;
        }

        let selected_attr = CFString::new("AXSelectedText");
        let mut selected_value: *mut c_void = ptr::null_mut();
        let result = AXUIElementCopyAttributeValue(
            focused_element,
            selected_attr.as_concrete_TypeRef() as *const c_void,
            &mut selected_value,
        );
        CFRelease(focused_element);

        if result != 0 || selected_value.is_null() {
            return None;
        }

        let cf_type: CFType = CFType::wrap_under_create_rule(selected_value as *const _);
        let cf_string = cf_type.downcast::<CFString>()?;
        let text = cf_string.to_string();

        if text.trim().is_empty() {
            return None;
        }

        Some(text)
    }
}

#[cfg(target_os = "macos")]
pub fn paste_text(text: &str) -> Result<()> {
    let mut clipboard = Clipboard::new().map_err(|e| anyhow!("Failed to access clipboard: {e}"))?;

    let backup = ClipboardBackup::capture(&mut clipboard);

    clipboard
        .set()
        .exclude_from_history()
        .text(text.to_string())
        .map_err(|e| anyhow!("Failed to set clipboard: {e}"))?;

    thread::sleep(Duration::from_millis(10));

    let paste_result = send_paste_keystroke();

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1000));
        if let Ok(mut clipboard) = Clipboard::new() {
            backup.restore(&mut clipboard);
        }
    });

    paste_result
}

#[cfg(target_os = "macos")]
struct ClipboardBackup {
    text: Option<String>,
    html: Option<String>,
    image: Option<ImageData<'static>>,
}

#[cfg(target_os = "macos")]
impl ClipboardBackup {
    fn capture(clipboard: &mut Clipboard) -> Self {
        Self {
            text: clipboard.get_text().ok(),
            html: clipboard.get().html().ok(),
            image: clipboard.get_image().ok().map(|img| img.to_owned()),
        }
    }

    fn restore(self, clipboard: &mut Clipboard) {
        let ClipboardBackup { text, html, image } = self;

        if let Some(html) = html {
            let alt_text = text.clone();
            if clipboard
                .set()
                .exclude_from_history()
                .html(html, alt_text.clone())
                .is_ok()
            {
                return;
            }

            if let Some(text) = alt_text {
                let _ = clipboard.set().exclude_from_history().text(text);
                return;
            }
        }

        if let Some(image) = image {
            let _ = clipboard.set_image(image);
            return;
        }

        if let Some(text) = text {
            let _ = clipboard.set().exclude_from_history().text(text);
        } else {
            let _ = clipboard.clear();
        }
    }
}

#[cfg(target_os = "macos")]
fn send_paste_keystroke() -> Result<()> {
    const V_KEY: CGKeyCode = 9;

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| anyhow!("Failed to create CGEventSource"))?;

    let key_down = CGEvent::new_keyboard_event(source.clone(), V_KEY, true)
        .map_err(|_| anyhow!("Failed to create key-down event"))?;
    key_down.set_flags(CGEventFlags::CGEventFlagCommand);
    key_down.post(CGEventTapLocation::HID);

    thread::sleep(Duration::from_millis(5));

    let key_up = CGEvent::new_keyboard_event(source, V_KEY, false)
        .map_err(|_| anyhow!("Failed to create key-up event"))?;
    key_up.set_flags(CGEventFlags::CGEventFlagCommand);
    key_up.post(CGEventTapLocation::HID);

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn paste_text(_text: &str) -> Result<()> {
    Err(anyhow!("Assistive paste is only supported on macOS"))
}

#[cfg(not(target_os = "macos"))]
pub fn get_selected_text_ax() -> Option<String> {
    None
}
