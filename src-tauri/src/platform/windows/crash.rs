use std::os::windows::io::AsRawHandle;
use std::path::PathBuf;
use std::sync::OnceLock;

use windows::Win32::Foundation::{HANDLE, HMODULE};
use windows::Win32::System::Diagnostics::Debug::{
    EXCEPTION_POINTERS, MINIDUMP_EXCEPTION_INFORMATION, MINIDUMP_TYPE, MiniDumpWithThreadInfo,
    MiniDumpWriteDump, SetUnhandledExceptionFilter,
};
use windows::Win32::System::LibraryLoader::{
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    GetModuleFileNameW, GetModuleHandleExW,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId,
};
use windows::core::PCWSTR;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const EXCEPTION_CONTINUE_SEARCH: i32 = 0;
const DUMP_FILE_NAME: &str = "crash.dmp";

type ExceptionFilter = unsafe extern "system" fn(*const EXCEPTION_POINTERS) -> i32;

struct CrashPaths {
    log_dir: PathBuf,
    marker: PathBuf,
}

static PATHS: OnceLock<CrashPaths> = OnceLock::new();
static PREV_FILTER: OnceLock<Option<ExceptionFilter>> = OnceLock::new();

pub fn install(log_dir: PathBuf, marker: PathBuf) {
    if PATHS.set(CrashPaths { log_dir, marker }).is_err() {
        return;
    }
    unsafe {
        let prev = SetUnhandledExceptionFilter(Some(handler));
        let _ = PREV_FILTER.set(prev);
    }
}

unsafe extern "system" fn handler(info: *const EXCEPTION_POINTERS) -> i32 {
    let Some(paths) = PATHS.get() else {
        return EXCEPTION_CONTINUE_SEARCH;
    };
    if info.is_null() {
        return EXCEPTION_CONTINUE_SEARCH;
    }

    let dump_written = write_minidump(paths, info);

    let record = (*info).ExceptionRecord;
    let (code, address) = if record.is_null() {
        (0u32, std::ptr::null_mut())
    } else {
        ((*record).ExceptionCode.0 as u32, (*record).ExceptionAddress)
    };
    // Group on a module-relative offset, not the absolute (ASLR-randomized) address.
    let (module, location) = match faulting_module(address) {
        Some((name, base)) => {
            let offset = (address as usize).saturating_sub(base);
            (name.clone(), format!("{name}+{offset:#x}"))
        }
        None => ("unknown".to_string(), "unknown".to_string()),
    };

    // First three lines match the panic marker; analytics folds in the rest.
    let marker_body = format!(
        "{APP_VERSION}\n{location}\nnative\nexception_code={code:#010x}\nfaulting_module={module}\nminidump={}\ncrash_phase={}\n",
        if dump_written { DUMP_FILE_NAME } else { "none" },
        crate::analytics::crash_phase(),
    );
    let _ = std::fs::write(&paths.marker, marker_body);

    // Chain to whatever filter we replaced so an existing reporter still runs.
    match PREV_FILTER.get().copied().flatten() {
        Some(prev) => prev(info),
        None => EXCEPTION_CONTINUE_SEARCH,
    }
}

// Best-effort, in-process. MS suggests a separate process/thread (loader-lock
// risk); accepted here, and we capture the dump before any other handler work.
unsafe fn write_minidump(paths: &CrashPaths, info: *const EXCEPTION_POINTERS) -> bool {
    let Ok(file) = std::fs::File::create(paths.log_dir.join(DUMP_FILE_NAME)) else {
        return false;
    };
    let file_handle = HANDLE(file.as_raw_handle() as _);

    let exception = MINIDUMP_EXCEPTION_INFORMATION {
        ThreadId: GetCurrentThreadId(),
        ExceptionPointers: info as *mut EXCEPTION_POINTERS,
        ClientPointers: false.into(),
    };

    MiniDumpWriteDump(
        GetCurrentProcess(),
        GetCurrentProcessId(),
        file_handle,
        MINIDUMP_TYPE(MiniDumpWithThreadInfo.0),
        Some(std::ptr::addr_of!(exception)),
        None,
        None,
    )
    .is_ok()
}

// Returns the faulting module's file name and its base address, so the caller
// can record an ASLR-independent module-relative offset.
unsafe fn faulting_module(address: *mut core::ffi::c_void) -> Option<(String, usize)> {
    if address.is_null() {
        return None;
    }
    let mut module = HMODULE::default();
    GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        PCWSTR(address as *const u16),
        &mut module,
    )
    .ok()?;

    let mut buffer = [0u16; 260];
    let len = GetModuleFileNameW(Some(module), &mut buffer);
    if len == 0 {
        return None;
    }
    let path = String::from_utf16_lossy(&buffer[..len as usize]);
    let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
    Some((name, module.0 as usize))
}
