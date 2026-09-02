//! CLI-side control-socket client: connect to the running app (or launch it and
//! wait for the socket), then send one request and read one response.

use std::io::{BufRead, BufReader, Write};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use interprocess::local_socket::{Stream, prelude::*};
use serde_json::Value;

use super::coded;
use super::ipc::{Request, Response, socket_name};

/// How long to wait for a freshly launched app to start serving the socket.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Send a command to the running app and return its response. Launches the app
/// if it isn't running.
pub(crate) fn request(command: &str, args: Value) -> Result<Response> {
    let stream = connect_or_launch()?;
    exchange(stream, command, args)
}

/// Convenience wrapper: send a command and return the `data` payload, turning a
/// non-ok response into a job error (exit code 3).
pub(crate) fn request_data(command: &str, args: Value) -> Result<Value> {
    let response = request(command, args)?;
    if response.ok {
        Ok(response.data)
    } else {
        Err(coded(
            3,
            response
                .error
                .unwrap_or_else(|| "Glimpse reported an error".to_string()),
        ))
    }
}

/// Send a command only if the app is already running. Returns `Ok(None)` if the
/// app isn't reachable (does not launch it).
pub(crate) fn try_request(command: &str, args: Value) -> Result<Option<Response>> {
    let Some(stream) = try_connect() else {
        return Ok(None);
    };
    Ok(Some(exchange(stream, command, args)?))
}

/// Like `try_request`, but unwraps the response: `Some(data)` on success,
/// exit code 3 with the server's message on failure, `None` when not running.
pub(crate) fn try_request_data(command: &str, args: Value, failure: &str) -> Result<Option<Value>> {
    match try_request(command, args)? {
        Some(response) if response.ok => Ok(Some(response.data)),
        Some(response) => Err(coded(
            3,
            response.error.unwrap_or_else(|| failure.to_string()),
        )),
        None => Ok(None),
    }
}

fn exchange(stream: Stream, command: &str, args: Value) -> Result<Response> {
    let request = Request::new(command, args);
    let mut line = serde_json::to_string(&request)?;
    line.push('\n');

    let mut writer = stream;
    writer
        .write_all(line.as_bytes())
        .context("Failed to send request to Glimpse")?;
    writer
        .flush()
        .context("Failed to flush request to Glimpse")?;

    let mut reader = BufReader::new(writer);
    let mut response_line = String::new();
    reader
        .read_line(&mut response_line)
        .context("Failed to read response from Glimpse")?;
    if response_line.trim().is_empty() {
        bail!("Glimpse closed the connection without responding");
    }
    serde_json::from_str(response_line.trim()).context("Glimpse returned a malformed response")
}

fn try_connect() -> Option<Stream> {
    let name = socket_name().ok()?;
    Stream::connect(name).ok()
}

fn connect_or_launch() -> Result<Stream> {
    if let Some(stream) = try_connect() {
        return Ok(stream);
    }

    launch_app().map_err(|err| {
        coded(
            2,
            format!("Glimpse is not running and could not be launched: {err}"),
        )
    })?;

    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    loop {
        std::thread::sleep(POLL_INTERVAL);
        if let Some(stream) = try_connect() {
            return Ok(stream);
        }
        if Instant::now() >= deadline {
            return Err(coded(
                2,
                "Glimpse did not finish starting up in time. Try again in a moment.",
            ));
        }
    }
}

/// Launch the GUI app in the background without blocking. Child stdio is
/// silenced so a detached launch can't bleed output into the CLI's own output.
fn launch_app() -> Result<()> {
    use std::process::Stdio;
    let exe = std::env::current_exe().context("Could not resolve the Glimpse binary path")?;

    #[cfg(target_os = "macos")]
    {
        // `open <bundle>` launches it as a proper GUI app; fall back to the
        // binary directly if the enclosing .app can't be found.
        if let Some(bundle) = macos_app_bundle(&exe) {
            std::process::Command::new("/usr/bin/open")
                .arg(bundle)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .context("Failed to launch Glimpse via `open`")?;
            return Ok(());
        }
    }

    // On Windows the CLI runs via a shim that sets GLIMPSE_CLI_SHIM; strip it so
    // the spawned process starts the GUI instead of re-entering CLI mode.
    std::process::Command::new(&exe)
        .env_remove("GLIMPSE_CLI_SHIM")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("Failed to launch {}", exe.display()))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_app_bundle(exe: &std::path::Path) -> Option<std::path::PathBuf> {
    // …/Glimpse.app/Contents/MacOS/Glimpse → …/Glimpse.app
    let mut current = exe;
    while let Some(parent) = current.parent() {
        if parent.extension().and_then(|ext| ext.to_str()) == Some("app") {
            return Some(parent.to_path_buf());
        }
        current = parent;
    }
    None
}
