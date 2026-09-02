use anyhow::{Result, anyhow};

#[cfg(not(target_os = "macos"))]
use arboard::Clipboard;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use arboard::Error as ClipboardError;
#[cfg(target_os = "macos")]
use arboard::{Clipboard, ImageData, SetExtApple};
#[cfg(target_os = "windows")]
use arboard::{ImageData, SetExtWindows};
#[cfg(target_os = "macos")]
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
#[cfg(target_os = "macos")]
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::{thread, time::Duration};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
    VIRTUAL_KEY, VK_C, VK_CONTROL, VK_V,
};

const MAX_FOCUSED_TEXT_SNAPSHOT_LEN: usize = 20_000;

#[derive(Clone, Debug, PartialEq)]
pub struct FocusedTextSnapshot {
    pub pid: i32,
    pub role: Option<String>,
    pub subrole: Option<String>,
    pub value: String,
    pub frame: Option<(f64, f64, f64, f64)>,
}

#[cfg(target_os = "macos")]
pub fn focused_text_snapshot() -> Option<FocusedTextSnapshot> {
    macos_ax::focused_text_snapshot()
}

#[cfg(target_os = "windows")]
pub fn focused_text_snapshot() -> Option<FocusedTextSnapshot> {
    windows_uia::focused_text_snapshot()
}

#[cfg(target_os = "macos")]
pub fn get_selected_text_ax() -> Option<String> {
    match macos_ax::probe_selection() {
        macos_ax::SelectionProbe::Text(text) if !text.trim().is_empty() => return Some(text),
        macos_ax::SelectionProbe::Empty => return None,
        macos_ax::SelectionProbe::Text(_) | macos_ax::SelectionProbe::Unknown => {}
    }
    copy_selection_via_clipboard(Duration::from_millis(50))
}

#[cfg(target_os = "macos")]
mod macos_ax {
    use core_foundation::base::{CFRelease, CFType, CFTypeRef, TCFType};
    use core_foundation::string::CFString;
    use std::ffi::c_void;
    use std::ptr;

    type AXUIElementRef = *mut c_void;
    type AXError = i32;
    const AX_ERROR_SUCCESS: AXError = 0;
    const AX_VALUE_TYPE_CG_POINT: u32 = 1;
    const AX_VALUE_TYPE_CG_SIZE: u32 = 2;
    const AX_VALUE_TYPE_CF_RANGE: u32 = 4;

    #[repr(C)]
    struct CFRange {
        location: isize,
        length: isize,
    }

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: *mut c_void,
            attribute: *const c_void,
            value: *mut *mut c_void,
        ) -> i32;
        fn AXUIElementGetPid(element: *mut c_void, pid: *mut i32) -> i32;
        fn AXValueGetValue(value: *const c_void, ax_type: u32, value_ptr: *mut c_void) -> bool;
        fn AXIsProcessTrusted() -> u8;
    }

    pub(super) enum SelectionProbe {
        Text(String),
        Empty,
        Unknown,
    }

    pub(super) fn probe_selection() -> SelectionProbe {
        let Some(focused) = copy_focused_element() else {
            return SelectionProbe::Unknown;
        };

        unsafe {
            let result = probe_focused(focused);
            CFRelease(focused as CFTypeRef);
            result
        }
    }

    pub(super) fn focused_text_snapshot() -> Option<super::FocusedTextSnapshot> {
        let focused = copy_focused_element()?;

        unsafe {
            let role = read_string_attribute(focused, "AXRole");
            let subrole = read_string_attribute(focused, "AXSubrole");
            if is_secure_text_field(role.as_deref(), subrole.as_deref()) {
                CFRelease(focused as CFTypeRef);
                return None;
            }

            let Some(value) = read_string_attribute(focused, "AXValue") else {
                CFRelease(focused as CFTypeRef);
                return None;
            };
            if value.len() > super::MAX_FOCUSED_TEXT_SNAPSHOT_LEN {
                CFRelease(focused as CFTypeRef);
                return None;
            }

            let frame = read_frame(focused);
            let Some(pid) = read_pid(focused) else {
                CFRelease(focused as CFTypeRef);
                return None;
            };
            CFRelease(focused as CFTypeRef);

            Some(super::FocusedTextSnapshot {
                pid,
                role,
                subrole,
                value,
                frame,
            })
        }
    }

    fn copy_focused_element() -> Option<AXUIElementRef> {
        if unsafe { AXIsProcessTrusted() } == 0 {
            return None;
        }

        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return None;
            }

            let focused_attr = CFString::new("AXFocusedUIElement");
            let mut focused: *mut c_void = ptr::null_mut();
            let err = AXUIElementCopyAttributeValue(
                system,
                focused_attr.as_concrete_TypeRef() as *const c_void,
                &mut focused,
            );
            CFRelease(system as CFTypeRef);

            if err != AX_ERROR_SUCCESS || focused.is_null() {
                return None;
            }

            Some(focused)
        }
    }

    fn is_secure_text_field(role: Option<&str>, subrole: Option<&str>) -> bool {
        matches!(role, Some("AXSecureTextField")) || matches!(subrole, Some("AXSecureTextField"))
    }

    unsafe fn probe_focused(focused: AXUIElementRef) -> SelectionProbe {
        unsafe {
            if let Some(text) = read_string_attribute(focused, "AXSelectedText")
                && !text.is_empty()
            {
                return SelectionProbe::Text(text);
            }

            if matches!(
                read_selected_text_range(focused),
                Some(CFRange { length: 0, .. })
            ) {
                return SelectionProbe::Empty;
            }

            SelectionProbe::Unknown
        }
    }

    unsafe fn read_string_attribute(element: AXUIElementRef, attribute: &str) -> Option<String> {
        unsafe {
            let value = copy_attribute(element, attribute)?;
            let cf_type: CFType = CFType::wrap_under_create_rule(value as *const _);
            let cf_string = cf_type.downcast::<CFString>()?;
            Some(cf_string.to_string())
        }
    }

    unsafe fn read_selected_text_range(element: AXUIElementRef) -> Option<CFRange> {
        unsafe {
            let value = copy_attribute(element, "AXSelectedTextRange")?;
            let mut range = CFRange {
                location: 0,
                length: 0,
            };
            let ok = AXValueGetValue(
                value,
                AX_VALUE_TYPE_CF_RANGE,
                &mut range as *mut CFRange as *mut c_void,
            );
            CFRelease(value as CFTypeRef);

            ok.then_some(range)
        }
    }

    unsafe fn read_pid(element: AXUIElementRef) -> Option<i32> {
        unsafe {
            let mut pid = 0;
            let err = AXUIElementGetPid(element, &mut pid);
            (err == AX_ERROR_SUCCESS).then_some(pid)
        }
    }

    unsafe fn read_frame(element: AXUIElementRef) -> Option<(f64, f64, f64, f64)> {
        unsafe {
            let position_value = copy_attribute(element, "AXPosition")?;
            let Some(size_value) = copy_attribute(element, "AXSize") else {
                CFRelease(position_value as CFTypeRef);
                return None;
            };

            let mut point = CGPoint { x: 0.0, y: 0.0 };
            let mut size = CGSize {
                width: 0.0,
                height: 0.0,
            };
            let point_ok = AXValueGetValue(
                position_value,
                AX_VALUE_TYPE_CG_POINT,
                &mut point as *mut CGPoint as *mut c_void,
            );
            let size_ok = AXValueGetValue(
                size_value,
                AX_VALUE_TYPE_CG_SIZE,
                &mut size as *mut CGSize as *mut c_void,
            );
            CFRelease(position_value as CFTypeRef);
            CFRelease(size_value as CFTypeRef);

            (point_ok && size_ok).then_some((point.x, point.y, size.width, size.height))
        }
    }

    unsafe fn copy_attribute(element: AXUIElementRef, attribute: &str) -> Option<*mut c_void> {
        unsafe {
            let attribute = CFString::new(attribute);
            let mut value: *mut c_void = ptr::null_mut();
            let err = AXUIElementCopyAttributeValue(
                element,
                attribute.as_concrete_TypeRef() as *const c_void,
                &mut value,
            );

            if err == AX_ERROR_SUCCESS && !value.is_null() {
                return Some(value);
            }

            None
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_uia {
    use super::{FocusedTextSnapshot, MAX_FOCUSED_TEXT_SNAPSHOT_LEN};
    use windows::Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
            CoUninitialize,
        },
        UI::Accessibility::{
            CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
            IUIAutomationValuePattern, UIA_TextPatternId, UIA_ValuePatternId,
        },
    };

    pub(super) fn focused_text_snapshot() -> Option<FocusedTextSnapshot> {
        unsafe {
            let _guard = ComGuard::new()?;
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let element = automation.GetFocusedElement().ok()?;

            if element.CurrentIsPassword().ok()?.as_bool() {
                return None;
            }

            let value = read_text_value(&element)?;
            if value.len() > MAX_FOCUSED_TEXT_SNAPSHOT_LEN {
                return None;
            }

            let pid = element.CurrentProcessId().ok()?;
            let role = element
                .CurrentControlType()
                .ok()
                .map(|control_type| control_type.0.to_string());
            let subrole = element
                .CurrentLocalizedControlType()
                .ok()
                .map(|control_type| control_type.to_string());
            let frame = element.CurrentBoundingRectangle().ok().map(|rect| {
                (
                    rect.left as f64,
                    rect.top as f64,
                    (rect.right - rect.left) as f64,
                    (rect.bottom - rect.top) as f64,
                )
            });

            Some(FocusedTextSnapshot {
                pid,
                role,
                subrole,
                value,
                frame,
            })
        }
    }

    fn read_text_value(element: &IUIAutomationElement) -> Option<String> {
        unsafe {
            if let Ok(pattern) =
                element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            {
                return Some(pattern.CurrentValue().ok()?.to_string());
            }

            let pattern = element
                .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                .ok()?;
            let range = pattern.DocumentRange().ok()?;
            let max_length = MAX_FOCUSED_TEXT_SNAPSHOT_LEN
                .saturating_add(1)
                .try_into()
                .ok()?;

            Some(range.GetText(max_length).ok()?.to_string())
        }
    }

    struct ComGuard {
        uninitialize_on_drop: bool,
    }

    impl ComGuard {
        fn new() -> Option<Self> {
            let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if result.is_ok() {
                Some(Self {
                    uninitialize_on_drop: true,
                })
            } else if result == RPC_E_CHANGED_MODE {
                Some(Self {
                    uninitialize_on_drop: false,
                })
            } else {
                None
            }
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.uninitialize_on_drop {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
const COPY_KEY: CGKeyCode = 8;
#[cfg(target_os = "macos")]
const PASTE_KEY: CGKeyCode = 9;

#[cfg(target_os = "macos")]
fn send_shortcut_keystroke(key: CGKeyCode) -> Result<()> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| anyhow!("Failed to create CGEventSource"))?;

    let key_down = CGEvent::new_keyboard_event(source.clone(), key, true)
        .map_err(|_| anyhow!("Failed to create key-down event"))?;
    key_down.set_flags(CGEventFlags::CGEventFlagCommand);
    key_down.post(CGEventTapLocation::HID);

    thread::sleep(Duration::from_millis(5));

    let key_up = CGEvent::new_keyboard_event(source, key, false)
        .map_err(|_| anyhow!("Failed to create key-up event"))?;
    key_up.set_flags(CGEventFlags::empty());
    key_up.post(CGEventTapLocation::HID);

    Ok(())
}

#[cfg(target_os = "windows")]
pub fn get_selected_text_ax() -> Option<String> {
    copy_selection_via_clipboard(Duration::from_millis(80))
}

#[cfg(target_os = "windows")]
const COPY_KEY: VIRTUAL_KEY = VK_C;
#[cfg(target_os = "windows")]
const PASTE_KEY: VIRTUAL_KEY = VK_V;

#[cfg(target_os = "windows")]
fn send_shortcut_keystroke(key: VIRTUAL_KEY) -> Result<()> {
    let inputs = [
        keyboard_input(VK_CONTROL, KEYBD_EVENT_FLAGS(0)),
        keyboard_input(key, KEYBD_EVENT_FLAGS(0)),
        keyboard_input(key, KEYEVENTF_KEYUP),
        keyboard_input(VK_CONTROL, KEYEVENTF_KEYUP),
    ];

    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err(anyhow!(
            "Failed to send Ctrl keystroke for virtual key {}",
            key.0
        ));
    }

    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn paste_text(text: &str) -> Result<()> {
    let mut clipboard = Clipboard::new().map_err(|e| anyhow!("Failed to access clipboard: {e}"))?;

    let backup = ClipboardBackup::capture(&mut clipboard);

    let inserted_text = text.to_string();
    set_text_excluding_history(&mut clipboard, inserted_text.clone())?;

    thread::sleep(Duration::from_millis(10));

    let paste_result = send_shortcut_keystroke(PASTE_KEY);

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        if let Ok(mut clipboard) = Clipboard::new()
            && should_restore_after_paste(&mut clipboard, &inserted_text)
        {
            backup.restore(&mut clipboard);
        }
    });

    paste_result
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn copy_text_to_clipboard(text: &str) -> Result<()> {
    let mut clipboard = Clipboard::new().map_err(|e| anyhow!("Failed to access clipboard: {e}"))?;
    set_text_excluding_history(&mut clipboard, text.to_string())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn set_text_excluding_history(clipboard: &mut Clipboard, text: String) -> Result<()> {
    clipboard
        .set()
        .exclude_from_history()
        .text(text)
        .map_err(|e| anyhow!("Failed to set clipboard: {e}"))?;
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn should_restore_after_paste(clipboard: &mut Clipboard, inserted_text: &str) -> bool {
    match clipboard.get_text() {
        Ok(current) => return current == inserted_text || current.is_empty(),
        Err(ClipboardError::ContentNotAvailable) => {}
        Err(_) => return false,
    }

    clipboard
        .get()
        .html()
        .is_err_and(|err| matches!(err, ClipboardError::ContentNotAvailable))
        && clipboard
            .get_image()
            .is_err_and(|err| matches!(err, ClipboardError::ContentNotAvailable))
        && clipboard
            .get()
            .file_list()
            .is_err_and(|err| matches!(err, ClipboardError::ContentNotAvailable))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn copy_selection_via_clipboard(settle: Duration) -> Option<String> {
    let mut clipboard = Clipboard::new().ok()?;
    let backup = ClipboardBackup::capture(&mut clipboard);

    if clipboard.clear().is_err() {
        backup.restore(&mut clipboard);
        return None;
    }
    thread::sleep(Duration::from_millis(5));

    if send_shortcut_keystroke(COPY_KEY).is_err() {
        backup.restore(&mut clipboard);
        return None;
    }
    thread::sleep(settle);

    let text = clipboard.get_text().ok();
    backup.restore(&mut clipboard);

    match text {
        Some(t) if !t.trim().is_empty() => Some(t),
        _ => None,
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct ClipboardBackup {
    text: Option<String>,
    html: Option<String>,
    image: Option<ImageData<'static>>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
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
                let _ = set_text_excluding_history(clipboard, text);
                return;
            }
        }

        if let Some(image) = image {
            let _ = clipboard.set_image(image);
            return;
        }

        if let Some(text) = text {
            let _ = set_text_excluding_history(clipboard, text);
        } else {
            let _ = clipboard.clear();
        }
    }
}

#[cfg(target_os = "windows")]
fn keyboard_input(key: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}
