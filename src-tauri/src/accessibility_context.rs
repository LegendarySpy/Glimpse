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

    unsafe fn copy_attribute(element: *mut c_void, attribute: &str) -> *mut c_void {
        let attribute = CFString::new(attribute);
        let mut value: *mut c_void = ptr::null_mut();
        let result = AXUIElementCopyAttributeValue(
            element,
            attribute.as_concrete_TypeRef() as *const c_void,
            &mut value,
        );
        if result != 0 {
            ptr::null_mut()
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

    pub fn get_active_context() -> Option<ActiveContext> {
        unsafe {
            let system_wide = AXUIElementCreateSystemWide();
            if system_wide.is_null() {
                return None;
            }

            let app_element = copy_attribute(system_wide, "AXFocusedApplication");
            CFRelease(system_wide);
            if app_element.is_null() {
                return None;
            }

            let app_name = read_string_attribute(app_element, "AXTitle")
                .or_else(|| read_string_attribute(app_element, "AXRoleDescription"))
                .unwrap_or_else(|| "Unknown App".to_string())
                .trim()
                .to_string();

            let window_element = copy_attribute(app_element, "AXFocusedWindow");
            let window_title = if window_element.is_null() {
                String::new()
            } else {
                read_string_attribute(window_element, "AXTitle")
                    .unwrap_or_default()
                    .trim()
                    .to_string()
            };

            let url = if window_element.is_null() {
                None
            } else {
                read_string_attribute(window_element, "AXDocument")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            };

            if !window_element.is_null() {
                CFRelease(window_element);
            }
            CFRelease(app_element);

            Some(ActiveContext {
                app_name,
                window_title,
                url,
            })
        }
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
