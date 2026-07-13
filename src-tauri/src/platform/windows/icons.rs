use std::collections::HashSet;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::AppRuntime;
use crate::personalization::icons::{
    InstalledApp, app_icon_cache_dir, icon_cache_file_path, should_refresh_icon,
};

const WINDOWS_ICON_SIZE: i32 = 64;

fn is_blacklisted_shortcut(name: &str) -> bool {
    let lowered = name.to_lowercase();
    let exact = [
        "desktop",
        "documents",
        "downloads",
        "file explorer",
        "help",
        "run",
        "settings",
        "this pc",
        "windows powershell",
    ];
    if exact.contains(&lowered.as_str()) {
        return true;
    }

    let noise_tokens = [
        "install",
        "installer",
        "license",
        "readme",
        "setup",
        "uninstall",
        "uninstaller",
        "update",
        "updater",
    ];
    noise_tokens.iter().any(|token| {
        lowered
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .any(|part| part == *token)
    })
}

fn collect_windows_shortcuts(
    dir: &Path,
    apps: &mut Vec<InstalledApp>,
    seen: &mut HashSet<String>,
    icon_cache_dir: Option<&Path>,
    pending_icon_warmup: &mut Vec<(PathBuf, String)>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name();
        if file_name.to_string_lossy().starts_with('.') {
            continue;
        }

        if path.is_dir() {
            collect_windows_shortcuts(&path, apps, seen, icon_cache_dir, pending_icon_warmup);
            continue;
        }

        let is_shortcut = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false);
        if !is_shortcut {
            continue;
        }

        let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || is_blacklisted_shortcut(name) {
            continue;
        }

        let key = name.to_lowercase();
        if seen.insert(key) {
            let icon_path = icon_cache_dir.and_then(|cache_dir| {
                let cached_path = icon_cache_file_path(&path, cache_dir);
                if cached_path.exists() {
                    if shortcut_icon_cache_should_refresh(&path, &cached_path) {
                        pending_icon_warmup.push((path.clone(), name.to_string()));
                    }
                    Some(cached_path.to_string_lossy().to_string())
                } else {
                    pending_icon_warmup.push((path.clone(), name.to_string()));
                    None
                }
            });
            apps.push(InstalledApp {
                name: name.to_string(),
                path: path.to_string_lossy().to_string(),
                icon_path,
            });
        }
    }
}

fn windows_start_menu_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(program_data) = std::env::var("PROGRAMDATA") {
        roots.push(
            PathBuf::from(program_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    if let Ok(app_data) = std::env::var("APPDATA") {
        roots.push(
            PathBuf::from(app_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    roots
}

fn path_to_wide_null(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn wide_buffer_to_string(buffer: &[u16]) -> Option<String> {
    let len = buffer
        .iter()
        .position(|ch| *ch == 0)
        .unwrap_or(buffer.len());
    if len == 0 {
        return None;
    }
    let value = String::from_utf16_lossy(&buffer[..len]).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn resolve_shortcut_icon_source(shortcut_path: &Path) -> Option<(PathBuf, i32)> {
    use windows::Win32::Foundation::S_OK;
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize, IPersistFile, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::core::{Interface, PCWSTR};

    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let should_uninitialize = hr == S_OK;
    let result = (|| {
        let shell_link: IShellLinkW =
            unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()? };
        let persist_file: IPersistFile = shell_link.cast().ok()?;
        let shortcut_wide = path_to_wide_null(shortcut_path);
        unsafe {
            persist_file
                .Load(PCWSTR(shortcut_wide.as_ptr()), STGM_READ)
                .ok()?;
        }

        let mut icon_buffer = vec![0u16; 260];
        let mut icon_index = 0i32;
        if unsafe {
            shell_link
                .GetIconLocation(&mut icon_buffer, &mut icon_index)
                .is_ok()
        } {
            if let Some(icon_path) = wide_buffer_to_string(&icon_buffer) {
                let icon_path = PathBuf::from(icon_path);
                if icon_path.exists() {
                    return Some((icon_path, icon_index));
                }
            }
        }

        let mut target_buffer = vec![0u16; 260];
        if unsafe {
            shell_link
                .GetPath(&mut target_buffer, std::ptr::null_mut(), 0)
                .is_ok()
        } {
            if let Some(target_path) = wide_buffer_to_string(&target_buffer) {
                let target_path = PathBuf::from(target_path);
                if target_path.exists() {
                    return Some((target_path, 0));
                }
            }
        }

        None
    })();

    if should_uninitialize {
        unsafe {
            CoUninitialize();
        }
    }
    result
}

fn write_bgra_png(path: &Path, width: u32, height: u32, pixels: &[u8]) -> Option<()> {
    let pixel_bytes = width.checked_mul(height)?.checked_mul(4)?;
    if pixels.len() != pixel_bytes as usize {
        return None;
    }

    let mut rgba = Vec::with_capacity(pixels.len());
    for pixel in pixels.chunks_exact(4) {
        rgba.push(pixel[2]);
        rgba.push(pixel[1]);
        rgba.push(pixel[0]);
        rgba.push(pixel[3]);
    }

    let parent = path.parent()?;
    let file_name = path.file_name()?.to_string_lossy();
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let temp_path = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        suffix
    ));

    let result = (|| {
        let file = std::fs::File::create(&temp_path).ok()?;
        let mut encoder = png::Encoder::new(file, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
        drop(writer);
        let temp_wide = path_to_wide_null(&temp_path);
        let path_wide = path_to_wide_null(path);
        unsafe {
            windows::Win32::Storage::FileSystem::MoveFileExW(
                windows::core::PCWSTR(temp_wide.as_ptr()),
                windows::core::PCWSTR(path_wide.as_ptr()),
                windows::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                    | windows::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
            )
            .ok()?;
        }
        Some(())
    })();

    if result.is_none() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

fn write_hicon_to_png(
    icon: windows::Win32::UI::WindowsAndMessaging::HICON,
    cached_icon: &Path,
) -> Option<()> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
        DeleteDC, DeleteObject, SelectObject,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DI_NORMAL, DrawIconEx};

    let mut pixels = Vec::new();
    let mut bits: *mut c_void = std::ptr::null_mut();
    let bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: WINDOWS_ICON_SIZE,
            biHeight: -WINDOWS_ICON_SIZE,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: (WINDOWS_ICON_SIZE * WINDOWS_ICON_SIZE * 4) as u32,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: Default::default(),
    };

    let dc = unsafe { CreateCompatibleDC(None) };
    if !dc.is_invalid() {
        if let Ok(bitmap) =
            unsafe { CreateDIBSection(None, &bitmap_info, DIB_RGB_COLORS, &mut bits, None, 0) }
        {
            let previous = unsafe { SelectObject(dc, bitmap.into()) };
            let drawn = unsafe {
                DrawIconEx(
                    dc,
                    0,
                    0,
                    icon,
                    WINDOWS_ICON_SIZE,
                    WINDOWS_ICON_SIZE,
                    0,
                    None,
                    DI_NORMAL,
                )
                .is_ok()
            };
            if drawn && !bits.is_null() {
                let len = (WINDOWS_ICON_SIZE * WINDOWS_ICON_SIZE * 4) as usize;
                pixels = unsafe { std::slice::from_raw_parts(bits as *const u8, len) }.to_vec();
                for pixel in pixels.chunks_exact_mut(4) {
                    if pixel[3] == 0 && (pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0) {
                        pixel[3] = 255;
                    }
                }
            }
            if !previous.is_invalid() {
                unsafe {
                    SelectObject(dc, previous);
                }
            }
            unsafe {
                let _ = DeleteObject(bitmap.into());
            }
        }
        unsafe {
            let _ = DeleteDC(dc);
        }
    }

    if pixels.is_empty() {
        return None;
    }

    write_bgra_png(
        cached_icon,
        WINDOWS_ICON_SIZE as u32,
        WINDOWS_ICON_SIZE as u32,
        &pixels,
    )
}

fn extract_icon_handle(
    source_path: &Path,
    icon_index: i32,
) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Controls::{IImageList, ILD_TRANSPARENT};
    use windows::Win32::UI::Shell::{
        ExtractIconExW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_SYSICONINDEX,
        SHGetFileInfoW, SHGetImageList, SHIL_EXTRALARGE, SHIL_JUMBO,
    };
    use windows::core::PCWSTR;

    let wide_path = path_to_wide_null(source_path);
    let mut large_icon = windows::Win32::UI::WindowsAndMessaging::HICON::default();
    let extracted = unsafe {
        ExtractIconExW(
            PCWSTR(wide_path.as_ptr()),
            icon_index,
            Some(&mut large_icon),
            None,
            1,
        )
    };
    if extracted > 0 && !large_icon.is_invalid() {
        return Some(large_icon);
    }

    let mut shell_info = SHFILEINFOW::default();
    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide_path.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shell_info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX,
        )
    };
    if result != 0 {
        for image_list_size in [SHIL_JUMBO, SHIL_EXTRALARGE] {
            if let Ok(image_list) = unsafe { SHGetImageList::<IImageList>(image_list_size as i32) }
            {
                if let Ok(icon) = unsafe { image_list.GetIcon(shell_info.iIcon, ILD_TRANSPARENT.0) }
                {
                    if !icon.is_invalid() {
                        return Some(icon);
                    }
                }
            }
        }
    }

    let mut shell_info = SHFILEINFOW::default();
    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide_path.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shell_info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if result == 0 || shell_info.hIcon.is_invalid() {
        None
    } else {
        Some(shell_info.hIcon)
    }
}

fn shortcut_icon_source(shortcut_path: &Path) -> Option<(PathBuf, i32)> {
    let is_shortcut = shortcut_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("lnk"))
        .unwrap_or(false);
    if !is_shortcut {
        return None;
    }

    resolve_shortcut_icon_source(shortcut_path)
}

fn shortcut_icon_cache_should_refresh(shortcut_path: &Path, cached_icon: &Path) -> bool {
    let Some((source_path, _)) = shortcut_icon_source(shortcut_path) else {
        return true;
    };
    should_refresh_icon(&source_path, cached_icon)
}

fn ensure_cached_icon(shortcut_path: &Path, _app_name: &str, cache_dir: &Path) -> Option<PathBuf> {
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    let cached_icon = icon_cache_file_path(shortcut_path, cache_dir);
    let (source_path, icon_index) = shortcut_icon_source(shortcut_path)?;
    if !should_refresh_icon(&source_path, &cached_icon) {
        return Some(cached_icon);
    }

    let icon = extract_icon_handle(&source_path, icon_index)?;
    let wrote_icon = write_hicon_to_png(icon, &cached_icon).is_some();
    unsafe {
        let _ = DestroyIcon(icon);
    }
    wrote_icon.then_some(cached_icon)
}

fn warm_icon_cache_in_background(pending: Vec<(PathBuf, String)>, cache_dir: PathBuf) {
    if pending.is_empty() {
        return;
    }

    std::thread::spawn(move || {
        for (shortcut_path, app_name) in pending {
            let _ = ensure_cached_icon(&shortcut_path, &app_name, &cache_dir);
        }
    });
}

pub fn list_installed_apps(app: &AppHandle<AppRuntime>) -> Result<Vec<InstalledApp>, String> {
    let mut apps = Vec::new();
    let mut seen = HashSet::new();
    let icon_cache_dir = app_icon_cache_dir(app);
    let mut pending_icon_warmup = Vec::new();

    for root in windows_start_menu_roots() {
        collect_windows_shortcuts(
            &root,
            &mut apps,
            &mut seen,
            icon_cache_dir.as_deref(),
            &mut pending_icon_warmup,
        );
    }

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    if let Some(cache_dir) = icon_cache_dir {
        warm_icon_cache_in_background(pending_icon_warmup, cache_dir);
    }
    Ok(apps)
}
