use std::collections::HashSet;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{Result, anyhow};
use crossbeam_channel::{Receiver, Sender, select, unbounded};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub(crate) use super::keyboard::Hotkey;
use super::keyboard::{
    Key, KeyEvent, KeyboardListener, Modifiers, blocking_hotkeys, empty_blocking_hotkeys,
};
use crate::{AppRuntime, pill};

pub(crate) const SHORTCUT_CAPTURE_EVENT: &str = "shortcut:capture";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HotkeyState {
    Pressed,
    Released,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShortcutAction {
    Smart,
    Hold,
    Toggle,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ShortcutOptions {
    pub temporary: bool,
    pub cleanup_enabled: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RegisteredHotkey {
    pub hotkey: Hotkey,
    pub action: ShortcutAction,
    pub options: ShortcutOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ShortcutCapturePayload {
    Preview { shortcut: String },
    Captured { shortcut: String },
    Error { message: String },
}

#[derive(Default)]
pub(crate) struct HotkeyCoordinator {
    registration: Mutex<Option<WorkerSession>>,
    capture: Mutex<Option<WorkerSession>>,
}

impl HotkeyCoordinator {
    pub(crate) fn replace_registrations(
        &self,
        app: &AppHandle<AppRuntime>,
        bindings: Vec<RegisteredHotkey>,
    ) -> Result<()> {
        self.stop_registration();

        if bindings.is_empty() {
            return Ok(());
        }

        let app_handle = app.clone();
        let session = WorkerSession::spawn("shortcut-registration", move |stop_rx| {
            let blocked = blocking_hotkeys(bindings.iter().map(|binding| binding.hotkey).collect());
            let listener = KeyboardListener::new(blocked)?;
            let mut state = RegisteredShortcutState::new(bindings);
            loop {
                select! {
                    recv(stop_rx) -> _ => break,
                    recv(listener.events()) -> event => {
                        let Ok(event) = event else {
                            break;
                        };

                        for (action, hotkey_state, options) in state.process(event) {
                            pill::handle_registered_hotkey_event(
                                &app_handle,
                                action,
                                hotkey_state,
                                options,
                            );
                        }
                    }
                }
            }

            for (action, hotkey_state, options) in state.release_all() {
                pill::handle_registered_hotkey_event(&app_handle, action, hotkey_state, options);
            }
            Ok(())
        })?;

        *self.registration.lock() = Some(session);
        Ok(())
    }

    pub(crate) fn stop_registration(&self) {
        self.registration.lock().take();
    }

    pub(crate) fn start_capture(&self, app: &AppHandle<AppRuntime>) -> Result<()> {
        self.stop_capture();

        let app_handle = app.clone();
        let listener = match KeyboardListener::new(empty_blocking_hotkeys()) {
            Ok(listener) => listener,
            Err(err) => {
                let message = err.to_string();
                emit_capture_event(
                    app,
                    ShortcutCapturePayload::Error {
                        message: message.clone(),
                    },
                );
                return Err(anyhow!(message));
            }
        };

        let session = WorkerSession::spawn("shortcut-capture", move |stop_rx| {
            let mut capture = CaptureState::default();

            loop {
                select! {
                    recv(stop_rx) -> _ => break,
                    recv(listener.events()) -> event => {
                        let event = match event {
                            Ok(event) => event,
                            Err(_) => break,
                        };

                        match capture.process(event) {
                            CaptureOutcome::Idle => {}
                            CaptureOutcome::Preview(hotkey) => emit_capture_event(
                                &app_handle,
                                ShortcutCapturePayload::Preview {
                                    shortcut: hotkey.to_string(),
                                },
                            ),
                            CaptureOutcome::Captured(hotkey) => {
                                emit_capture_event(
                                    &app_handle,
                                    ShortcutCapturePayload::Captured {
                                        shortcut: hotkey.to_string(),
                                    },
                                );
                                break;
                            }
                            CaptureOutcome::Invalid(message) => {
                                emit_capture_event(
                                    &app_handle,
                                    ShortcutCapturePayload::Error {
                                        message: message.to_string(),
                                    },
                                );
                                break;
                            }
                        }
                    }
                }
            }

            Ok(())
        })?;

        *self.capture.lock() = Some(session);
        Ok(())
    }

    pub(crate) fn stop_capture(&self) {
        self.capture.lock().take();
    }
}

struct RegisteredShortcutState {
    bindings: Vec<RegisteredHotkey>,
    pressed: HashSet<usize>,
}

impl RegisteredShortcutState {
    fn new(bindings: Vec<RegisteredHotkey>) -> Self {
        Self {
            bindings,
            pressed: HashSet::new(),
        }
    }

    fn process(&mut self, event: KeyEvent) -> Vec<(ShortcutAction, HotkeyState, ShortcutOptions)> {
        if event.releases_everything() {
            return self.release_all();
        }

        let mut emitted = Vec::new();
        let released: Vec<usize> = self
            .bindings
            .iter()
            .enumerate()
            .filter_map(|(id, binding)| {
                if self.pressed.contains(&id)
                    && (!binding.hotkey.modifiers.matches(event.modifiers)
                        || (!event.is_key_down && binding.hotkey.key == event.key))
                {
                    Some(id)
                } else {
                    None
                }
            })
            .collect();

        for id in released {
            self.pressed.remove(&id);
            let binding = &self.bindings[id];
            emitted.push((binding.action, HotkeyState::Released, binding.options));
        }

        if event.is_key_down && !event.repeat {
            for (id, binding) in self.bindings.iter().enumerate() {
                if !binding.hotkey.matches_event(&event) {
                    continue;
                }

                let recovers_modifier_only_toggle = matches!(
                    binding.action,
                    ShortcutAction::Smart | ShortcutAction::Toggle
                ) && binding.hotkey.key.is_none()
                    && event
                        .changed_modifier
                        .is_some_and(|modifier| event.modifiers == modifier);

                if self.pressed.insert(id) || recovers_modifier_only_toggle {
                    emitted.push((binding.action, HotkeyState::Pressed, binding.options));
                }
            }
        }

        emitted
    }

    fn release_all(&mut self) -> Vec<(ShortcutAction, HotkeyState, ShortcutOptions)> {
        let mut pressed: Vec<usize> = self.pressed.drain().collect();
        pressed.sort_unstable();
        pressed
            .into_iter()
            .filter_map(|id| {
                self.bindings
                    .get(id)
                    .map(|binding| (binding.action, HotkeyState::Released, binding.options))
            })
            .collect()
    }
}

enum CaptureOutcome {
    Idle,
    Preview(Hotkey),
    Captured(Hotkey),
    Invalid(&'static str),
}

/// Records the fullest shortcut pressed during a gesture and commits it once
/// every part is released, so the result never depends on release order.
#[derive(Default)]
struct CaptureState {
    best: Option<Hotkey>,
    current_key: Option<Key>,
}

impl CaptureState {
    fn process(&mut self, event: KeyEvent) -> CaptureOutcome {
        if event.key == Some(Key::CapsLock) {
            return CaptureOutcome::Invalid("CapsLock cannot be used as a recording shortcut");
        }

        if let Some(key) = event.key {
            if event.is_key_down {
                self.current_key = Some(key);
            } else if self.current_key == Some(key) {
                self.current_key = None;
            }
        }

        if event.modifiers.is_empty() && self.current_key.is_none() {
            return match self.best.take() {
                Some(hotkey) => CaptureOutcome::Captured(hotkey),
                None => CaptureOutcome::Idle,
            };
        }

        if let Ok(candidate) = Hotkey::new(event.modifiers, self.current_key) {
            let should_update = match self.best {
                Some(current) => hotkey_rank(candidate) > hotkey_rank(current),
                None => true,
            };

            if should_update {
                self.best = Some(candidate);
                return CaptureOutcome::Preview(candidate);
            }
        }

        CaptureOutcome::Idle
    }
}

fn hotkey_rank(hotkey: Hotkey) -> (u32, u32) {
    (hotkey.modifiers.count(), u32::from(hotkey.key.is_some()))
}

fn emit_capture_event(app: &AppHandle<AppRuntime>, payload: ShortcutCapturePayload) {
    if let Err(err) = app.emit(SHORTCUT_CAPTURE_EVENT, payload) {
        tracing::error!("Failed to emit shortcut capture event: {err}");
    }
}

struct WorkerSession {
    stop_tx: Sender<()>,
    join_handle: Option<JoinHandle<()>>,
    thread_name: String,
}

impl WorkerSession {
    fn spawn<F>(thread_name: &str, task: F) -> Result<Self>
    where
        F: FnOnce(Receiver<()>) -> Result<()> + Send + 'static,
    {
        let (stop_tx, stop_rx) = unbounded();
        let join_handle = thread::Builder::new()
            .name(thread_name.to_string())
            .spawn(move || {
                if let Err(err) = task(stop_rx) {
                    tracing::error!("Hotkey worker exited with error: {err}");
                }
            })
            .map_err(|err| anyhow!("Failed to spawn hotkey worker: {err}"))?;

        Ok(Self {
            stop_tx,
            join_handle: Some(join_handle),
            thread_name: thread_name.to_string(),
        })
    }
}

impl Drop for WorkerSession {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(join_handle) = self.join_handle.take() {
            let thread_name = self.thread_name.clone();
            let (done_tx, done_rx) = crossbeam_channel::bounded(1);

            let join_result = thread::Builder::new()
                .name(format!("{thread_name}-join"))
                .spawn(move || {
                    let _ = join_handle.join();
                    let _ = done_tx.send(());
                });

            match join_result {
                Ok(_) => {
                    let watch_name = thread_name.clone();
                    let _ = thread::Builder::new()
                        .name(format!("{thread_name}-watch"))
                        .spawn(move || {
                            if done_rx.recv_timeout(Duration::from_secs(2)).is_err() {
                                tracing::error!(
                                    "Hotkey worker `{watch_name}` did not stop within 2s"
                                );
                            }
                        });
                }
                Err(err) => {
                    tracing::error!(
                        "Failed to spawn hotkey worker `{thread_name}` join thread: {err}"
                    );
                }
            }
        }
    }
}

pub(crate) fn parse_shortcut(shortcut: &str) -> Result<Hotkey> {
    let normalized = normalize_legacy_shortcut_input(shortcut);
    let mut hotkey = normalized
        .parse::<Hotkey>()
        .map_err(|err| anyhow!("Shortcut `{shortcut}` is invalid: {err}"))?;

    // Drops the phantom Fn that older captures baked into function-key shortcuts.
    if hotkey.key.is_some_and(Key::is_function_key) {
        hotkey.modifiers.remove(Modifiers::FN);
    }

    Ok(hotkey)
}

pub(crate) fn validate_recording_shortcut(shortcut: &Hotkey) -> Result<()> {
    if shortcut.key == Some(Key::CapsLock) {
        return Err(anyhow!("CapsLock cannot be used as a recording shortcut"));
    }

    Ok(())
}

fn normalize_legacy_shortcut_input(shortcut: &str) -> String {
    shortcut
        .split('+')
        .map(|token| match token.trim().to_ascii_lowercase().as_str() {
            "commandorcontrol" | "commandorctrl" | "cmdorctrl" | "cmdorcontrol" => {
                if cfg!(target_os = "macos") {
                    "Cmd".to_string()
                } else {
                    "Ctrl".to_string()
                }
            }
            "command" | "cmd" | "meta" | "win" | "windows" => "Cmd".to_string(),
            "control" | "ctrl" => "Ctrl".to_string(),
            "alt" | "option" | "opt" => "Opt".to_string(),
            "shift" => "Shift".to_string(),
            "leftcommand" => "CmdLeft".to_string(),
            "rightcommand" => "CmdRight".to_string(),
            "leftcontrol" => "CtrlLeft".to_string(),
            "rightcontrol" => "CtrlRight".to_string(),
            "leftalt" | "leftoption" => "OptLeft".to_string(),
            "rightalt" | "rightoption" => "OptRight".to_string(),
            "leftshift" => "ShiftLeft".to_string(),
            "rightshift" => "ShiftRight".to_string(),
            // Glimpse historically stored `Delete` for the forward-delete key.
            "delete" => "ForwardDelete".to_string(),
            "arrowleft" => "Left".to_string(),
            "arrowright" => "Right".to_string(),
            "arrowup" => "Up".to_string(),
            "arrowdown" => "Down".to_string(),
            "spacebar" => "Space".to_string(),
            _ => token.trim().to_string(),
        })
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>()
        .join("+")
}

pub(crate) fn shortcuts_conflict(left: &Hotkey, right: &Hotkey) -> bool {
    left == right || is_modifier_only_prefix(left, right) || is_modifier_only_prefix(right, left)
}

const MODIFIER_GROUPS: [(Modifiers, Modifiers); 4] = [
    (Modifiers::CMD_LEFT, Modifiers::CMD_RIGHT),
    (Modifiers::CTRL_LEFT, Modifiers::CTRL_RIGHT),
    (Modifiers::OPT_LEFT, Modifiers::OPT_RIGHT),
    (Modifiers::SHIFT_LEFT, Modifiers::SHIFT_RIGHT),
];

fn is_modifier_only_prefix(prefix: &Hotkey, full: &Hotkey) -> bool {
    prefix.key.is_none()
        && !prefix.modifiers.is_empty()
        && MODIFIER_GROUPS.iter().all(|(left, right)| {
            modifier_group_subset(prefix.modifiers, full.modifiers, *left, *right)
        })
        && (!prefix.modifiers.contains(Modifiers::FN) || full.modifiers.contains(Modifiers::FN))
        && (full.key.is_some() || prefix.modifiers != full.modifiers)
}

fn modifier_group_subset(
    prefix: Modifiers,
    full: Modifiers,
    left: Modifiers,
    right: Modifiers,
) -> bool {
    let prefix_has_left = prefix.contains(left);
    let prefix_has_right = prefix.contains(right);

    if !prefix_has_left && !prefix_has_right {
        return true;
    }

    let full_has_left = full.contains(left);
    let full_has_right = full.contains(right);

    if prefix_has_left && prefix_has_right {
        full_has_left || full_has_right
    } else if prefix_has_left {
        full_has_left
    } else {
        full_has_right
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn function_key_shortcuts_drop_the_phantom_fn() {
        let migrated = parse_shortcut("Ctrl+Fn+Left").unwrap();
        assert_eq!(migrated.modifiers, Modifiers::CTRL);
        assert_eq!(migrated.key, Some(Key::LeftArrow));

        // Fn stays meaningful on keys that do not carry it by themselves.
        let held = parse_shortcut("Fn+A").unwrap();
        assert_eq!(held.modifiers, Modifiers::FN);
    }

    fn event(modifiers: Modifiers, key: Option<Key>, is_key_down: bool) -> KeyEvent {
        KeyEvent {
            modifiers,
            key,
            is_key_down,
            changed_modifier: None,
            repeat: false,
        }
    }

    #[test]
    fn registered_state_releases_when_modifiers_drop() {
        let mut state = RegisteredShortcutState::new(vec![RegisteredHotkey {
            hotkey: Hotkey::new(Modifiers::CTRL, Key::Space).unwrap(),
            action: ShortcutAction::Hold,
            options: ShortcutOptions::default(),
        }]);

        assert_eq!(
            state.process(event(Modifiers::CTRL_LEFT, Some(Key::Space), true)),
            vec![(
                ShortcutAction::Hold,
                HotkeyState::Pressed,
                ShortcutOptions::default()
            )]
        );
        assert_eq!(
            state.process(event(Modifiers::empty(), None, false)),
            vec![(
                ShortcutAction::Hold,
                HotkeyState::Released,
                ShortcutOptions::default()
            )]
        );
    }

    fn modifier_only_press() -> KeyEvent {
        KeyEvent {
            modifiers: Modifiers::OPT_RIGHT,
            key: None,
            is_key_down: true,
            changed_modifier: Some(Modifiers::OPT_RIGHT),
            repeat: false,
        }
    }

    #[test]
    fn registered_state_ignores_duplicate_press_for_hold() {
        let mut state = RegisteredShortcutState::new(vec![RegisteredHotkey {
            hotkey: Hotkey::new(Modifiers::OPT_RIGHT, None).unwrap(),
            action: ShortcutAction::Hold,
            options: ShortcutOptions::default(),
        }]);

        assert_eq!(
            state.process(modifier_only_press()),
            vec![(
                ShortcutAction::Hold,
                HotkeyState::Pressed,
                ShortcutOptions::default()
            )]
        );
        assert!(state.process(modifier_only_press()).is_empty());
    }

    #[test]
    fn registered_state_recovers_modifier_only_toggle() {
        for action in [ShortcutAction::Toggle, ShortcutAction::Smart] {
            let mut state = RegisteredShortcutState::new(vec![RegisteredHotkey {
                hotkey: Hotkey::new(Modifiers::OPT_RIGHT, None).unwrap(),
                action,
                options: ShortcutOptions::default(),
            }]);

            assert_eq!(
                state.process(modifier_only_press()),
                vec![(action, HotkeyState::Pressed, ShortcutOptions::default())]
            );
            assert_eq!(
                state.process(modifier_only_press()),
                vec![(action, HotkeyState::Pressed, ShortcutOptions::default())]
            );
        }
    }
}
