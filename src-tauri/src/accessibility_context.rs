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
    use std::process::Command;

    #[allow(non_camel_case_types)]
    type pid_t = i32;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: pid_t) -> *mut c_void;
        fn AXUIElementCopyAttributeValue(
            element: *mut c_void,
            attribute: *const c_void,
            value: *mut *mut c_void,
        ) -> i32;
        fn CFRelease(cf: *const c_void);
    }

    unsafe fn copy_attribute(element: *mut c_void, attribute: &str) -> *mut c_void {
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

    unsafe fn read_string_attribute(element: *mut c_void, attribute: &str) -> Option<String> {
        let value = copy_attribute(element, attribute);
        if value.is_null() {
            return None;
        }

        let cf_type: CFType = CFType::wrap_under_create_rule(value as *const _);
        let cf_string = cf_type.downcast::<CFString>()?;
        Some(cf_string.to_string())
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
        let output = Command::new("osascript")
            .args(["-e", script])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let stdout = String::from_utf8(output.stdout).ok()?;
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
                (String::new(), None)
            } else {
                let window_element = copy_attribute(app_element, "AXFocusedWindow");
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

#[cfg(not(target_os = "macos"))]
pub fn get_active_context() -> Option<ActiveContext> {
    None
}

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

    eprintln!(
        "[Accessibility] Active app: {} | Window: {} | URL: {}",
        context.app_name, window_summary, url_summary
    );
}
