use std::fmt;
use std::ops::{BitAnd, BitAndAssign, BitOr, BitOrAssign, Not};
use std::str::FromStr;
use std::sync::Arc;
use std::thread::JoinHandle;

use anyhow::{Result, anyhow};
use crossbeam_channel::{Receiver, unbounded};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

pub(crate) type BlockingHotkeys = Arc<[Hotkey]>;

pub(crate) struct KeyboardListener {
    events: Receiver<KeyEvent>,
    shutdown: Option<PlatformShutdown>,
}

impl KeyboardListener {
    pub(crate) fn new(blocking_hotkeys: BlockingHotkeys) -> Result<Self> {
        let (tx, rx) = unbounded();
        let shutdown = platform_start(tx, blocking_hotkeys)?;
        Ok(Self {
            events: rx,
            shutdown: Some(shutdown),
        })
    }

    pub(crate) fn events(&self) -> &Receiver<KeyEvent> {
        &self.events
    }
}

impl Drop for KeyboardListener {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            shutdown.stop();
        }
    }
}

#[cfg(target_os = "macos")]
fn platform_start(
    tx: crossbeam_channel::Sender<KeyEvent>,
    blocking_hotkeys: BlockingHotkeys,
) -> Result<PlatformShutdown> {
    macos::start(tx, blocking_hotkeys)
}

#[cfg(target_os = "windows")]
fn platform_start(
    tx: crossbeam_channel::Sender<KeyEvent>,
    blocking_hotkeys: BlockingHotkeys,
) -> Result<PlatformShutdown> {
    windows::start(tx, blocking_hotkeys)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_start(
    _tx: crossbeam_channel::Sender<KeyEvent>,
    _blocking_hotkeys: BlockingHotkeys,
) -> Result<PlatformShutdown> {
    Err(anyhow!(
        "Global shortcuts are supported on macOS and Windows only"
    ))
}

pub(crate) struct PlatformShutdown {
    stop: Box<dyn FnOnce() + Send + 'static>,
    join_handle: Option<JoinHandle<()>>,
}

impl PlatformShutdown {
    pub(crate) fn new(stop: impl FnOnce() + Send + 'static, join_handle: JoinHandle<()>) -> Self {
        Self {
            stop: Box::new(stop),
            join_handle: Some(join_handle),
        }
    }

    fn stop(mut self) {
        (self.stop)();
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct Modifiers(u16);

impl Modifiers {
    pub(crate) const CMD_LEFT: Self = Self(1 << 0);
    pub(crate) const SHIFT_LEFT: Self = Self(1 << 1);
    pub(crate) const CTRL_LEFT: Self = Self(1 << 2);
    pub(crate) const OPT_LEFT: Self = Self(1 << 3);
    pub(crate) const FN: Self = Self(1 << 4);
    pub(crate) const CMD_RIGHT: Self = Self(1 << 5);
    pub(crate) const SHIFT_RIGHT: Self = Self(1 << 6);
    pub(crate) const CTRL_RIGHT: Self = Self(1 << 7);
    pub(crate) const OPT_RIGHT: Self = Self(1 << 8);

    pub(crate) const CMD: Self = Self(Self::CMD_LEFT.0 | Self::CMD_RIGHT.0);
    pub(crate) const SHIFT: Self = Self(Self::SHIFT_LEFT.0 | Self::SHIFT_RIGHT.0);
    pub(crate) const CTRL: Self = Self(Self::CTRL_LEFT.0 | Self::CTRL_RIGHT.0);
    pub(crate) const OPT: Self = Self(Self::OPT_LEFT.0 | Self::OPT_RIGHT.0);

    pub(crate) const fn empty() -> Self {
        Self(0)
    }

    pub(crate) fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub(crate) fn count(self) -> u32 {
        self.0.count_ones()
    }

    pub(crate) fn contains(self, other: Self) -> bool {
        (self.0 & other.0) == other.0
    }

    pub(crate) fn insert(&mut self, other: Self) {
        self.0 |= other.0;
    }

    pub(crate) fn remove(&mut self, other: Self) {
        self.0 &= !other.0;
    }

    pub(crate) fn matches(self, event: Self) -> bool {
        for (left, right) in [
            (Self::CMD_LEFT, Self::CMD_RIGHT),
            (Self::SHIFT_LEFT, Self::SHIFT_RIGHT),
            (Self::CTRL_LEFT, Self::CTRL_RIGHT),
            (Self::OPT_LEFT, Self::OPT_RIGHT),
        ] {
            let wants_left = self.contains(left);
            let wants_right = self.contains(right);
            let event_left = event.contains(left);
            let event_right = event.contains(right);
            let event_any = event_left || event_right;

            if wants_left && wants_right {
                if !event_any {
                    return false;
                }
            } else if wants_left {
                if !event_left {
                    return false;
                }
            } else if wants_right {
                if !event_right {
                    return false;
                }
            } else if event_any {
                return false;
            }
        }

        self.contains(Self::FN) == event.contains(Self::FN)
    }

    fn parse_single(token: &str) -> Option<Self> {
        match token.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "meta" | "super" | "win" | "windows" => Some(Self::CMD),
            "shift" => Some(Self::SHIFT),
            "ctrl" | "control" => Some(Self::CTRL),
            "opt" | "option" | "alt" => Some(Self::OPT),
            "fn" | "function" => Some(Self::FN),
            "cmdleft" | "cmd_left" | "leftcommand" | "lcmd" | "commandleft" | "command_left"
            | "superleft" | "winleft" | "windowsleft" | "metaleft" => Some(Self::CMD_LEFT),
            "cmdright" | "cmd_right" | "rightcommand" | "rcmd" | "commandright"
            | "command_right" | "superright" | "winright" | "windowsright" | "metaright" => {
                Some(Self::CMD_RIGHT)
            }
            "shiftleft" | "shift_left" | "leftshift" | "lshift" => Some(Self::SHIFT_LEFT),
            "shiftright" | "shift_right" | "rightshift" | "rshift" => Some(Self::SHIFT_RIGHT),
            "ctrlleft" | "ctrl_left" | "leftcontrol" | "lctrl" | "controlleft" | "control_left" => {
                Some(Self::CTRL_LEFT)
            }
            "ctrlright" | "ctrl_right" | "rightcontrol" | "rctrl" | "controlright"
            | "control_right" => Some(Self::CTRL_RIGHT),
            "optleft" | "opt_left" | "leftalt" | "leftoption" | "lopt" | "lalt" | "optionleft"
            | "altleft" => Some(Self::OPT_LEFT),
            "optright" | "opt_right" | "rightalt" | "rightoption" | "ropt" | "ralt"
            | "optionright" | "altright" | "altgr" => Some(Self::OPT_RIGHT),
            _ => None,
        }
    }
}

impl Default for Modifiers {
    fn default() -> Self {
        Self::empty()
    }
}

impl BitOr for Modifiers {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for Modifiers {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

impl BitAnd for Modifiers {
    type Output = Self;

    fn bitand(self, rhs: Self) -> Self::Output {
        Self(self.0 & rhs.0)
    }
}

impl BitAndAssign for Modifiers {
    fn bitand_assign(&mut self, rhs: Self) {
        self.0 &= rhs.0;
    }
}

impl Not for Modifiers {
    type Output = Self;

    fn not(self) -> Self::Output {
        Self(!self.0)
    }
}

impl fmt::Display for Modifiers {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut parts = Vec::new();

        push_modifier_name(
            &mut parts,
            *self,
            Self::CTRL_LEFT,
            Self::CTRL_RIGHT,
            "Ctrl",
            "CtrlLeft",
            "CtrlRight",
        );
        push_modifier_name(
            &mut parts,
            *self,
            Self::OPT_LEFT,
            Self::OPT_RIGHT,
            "Opt",
            "OptLeft",
            "OptRight",
        );
        push_modifier_name(
            &mut parts,
            *self,
            Self::SHIFT_LEFT,
            Self::SHIFT_RIGHT,
            "Shift",
            "ShiftLeft",
            "ShiftRight",
        );
        push_modifier_name(
            &mut parts,
            *self,
            Self::CMD_LEFT,
            Self::CMD_RIGHT,
            "Cmd",
            "CmdLeft",
            "CmdRight",
        );
        if self.contains(Self::FN) {
            parts.push("Fn");
        }

        write!(f, "{}", parts.join("+"))
    }
}

fn push_modifier_name<'a>(
    parts: &mut Vec<&'a str>,
    modifiers: Modifiers,
    left: Modifiers,
    right: Modifiers,
    name: &'a str,
    left_name: &'a str,
    right_name: &'a str,
) {
    if modifiers.contains(left) && modifiers.contains(right) {
        parts.push(name);
    } else if modifiers.contains(left) {
        parts.push(left_name);
    } else if modifiers.contains(right) {
        parts.push(right_name);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Key {
    A,
    B,
    C,
    D,
    E,
    F,
    G,
    H,
    I,
    J,
    K,
    L,
    M,
    N,
    O,
    P,
    Q,
    R,
    S,
    T,
    U,
    V,
    W,
    X,
    Y,
    Z,
    Num0,
    Num1,
    Num2,
    Num3,
    Num4,
    Num5,
    Num6,
    Num7,
    Num8,
    Num9,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
    F13,
    F14,
    F15,
    F16,
    F17,
    F18,
    F19,
    F20,
    Space,
    Return,
    Tab,
    Escape,
    Delete,
    ForwardDelete,
    Insert,
    Home,
    End,
    PageUp,
    PageDown,
    LeftArrow,
    RightArrow,
    UpArrow,
    DownArrow,
    Minus,
    Equal,
    LeftBracket,
    RightBracket,
    Backslash,
    Semicolon,
    Quote,
    Comma,
    Period,
    Slash,
    Grave,
    Keypad0,
    Keypad1,
    Keypad2,
    Keypad3,
    Keypad4,
    Keypad5,
    Keypad6,
    Keypad7,
    Keypad8,
    Keypad9,
    KeypadDecimal,
    KeypadMultiply,
    KeypadPlus,
    KeypadClear,
    KeypadDivide,
    KeypadEnter,
    KeypadMinus,
    KeypadEquals,
    CapsLock,
    MouseMiddle,
    MouseBack,
    MouseForward,
}

impl Key {
    // macOS reports these as function keys whether or not Fn is held, so on them the flag
    // says nothing about the physical key and cannot be part of a chord.
    pub(crate) fn is_function_key(self) -> bool {
        matches!(
            self,
            Key::LeftArrow
                | Key::RightArrow
                | Key::UpArrow
                | Key::DownArrow
                | Key::Home
                | Key::End
                | Key::PageUp
                | Key::PageDown
                | Key::ForwardDelete
                | Key::F1
                | Key::F2
                | Key::F3
                | Key::F4
                | Key::F5
                | Key::F6
                | Key::F7
                | Key::F8
                | Key::F9
                | Key::F10
                | Key::F11
                | Key::F12
                | Key::F13
                | Key::F14
                | Key::F15
                | Key::F16
                | Key::F17
                | Key::F18
                | Key::F19
                | Key::F20
        )
    }
}

impl fmt::Display for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Key::A => "A",
            Key::B => "B",
            Key::C => "C",
            Key::D => "D",
            Key::E => "E",
            Key::F => "F",
            Key::G => "G",
            Key::H => "H",
            Key::I => "I",
            Key::J => "J",
            Key::K => "K",
            Key::L => "L",
            Key::M => "M",
            Key::N => "N",
            Key::O => "O",
            Key::P => "P",
            Key::Q => "Q",
            Key::R => "R",
            Key::S => "S",
            Key::T => "T",
            Key::U => "U",
            Key::V => "V",
            Key::W => "W",
            Key::X => "X",
            Key::Y => "Y",
            Key::Z => "Z",
            Key::Num0 => "0",
            Key::Num1 => "1",
            Key::Num2 => "2",
            Key::Num3 => "3",
            Key::Num4 => "4",
            Key::Num5 => "5",
            Key::Num6 => "6",
            Key::Num7 => "7",
            Key::Num8 => "8",
            Key::Num9 => "9",
            Key::F1 => "F1",
            Key::F2 => "F2",
            Key::F3 => "F3",
            Key::F4 => "F4",
            Key::F5 => "F5",
            Key::F6 => "F6",
            Key::F7 => "F7",
            Key::F8 => "F8",
            Key::F9 => "F9",
            Key::F10 => "F10",
            Key::F11 => "F11",
            Key::F12 => "F12",
            Key::F13 => "F13",
            Key::F14 => "F14",
            Key::F15 => "F15",
            Key::F16 => "F16",
            Key::F17 => "F17",
            Key::F18 => "F18",
            Key::F19 => "F19",
            Key::F20 => "F20",
            Key::Space => "Space",
            Key::Return => "Return",
            Key::Tab => "Tab",
            Key::Escape => "Escape",
            Key::Delete => "Delete",
            Key::ForwardDelete => "ForwardDelete",
            Key::Insert => "Insert",
            Key::Home => "Home",
            Key::End => "End",
            Key::PageUp => "PageUp",
            Key::PageDown => "PageDown",
            Key::LeftArrow => "Left",
            Key::RightArrow => "Right",
            Key::UpArrow => "Up",
            Key::DownArrow => "Down",
            Key::Minus => "Minus",
            Key::Equal => "Equal",
            Key::LeftBracket => "LeftBracket",
            Key::RightBracket => "RightBracket",
            Key::Backslash => "Backslash",
            Key::Semicolon => "Semicolon",
            Key::Quote => "Quote",
            Key::Comma => "Comma",
            Key::Period => "Period",
            Key::Slash => "Slash",
            Key::Grave => "Grave",
            Key::Keypad0 => "Keypad0",
            Key::Keypad1 => "Keypad1",
            Key::Keypad2 => "Keypad2",
            Key::Keypad3 => "Keypad3",
            Key::Keypad4 => "Keypad4",
            Key::Keypad5 => "Keypad5",
            Key::Keypad6 => "Keypad6",
            Key::Keypad7 => "Keypad7",
            Key::Keypad8 => "Keypad8",
            Key::Keypad9 => "Keypad9",
            Key::KeypadDecimal => "KeypadDecimal",
            Key::KeypadMultiply => "KeypadMultiply",
            Key::KeypadPlus => "KeypadPlus",
            Key::KeypadClear => "KeypadClear",
            Key::KeypadDivide => "KeypadDivide",
            Key::KeypadEnter => "KeypadEnter",
            Key::KeypadMinus => "KeypadMinus",
            Key::KeypadEquals => "KeypadEquals",
            Key::CapsLock => "CapsLock",
            Key::MouseMiddle => "MouseMiddle",
            Key::MouseBack => "MouseBack",
            Key::MouseForward => "MouseForward",
        };
        write!(f, "{name}")
    }
}

impl FromStr for Key {
    type Err = anyhow::Error;

    fn from_str(token: &str) -> Result<Self> {
        let normalized = token.trim().to_ascii_lowercase();
        let key = match normalized.as_str() {
            "a" => Key::A,
            "b" => Key::B,
            "c" => Key::C,
            "d" => Key::D,
            "e" => Key::E,
            "f" => Key::F,
            "g" => Key::G,
            "h" => Key::H,
            "i" => Key::I,
            "j" => Key::J,
            "k" => Key::K,
            "l" => Key::L,
            "m" => Key::M,
            "n" => Key::N,
            "o" => Key::O,
            "p" => Key::P,
            "q" => Key::Q,
            "r" => Key::R,
            "s" => Key::S,
            "t" => Key::T,
            "u" => Key::U,
            "v" => Key::V,
            "w" => Key::W,
            "x" => Key::X,
            "y" => Key::Y,
            "z" => Key::Z,
            "0" | "num0" => Key::Num0,
            "1" | "num1" => Key::Num1,
            "2" | "num2" => Key::Num2,
            "3" | "num3" => Key::Num3,
            "4" | "num4" => Key::Num4,
            "5" | "num5" => Key::Num5,
            "6" | "num6" => Key::Num6,
            "7" | "num7" => Key::Num7,
            "8" | "num8" => Key::Num8,
            "9" | "num9" => Key::Num9,
            "f1" => Key::F1,
            "f2" => Key::F2,
            "f3" => Key::F3,
            "f4" => Key::F4,
            "f5" => Key::F5,
            "f6" => Key::F6,
            "f7" => Key::F7,
            "f8" => Key::F8,
            "f9" => Key::F9,
            "f10" => Key::F10,
            "f11" => Key::F11,
            "f12" => Key::F12,
            "f13" => Key::F13,
            "f14" => Key::F14,
            "f15" => Key::F15,
            "f16" => Key::F16,
            "f17" => Key::F17,
            "f18" => Key::F18,
            "f19" => Key::F19,
            "f20" => Key::F20,
            "space" | "spacebar" | " " => Key::Space,
            "return" | "enter" => Key::Return,
            "tab" => Key::Tab,
            "escape" | "esc" => Key::Escape,
            "delete" | "backspace" => Key::Delete,
            "forwarddelete" | "del" => Key::ForwardDelete,
            "insert" | "ins" => Key::Insert,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" => Key::PageUp,
            "pagedown" => Key::PageDown,
            "left" | "leftarrow" | "arrowleft" => Key::LeftArrow,
            "right" | "rightarrow" | "arrowright" => Key::RightArrow,
            "up" | "uparrow" | "arrowup" => Key::UpArrow,
            "down" | "downarrow" | "arrowdown" => Key::DownArrow,
            "-" | "minus" => Key::Minus,
            "=" | "equal" | "equals" => Key::Equal,
            "[" | "leftbracket" => Key::LeftBracket,
            "]" | "rightbracket" => Key::RightBracket,
            "\\" | "backslash" => Key::Backslash,
            ";" | "semicolon" => Key::Semicolon,
            "'" | "quote" => Key::Quote,
            "," | "comma" => Key::Comma,
            "." | "period" => Key::Period,
            "/" | "slash" => Key::Slash,
            "`" | "grave" | "backtick" => Key::Grave,
            "keypad0" => Key::Keypad0,
            "keypad1" => Key::Keypad1,
            "keypad2" => Key::Keypad2,
            "keypad3" => Key::Keypad3,
            "keypad4" => Key::Keypad4,
            "keypad5" => Key::Keypad5,
            "keypad6" => Key::Keypad6,
            "keypad7" => Key::Keypad7,
            "keypad8" => Key::Keypad8,
            "keypad9" => Key::Keypad9,
            "keypad." | "keypaddecimal" => Key::KeypadDecimal,
            "keypad*" | "keypadmultiply" => Key::KeypadMultiply,
            "keypad+" | "keypadplus" => Key::KeypadPlus,
            "keypadclear" => Key::KeypadClear,
            "keypad/" | "keypaddivide" => Key::KeypadDivide,
            "keypadenter" => Key::KeypadEnter,
            "keypad-" | "keypadminus" => Key::KeypadMinus,
            "keypad=" | "keypadequals" => Key::KeypadEquals,
            "capslock" | "caps" => Key::CapsLock,
            "mousemiddle" | "middleclick" | "mouse3" | "mb3" => Key::MouseMiddle,
            "mouseback" | "mouse4" | "mb4" | "xbutton1" => Key::MouseBack,
            "mouseforward" | "mouse5" | "mb5" | "xbutton2" => Key::MouseForward,
            _ => return Err(anyhow!("Unknown key `{token}`")),
        };

        Ok(key)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct Hotkey {
    pub(crate) modifiers: Modifiers,
    pub(crate) key: Option<Key>,
}

impl Hotkey {
    pub(crate) fn new(modifiers: Modifiers, key: impl Into<Option<Key>>) -> Result<Self> {
        let key = key.into();
        if modifiers.is_empty() && key.is_none() {
            return Err(anyhow!("Shortcut cannot be empty"));
        }
        Ok(Self { modifiers, key })
    }

    pub(crate) fn matches_event(self, event: &KeyEvent) -> bool {
        self.modifiers.matches(event.modifiers) && self.key == event.key
    }
}

impl fmt::Display for Hotkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.modifiers.is_empty(), self.key) {
            (true, Some(key)) => write!(f, "{key}"),
            (false, Some(key)) => write!(f, "{}+{}", self.modifiers, key),
            (false, None) => write!(f, "{}", self.modifiers),
            (true, None) => write!(f, "(none)"),
        }
    }
}

impl FromStr for Hotkey {
    type Err = anyhow::Error;

    fn from_str(shortcut: &str) -> Result<Self> {
        let mut modifiers = Modifiers::empty();
        let mut key = None;

        for token in shortcut
            .split('+')
            .map(str::trim)
            .filter(|token| !token.is_empty())
        {
            if let Some(modifier) = Modifiers::parse_single(token) {
                modifiers |= modifier;
                continue;
            }

            if key.is_some() {
                return Err(anyhow!("Shortcut `{shortcut}` contains more than one key"));
            }
            key = Some(token.parse::<Key>()?);
        }

        Hotkey::new(modifiers, key)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct KeyEvent {
    pub(crate) modifiers: Modifiers,
    pub(crate) key: Option<Key>,
    pub(crate) is_key_down: bool,
    pub(crate) changed_modifier: Option<Modifiers>,
    pub(crate) repeat: bool,
}

impl KeyEvent {
    pub(crate) fn releases_everything(self) -> bool {
        !self.is_key_down
            && self.key.is_none()
            && self.changed_modifier.is_none()
            && self.modifiers.is_empty()
    }
}

pub(crate) fn blocking_hotkeys(hotkeys: Vec<Hotkey>) -> BlockingHotkeys {
    Arc::from(hotkeys.into_boxed_slice())
}

pub(crate) fn empty_blocking_hotkeys() -> BlockingHotkeys {
    blocking_hotkeys(Vec::new())
}

pub(crate) fn should_block_event(blocking_hotkeys: &BlockingHotkeys, event: &KeyEvent) -> bool {
    if let Some(changed_modifier) = event.changed_modifier {
        return blocking_hotkeys
            .iter()
            .any(|hotkey| hotkey.key.is_none() && hotkey.modifiers.contains(changed_modifier));
    }

    event.key.is_some_and(|_| {
        blocking_hotkeys
            .iter()
            .any(|hotkey| hotkey.matches_event(event))
    })
}

pub(crate) fn should_forward_event(blocking_hotkeys: &BlockingHotkeys, event: &KeyEvent) -> bool {
    if blocking_hotkeys.is_empty()
        || event.releases_everything()
        || event.changed_modifier.is_some()
    {
        return true;
    }

    event.key.is_some_and(|key| {
        blocking_hotkeys
            .iter()
            .any(|hotkey| hotkey.key == Some(key))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifier_only_hotkeys_parse_and_match() {
        let hotkey: Hotkey = "Ctrl+Shift".parse().unwrap();
        assert_eq!(hotkey.to_string(), "Ctrl+Shift");
        assert!(
            hotkey
                .modifiers
                .matches(Modifiers::CTRL_LEFT | Modifiers::SHIFT_RIGHT)
        );
    }

    #[test]
    fn side_specific_modifier_does_not_match_other_side() {
        let hotkey: Hotkey = "CtrlRight+Space".parse().unwrap();
        assert!(hotkey.modifiers.matches(Modifiers::CTRL_RIGHT));
        assert!(!hotkey.modifiers.matches(Modifiers::CTRL_LEFT));
    }

    #[test]
    fn duplicate_keys_are_rejected() {
        assert!("Ctrl+A+B".parse::<Hotkey>().is_err());
    }

    #[test]
    fn modifier_only_hotkeys_block_modifier_events() {
        let hotkeys = blocking_hotkeys(vec![Hotkey::new(Modifiers::OPT_RIGHT, None).unwrap()]);

        assert!(should_block_event(
            &hotkeys,
            &KeyEvent {
                modifiers: Modifiers::OPT_RIGHT,
                key: None,
                is_key_down: true,
                changed_modifier: Some(Modifiers::OPT_RIGHT),
                repeat: false,
            }
        ));
        assert!(should_block_event(
            &hotkeys,
            &KeyEvent {
                modifiers: Modifiers::empty(),
                key: None,
                is_key_down: false,
                changed_modifier: Some(Modifiers::OPT_RIGHT),
                repeat: false,
            }
        ));
    }
}
