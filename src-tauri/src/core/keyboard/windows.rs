use std::cell::RefCell;
use std::thread;

use anyhow::{Result, anyhow};
use crossbeam_channel::Sender;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
    PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL,
    WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT, WM_SYSKEYDOWN,
    WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP, XBUTTON1, XBUTTON2,
};

use super::{
    BlockingHotkeys, Key, KeyEvent, Modifiers, PlatformShutdown, should_block_event,
    should_forward_event,
};

const LLKHF_EXTENDED_FLAG: u32 = 0x01;

struct HookState {
    tx: Sender<KeyEvent>,
    modifiers: Modifiers,
    blocking_hotkeys: BlockingHotkeys,
}

thread_local! {
    static HOOK_STATE: RefCell<Option<HookState>> = const { RefCell::new(None) };
}

pub(super) fn start(
    tx: Sender<KeyEvent>,
    blocking_hotkeys: BlockingHotkeys,
) -> Result<PlatformShutdown> {
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);

    let join_handle = thread::Builder::new()
        .name("glimpse-keyboard-windows".to_string())
        .spawn(move || {
            HOOK_STATE.with(|state| {
                *state.borrow_mut() = Some(HookState {
                    tx,
                    modifiers: Modifiers::empty(),
                    blocking_hotkeys,
                });
            });

            let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) };
            let hook = match hook {
                Ok(hook) => hook,
                Err(err) => {
                    let _ = ready_tx.send(Err(format!("Failed to install keyboard hook: {err}")));
                    return;
                }
            };

            let mouse_hook =
                match unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0) } {
                    Ok(mouse_hook) => Some(mouse_hook),
                    Err(err) => {
                        tracing::warn!(
                            "Failed to install mouse hook, mouse-button shortcuts disabled: {err}"
                        );
                        None
                    }
                };

            let thread_id = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
            let _ = ready_tx.send(Ok(thread_id));

            let mut message = MSG::default();
            while unsafe { GetMessageW(&mut message, None, 0, 0) }.into() {
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }

            unsafe {
                if let Some(mouse_hook) = mouse_hook {
                    let _ = UnhookWindowsHookEx(mouse_hook);
                }
                let _ = UnhookWindowsHookEx(hook);
            }
            HOOK_STATE.with(|state| {
                *state.borrow_mut() = None;
            });
        })
        .map_err(|err| anyhow!("Failed to spawn Windows shortcut listener: {err}"))?;

    let thread_id = ready_rx
        .recv()
        .map_err(|_| anyhow!("Windows shortcut listener exited during startup"))?
        .map_err(anyhow::Error::msg)?;

    Ok(PlatformShutdown::new(
        move || unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        },
        join_handle,
    ))
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }

    let is_key_down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
    let is_key_up = matches!(wparam.0 as u32, WM_KEYUP | WM_SYSKEYUP);
    if !is_key_down && !is_key_up {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }

    let event = HOOK_STATE.with(|state| {
        let mut state = state.borrow_mut();
        let state = state.as_mut()?;
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        build_event(state, info, is_key_down)
    });

    let Some((event, blocking_hotkeys, tx)) = event else {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    };

    let should_block = should_block_event(&blocking_hotkeys, &event);
    if should_forward_event(&blocking_hotkeys, &event) {
        let _ = tx.try_send(event);
    }

    if should_block {
        LRESULT(1)
    } else {
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }

    let message = wparam.0 as u32;
    let is_key_down = matches!(message, WM_MBUTTONDOWN | WM_XBUTTONDOWN);
    let is_key_up = matches!(message, WM_MBUTTONUP | WM_XBUTTONUP);
    if !is_key_down && !is_key_up {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }

    let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
    let Some(key) = mouse_key(message, info.mouseData) else {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    };

    let event = HOOK_STATE.with(|state| {
        let mut state = state.borrow_mut();
        let state = state.as_mut()?;
        let event = KeyEvent {
            modifiers: state.modifiers,
            key: Some(key),
            is_key_down,
            changed_modifier: None,
            repeat: false,
        };
        Some((event, state.blocking_hotkeys.clone(), state.tx.clone()))
    });

    let Some((event, blocking_hotkeys, tx)) = event else {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    };

    let should_block = should_block_event(&blocking_hotkeys, &event);
    if should_forward_event(&blocking_hotkeys, &event) {
        let _ = tx.try_send(event);
    }

    if should_block {
        LRESULT(1)
    } else {
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }
}

fn mouse_key(message: u32, mouse_data: u32) -> Option<Key> {
    match message {
        WM_MBUTTONDOWN | WM_MBUTTONUP => Some(Key::MouseMiddle),
        WM_XBUTTONDOWN | WM_XBUTTONUP => match (mouse_data >> 16) as u16 {
            XBUTTON1 => Some(Key::MouseBack),
            XBUTTON2 => Some(Key::MouseForward),
            _ => None,
        },
        _ => None,
    }
}

fn build_event(
    state: &mut HookState,
    info: &KBDLLHOOKSTRUCT,
    is_key_down: bool,
) -> Option<(KeyEvent, BlockingHotkeys, Sender<KeyEvent>)> {
    let vk = VIRTUAL_KEY(info.vkCode as u16);
    let is_extended = (info.flags.0 & LLKHF_EXTENDED_FLAG) != 0;

    let event = if let Some(modifier) = modifier_from_vk(vk, info.scanCode, is_extended) {
        if is_key_down {
            state.modifiers.insert(modifier);
        } else {
            state.modifiers.remove(modifier);
        }

        KeyEvent {
            modifiers: state.modifiers,
            key: None,
            is_key_down,
            changed_modifier: Some(modifier),
            repeat: false,
        }
    } else {
        KeyEvent {
            modifiers: state.modifiers,
            key: Some(key_from_vk(vk, is_extended)?),
            is_key_down,
            changed_modifier: None,
            repeat: false,
        }
    };

    Some((event, state.blocking_hotkeys.clone(), state.tx.clone()))
}

fn modifier_from_vk(vk: VIRTUAL_KEY, scan_code: u32, is_extended: bool) -> Option<Modifiers> {
    match vk {
        VK_LWIN => Some(Modifiers::CMD_LEFT),
        VK_RWIN => Some(Modifiers::CMD_RIGHT),
        VK_LSHIFT => Some(Modifiers::SHIFT_LEFT),
        VK_RSHIFT => Some(Modifiers::SHIFT_RIGHT),
        VK_SHIFT => {
            if scan_code == 0x36 {
                Some(Modifiers::SHIFT_RIGHT)
            } else {
                Some(Modifiers::SHIFT_LEFT)
            }
        }
        VK_LCONTROL => Some(Modifiers::CTRL_LEFT),
        VK_RCONTROL => Some(Modifiers::CTRL_RIGHT),
        VK_CONTROL => {
            if is_extended {
                Some(Modifiers::CTRL_RIGHT)
            } else {
                Some(Modifiers::CTRL_LEFT)
            }
        }
        VK_LMENU => Some(Modifiers::OPT_LEFT),
        VK_RMENU => Some(Modifiers::OPT_RIGHT),
        VK_MENU => {
            if is_extended {
                Some(Modifiers::OPT_RIGHT)
            } else {
                Some(Modifiers::OPT_LEFT)
            }
        }
        _ => None,
    }
}

fn key_from_vk(vk: VIRTUAL_KEY, is_extended: bool) -> Option<Key> {
    match vk {
        VK_A => Some(Key::A),
        VK_B => Some(Key::B),
        VK_C => Some(Key::C),
        VK_D => Some(Key::D),
        VK_E => Some(Key::E),
        VK_F => Some(Key::F),
        VK_G => Some(Key::G),
        VK_H => Some(Key::H),
        VK_I => Some(Key::I),
        VK_J => Some(Key::J),
        VK_K => Some(Key::K),
        VK_L => Some(Key::L),
        VK_M => Some(Key::M),
        VK_N => Some(Key::N),
        VK_O => Some(Key::O),
        VK_P => Some(Key::P),
        VK_Q => Some(Key::Q),
        VK_R => Some(Key::R),
        VK_S => Some(Key::S),
        VK_T => Some(Key::T),
        VK_U => Some(Key::U),
        VK_V => Some(Key::V),
        VK_W => Some(Key::W),
        VK_X => Some(Key::X),
        VK_Y => Some(Key::Y),
        VK_Z => Some(Key::Z),
        VK_0 => Some(Key::Num0),
        VK_1 => Some(Key::Num1),
        VK_2 => Some(Key::Num2),
        VK_3 => Some(Key::Num3),
        VK_4 => Some(Key::Num4),
        VK_5 => Some(Key::Num5),
        VK_6 => Some(Key::Num6),
        VK_7 => Some(Key::Num7),
        VK_8 => Some(Key::Num8),
        VK_9 => Some(Key::Num9),
        VK_F1 => Some(Key::F1),
        VK_F2 => Some(Key::F2),
        VK_F3 => Some(Key::F3),
        VK_F4 => Some(Key::F4),
        VK_F5 => Some(Key::F5),
        VK_F6 => Some(Key::F6),
        VK_F7 => Some(Key::F7),
        VK_F8 => Some(Key::F8),
        VK_F9 => Some(Key::F9),
        VK_F10 => Some(Key::F10),
        VK_F11 => Some(Key::F11),
        VK_F12 => Some(Key::F12),
        VK_F13 => Some(Key::F13),
        VK_F14 => Some(Key::F14),
        VK_F15 => Some(Key::F15),
        VK_F16 => Some(Key::F16),
        VK_F17 => Some(Key::F17),
        VK_F18 => Some(Key::F18),
        VK_F19 => Some(Key::F19),
        VK_F20 => Some(Key::F20),
        VK_SPACE => Some(Key::Space),
        VK_RETURN if is_extended => Some(Key::KeypadEnter),
        VK_RETURN => Some(Key::Return),
        VK_TAB => Some(Key::Tab),
        VK_ESCAPE => Some(Key::Escape),
        VK_BACK => Some(Key::Delete),
        VK_DELETE => Some(Key::ForwardDelete),
        VK_INSERT => Some(Key::Insert),
        VK_HOME => Some(Key::Home),
        VK_END => Some(Key::End),
        VK_PRIOR => Some(Key::PageUp),
        VK_NEXT => Some(Key::PageDown),
        VK_LEFT => Some(Key::LeftArrow),
        VK_RIGHT => Some(Key::RightArrow),
        VK_UP => Some(Key::UpArrow),
        VK_DOWN => Some(Key::DownArrow),
        VK_OEM_MINUS => Some(Key::Minus),
        VK_OEM_PLUS => Some(Key::Equal),
        VK_OEM_4 => Some(Key::LeftBracket),
        VK_OEM_6 => Some(Key::RightBracket),
        VK_OEM_5 => Some(Key::Backslash),
        VK_OEM_1 => Some(Key::Semicolon),
        VK_OEM_7 => Some(Key::Quote),
        VK_OEM_COMMA => Some(Key::Comma),
        VK_OEM_PERIOD => Some(Key::Period),
        VK_OEM_2 => Some(Key::Slash),
        VK_OEM_3 => Some(Key::Grave),
        VK_NUMPAD0 => Some(Key::Keypad0),
        VK_NUMPAD1 => Some(Key::Keypad1),
        VK_NUMPAD2 => Some(Key::Keypad2),
        VK_NUMPAD3 => Some(Key::Keypad3),
        VK_NUMPAD4 => Some(Key::Keypad4),
        VK_NUMPAD5 => Some(Key::Keypad5),
        VK_NUMPAD6 => Some(Key::Keypad6),
        VK_NUMPAD7 => Some(Key::Keypad7),
        VK_NUMPAD8 => Some(Key::Keypad8),
        VK_NUMPAD9 => Some(Key::Keypad9),
        VK_DECIMAL => Some(Key::KeypadDecimal),
        VK_MULTIPLY => Some(Key::KeypadMultiply),
        VK_ADD => Some(Key::KeypadPlus),
        VK_CLEAR => Some(Key::KeypadClear),
        VK_DIVIDE => Some(Key::KeypadDivide),
        VK_SUBTRACT => Some(Key::KeypadMinus),
        VK_CAPITAL => Some(Key::CapsLock),
        _ => None,
    }
}
