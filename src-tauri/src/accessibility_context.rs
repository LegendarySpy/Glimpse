use crate::permissions;

pub struct ActiveContext {
    pub app_name: String,
    pub window_title: String,
    pub url: Option<String>,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::ActiveContext;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::CFString;
    use std::ffi::c_void;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[allow(non_camel_case_types)]
    type pid_t = i32;

    // Cap how long any cross-process query may block the caller.
    const AX_TIMEOUT_SECS: f32 = 2.0;
    const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(2);

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXUIElementCreateApplication(pid: pid_t) -> *mut c_void;
        fn AXUIElementCopyAttributeValue(
            element: *mut c_void,
            attribute: *const c_void,
            value: *mut *mut c_void,
        ) -> i32;
        fn AXUIElementSetMessagingTimeout(element: *mut c_void, timeout: f32) -> i32;
        fn CFRelease(cf: *const c_void);
    }

    // Runs a command but kills it if it outlives the deadline, so a wedged
    // target process (e.g. an unresponsive System Events) can't block us forever.
    fn output_with_timeout(mut command: Command, timeout: Duration) -> Option<Vec<u8>> {
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return None;
                    }
                    return child.wait_with_output().ok().map(|o| o.stdout);
                }
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return None,
            }
        }
    }

    unsafe fn copy_attribute(element: *mut c_void, attribute: &str) -> *mut c_void {
        unsafe {
            let attribute = CFString::new(attribute);
            let mut value: *mut c_void = std::ptr::null_mut();
            let result = AXUIElementCopyAttributeValue(
                element,
                attribute.as_concrete_TypeRef() as *const c_void,
                &mut value,
            );
            if result != 0 {
                std::ptr::null_mut()
            } else {
                value
            }
        }
    }

    unsafe fn read_string_attribute(element: *mut c_void, attribute: &str) -> Option<String> {
        unsafe {
            let value = copy_attribute(element, attribute);
            if value.is_null() {
                return None;
            }

            let cf_type: CFType = CFType::wrap_under_create_rule(value as *const _);
            let cf_string = cf_type.downcast::<CFString>()?;
            Some(cf_string.to_string())
        }
    }

    fn get_frontmost_app() -> Option<(String, pid_t)> {
        let script = r#"
tell application "System Events"
    set frontProcess to first application process whose frontmost is true
    set appName to name of frontProcess
    set appPID to unix id of frontProcess
    return appName & "|" & appPID
end tell
"#;
        let mut command = Command::new("osascript");
        command.args(["-e", script]);
        let stdout_bytes = output_with_timeout(command, OSASCRIPT_TIMEOUT)?;

        let stdout = String::from_utf8(stdout_bytes).ok()?;
        let trimmed = stdout.trim();
        let parts: Vec<&str> = trimmed.splitn(2, '|').collect();
        if parts.len() != 2 {
            return None;
        }

        let name = parts[0].trim().to_string();
        let pid: pid_t = parts[1].trim().parse().ok()?;

        if name.is_empty() {
            return None;
        }

        Some((name, pid))
    }

    pub fn get_active_context() -> Option<ActiveContext> {
        let (app_name, pid) = get_frontmost_app()?;

        let (window_title, url) = unsafe {
            let app_element = AXUIElementCreateApplication(pid);
            if app_element.is_null() {
                return None;
            } else {
                AXUIElementSetMessagingTimeout(app_element, AX_TIMEOUT_SECS);
                let window_element = copy_attribute(app_element, "AXFocusedWindow");
                if !window_element.is_null() {
                    AXUIElementSetMessagingTimeout(window_element, AX_TIMEOUT_SECS);
                }
                let title = if window_element.is_null() {
                    String::new()
                } else {
                    read_string_attribute(window_element, "AXTitle")
                        .unwrap_or_default()
                        .trim()
                        .to_string()
                };

                let doc = if window_element.is_null() {
                    None
                } else {
                    read_string_attribute(window_element, "AXDocument")
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                };

                if !window_element.is_null() {
                    CFRelease(window_element);
                }
                CFRelease(app_element);

                (title, doc)
            }
        };

        Some(ActiveContext {
            app_name,
            window_title,
            url,
        })
    }
}

#[cfg(target_os = "macos")]
pub use macos::get_active_context;

#[cfg(target_os = "windows")]
mod windows_context {
    use super::ActiveContext;
    use std::path::Path;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };
    use windows::core::PWSTR;

    fn foreground_window() -> Option<HWND> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_invalid() { None } else { Some(hwnd) }
    }

    fn window_title(hwnd: HWND) -> String {
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return String::new();
        }

        let mut buffer = vec![0u16; (len as usize) + 1];
        let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        if copied <= 0 {
            return String::new();
        }

        String::from_utf16_lossy(&buffer[..copied as usize])
            .trim()
            .to_string()
    }

    fn process_image_path(pid: u32) -> Option<String> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };
        let mut buffer = vec![0u16; 32_768];
        let mut size = buffer.len() as u32;
        let result = unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buffer.as_mut_ptr()),
                &mut size,
            )
        };
        let _ = unsafe { CloseHandle(handle) };
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }

    fn app_name_from_path(path: &str) -> String {
        Path::new(path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(path)
            .trim()
            .to_string()
    }

    pub fn get_active_context() -> Option<ActiveContext> {
        let hwnd = foreground_window()?;
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        if pid == 0 {
            return None;
        }

        let app_name = process_image_path(pid)
            .map(|path| app_name_from_path(&path))
            .filter(|name| !name.is_empty())?;

        Some(ActiveContext {
            app_name,
            window_title: window_title(hwnd),
            url: None,
        })
    }
}

#[cfg(target_os = "windows")]
pub use windows_context::get_active_context;

fn truncate_text(text: &str, max_len: usize) -> String {
    text.chars().take(max_len).collect()
}

pub fn log_active_context() {
    if !permissions::check_accessibility_permission() {
        return;
    }

    let context = match get_active_context() {
        Some(context) => context,
        None => return,
    };

    let window_summary = if context.window_title.is_empty() {
        "(none)".to_string()
    } else {
        truncate_text(&context.window_title, 120)
    };
    let url_summary = context
        .url
        .as_ref()
        .map(|url| truncate_text(url, 160))
        .unwrap_or_else(|| "(none)".to_string());

    tracing::debug!(
        "[Accessibility] Active app: {} | Window: {} | URL: {}",
        context.app_name,
        window_summary,
        url_summary
    );
}
