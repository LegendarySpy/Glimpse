use std::cell::RefCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use anyhow::{Result, anyhow};
use core_foundation::base::TCFType;
use core_foundation::runloop::{
    CFRunLoop, CFRunLoopRunResult, CFRunLoopWakeUp, kCFRunLoopDefaultMode,
};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CGKeyCode, CallbackResult, EventField, KeyCode,
};
use crossbeam_channel::Sender;

use super::{
    BlockingHotkeys, Key, KeyEvent, Modifiers, PlatformShutdown, should_block_event,
    should_forward_event,
};
use crate::permissions;

pub(super) fn start(
    tx: Sender<KeyEvent>,
    blocking_hotkeys: BlockingHotkeys,
) -> Result<PlatformShutdown> {
    if !permissions::check_accessibility_permission() {
        return Err(anyhow!(
            "Accessibility permission is required for global shortcuts"
        ));
    }

    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let has_blocking_hotkeys = !blocking_hotkeys.is_empty();

    let join_handle = thread::Builder::new()
        .name("glimpse-keyboard-macos".to_string())
        .spawn(move || {
            let state = RefCell::new(MacState::default());
            let run_loop = CFRunLoop::get_current();
            let reenable_tap = Arc::new(AtomicBool::new(false));
            let request_reenable = Arc::clone(&reenable_tap);
            let options = if has_blocking_hotkeys {
                CGEventTapOptions::Default
            } else {
                CGEventTapOptions::ListenOnly
            };

            let event_tap = match CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                options,
                vec![
                    CGEventType::KeyDown,
                    CGEventType::KeyUp,
                    CGEventType::FlagsChanged,
                    CGEventType::OtherMouseDown,
                    CGEventType::OtherMouseUp,
                ],
                move |_, event_type, event| {
                    handle_event(
                        event_type,
                        event,
                        &state,
                        &tx,
                        &blocking_hotkeys,
                        has_blocking_hotkeys,
                        &request_reenable,
                    )
                },
            ) {
                Ok(event_tap) => event_tap,
                Err(_) => {
                    let _ = ready_tx.send(Err(
                        "Failed to create macOS event tap for global shortcuts".to_string(),
                    ));
                    return;
                }
            };

            let loop_source = match event_tap.mach_port().create_runloop_source(0) {
                Ok(loop_source) => loop_source,
                Err(_) => {
                    let _ = ready_tx.send(Err(
                        "Failed to create macOS shortcut listener run loop source".to_string(),
                    ));
                    return;
                }
            };

            run_loop.add_source(&loop_source, unsafe { kCFRunLoopDefaultMode });
            event_tap.enable();
            let _ = ready_tx.send(Ok(run_loop.clone()));

            loop {
                let result = CFRunLoop::run_in_mode(
                    unsafe { kCFRunLoopDefaultMode },
                    Duration::from_secs(1),
                    true,
                );
                if matches!(
                    result,
                    CFRunLoopRunResult::Stopped | CFRunLoopRunResult::Finished
                ) {
                    break;
                }
                if reenable_tap.swap(false, Ordering::AcqRel) {
                    event_tap.enable();
                }
            }
        })
        .map_err(|err| anyhow!("Failed to spawn macOS shortcut listener: {err}"))?;

    let run_loop = match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(result) => result.map_err(anyhow::Error::msg)?,
        Err(RecvTimeoutError::Timeout) => {
            return Err(anyhow!("Timed out starting macOS shortcut listener"));
        }
        Err(RecvTimeoutError::Disconnected) => {
            return Err(anyhow!("macOS shortcut listener exited during startup"));
        }
    };

    Ok(PlatformShutdown::new(
        move || {
            run_loop.stop();
            unsafe {
                CFRunLoopWakeUp(run_loop.as_concrete_TypeRef());
            }
        },
        join_handle,
    ))
}

#[derive(Default)]
struct MacState {
    modifiers: Modifiers,
}

fn handle_event(
    event_type: CGEventType,
    event: &CGEvent,
    state: &RefCell<MacState>,
    tx: &Sender<KeyEvent>,
    blocking_hotkeys: &BlockingHotkeys,
    can_block: bool,
    reenable_tap: &AtomicBool,
) -> CallbackResult {
    let key_event = match event_type {
        CGEventType::KeyDown => key_event(event, state, true),
        CGEventType::KeyUp => key_event(event, state, false),
        CGEventType::FlagsChanged => flags_changed_event(event, state),
        CGEventType::OtherMouseDown => mouse_event(event, state, true),
        CGEventType::OtherMouseUp => mouse_event(event, state, false),
        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
            state.borrow_mut().modifiers = Modifiers::empty();
            reenable_tap.store(true, Ordering::Release);
            Some(KeyEvent {
                modifiers: Modifiers::empty(),
                key: None,
                is_key_down: false,
                changed_modifier: None,
                repeat: false,
            })
        }
        _ => None,
    };

    let Some(key_event) = key_event else {
        return CallbackResult::Keep;
    };

    let should_block = can_block && should_block_event(blocking_hotkeys, &key_event);
    if should_forward_event(blocking_hotkeys, &key_event) {
        let _ = tx.try_send(key_event);
    }

    if should_block {
        CallbackResult::Drop
    } else {
        CallbackResult::Keep
    }
}

fn key_event(event: &CGEvent, state: &RefCell<MacState>, is_key_down: bool) -> Option<KeyEvent> {
    let flags = event.get_flags();
    let modifiers = modifiers_for_key_event(state.borrow().modifiers, flags);

    let key_code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as CGKeyCode;
    let key = key_from_keycode(key_code)?;
    let repeat =
        is_key_down && event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT) != 0;

    Some(KeyEvent {
        modifiers,
        key: Some(key),
        is_key_down,
        changed_modifier: None,
        repeat,
    })
}

fn mouse_event(event: &CGEvent, state: &RefCell<MacState>, is_key_down: bool) -> Option<KeyEvent> {
    let button = event.get_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER);
    let key = match button {
        2 => Key::MouseMiddle,
        3 => Key::MouseBack,
        4 => Key::MouseForward,
        _ => return None,
    };

    Some(KeyEvent {
        modifiers: modifiers_for_key_event(state.borrow().modifiers, event.get_flags()),
        key: Some(key),
        is_key_down,
        changed_modifier: None,
        repeat: false,
    })
}

fn flags_changed_event(event: &CGEvent, state: &RefCell<MacState>) -> Option<KeyEvent> {
    let flags = event.get_flags();
    let key_code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as CGKeyCode;

    if let Some(key) = lock_key_from_keycode(key_code) {
        return Some(KeyEvent {
            modifiers: modifiers_with_fn(state.borrow().modifiers, flags),
            key: Some(key),
            is_key_down: flags.contains(CGEventFlags::CGEventFlagAlphaShift),
            changed_modifier: None,
            repeat: false,
        });
    }

    let changed_modifier = modifier_from_keycode(key_code)?;

    let mut state = state.borrow_mut();
    let is_key_down = update_modifier_state(&mut state.modifiers, changed_modifier, flags);

    Some(KeyEvent {
        modifiers: modifiers_with_fn(state.modifiers, flags),
        key: None,
        is_key_down,
        changed_modifier: Some(changed_modifier),
        repeat: false,
    })
}

fn update_modifier_state(
    modifiers: &mut Modifiers,
    changed_modifier: Modifiers,
    flags: CGEventFlags,
) -> bool {
    if changed_modifier == Modifiers::FN {
        return set_modifier_from_flag(
            modifiers,
            changed_modifier,
            flags.contains(CGEventFlags::CGEventFlagSecondaryFn),
        );
    }

    let Some((group_flag, sibling)) = modifier_group(changed_modifier) else {
        return set_modifier_from_flag(modifiers, changed_modifier, false);
    };

    if !flags.contains(group_flag) {
        modifiers.remove(changed_modifier | sibling);
        return false;
    }

    if modifiers.contains(changed_modifier) && modifiers.contains(sibling) {
        modifiers.remove(changed_modifier);
        return false;
    }

    modifiers.insert(changed_modifier);
    true
}

fn set_modifier_from_flag(modifiers: &mut Modifiers, modifier: Modifiers, is_down: bool) -> bool {
    if is_down {
        modifiers.insert(modifier);
    } else {
        modifiers.remove(modifier);
    }
    is_down
}

fn modifier_group(modifier: Modifiers) -> Option<(CGEventFlags, Modifiers)> {
    match modifier {
        Modifiers::CMD_LEFT => Some((CGEventFlags::CGEventFlagCommand, Modifiers::CMD_RIGHT)),
        Modifiers::CMD_RIGHT => Some((CGEventFlags::CGEventFlagCommand, Modifiers::CMD_LEFT)),
        Modifiers::SHIFT_LEFT => Some((CGEventFlags::CGEventFlagShift, Modifiers::SHIFT_RIGHT)),
        Modifiers::SHIFT_RIGHT => Some((CGEventFlags::CGEventFlagShift, Modifiers::SHIFT_LEFT)),
        Modifiers::CTRL_LEFT => Some((CGEventFlags::CGEventFlagControl, Modifiers::CTRL_RIGHT)),
        Modifiers::CTRL_RIGHT => Some((CGEventFlags::CGEventFlagControl, Modifiers::CTRL_LEFT)),
        Modifiers::OPT_LEFT => Some((CGEventFlags::CGEventFlagAlternate, Modifiers::OPT_RIGHT)),
        Modifiers::OPT_RIGHT => Some((CGEventFlags::CGEventFlagAlternate, Modifiers::OPT_LEFT)),
        _ => None,
    }
}

fn modifiers_with_fn(mut modifiers: Modifiers, flags: CGEventFlags) -> Modifiers {
    if flags.contains(CGEventFlags::CGEventFlagSecondaryFn) {
        modifiers.insert(Modifiers::FN);
    } else {
        modifiers.remove(Modifiers::FN);
    }
    modifiers
}

fn modifiers_for_key_event(mut modifiers: Modifiers, flags: CGEventFlags) -> Modifiers {
    reconcile_group(
        &mut modifiers,
        flags.contains(CGEventFlags::CGEventFlagCommand),
        Modifiers::CMD_LEFT,
        Modifiers::CMD_RIGHT,
    );
    reconcile_group(
        &mut modifiers,
        flags.contains(CGEventFlags::CGEventFlagShift),
        Modifiers::SHIFT_LEFT,
        Modifiers::SHIFT_RIGHT,
    );
    reconcile_group(
        &mut modifiers,
        flags.contains(CGEventFlags::CGEventFlagControl),
        Modifiers::CTRL_LEFT,
        Modifiers::CTRL_RIGHT,
    );
    reconcile_group(
        &mut modifiers,
        flags.contains(CGEventFlags::CGEventFlagAlternate),
        Modifiers::OPT_LEFT,
        Modifiers::OPT_RIGHT,
    );
    modifiers_with_fn(modifiers, flags)
}

fn reconcile_group(modifiers: &mut Modifiers, active: bool, left: Modifiers, right: Modifiers) {
    if active {
        if !modifiers.contains(left) && !modifiers.contains(right) {
            modifiers.insert(left);
        }
    } else {
        modifiers.remove(left | right);
    }
}

fn modifier_from_keycode(key_code: CGKeyCode) -> Option<Modifiers> {
    match key_code {
        0x37 => Some(Modifiers::CMD_LEFT),
        0x36 => Some(Modifiers::CMD_RIGHT),
        0x38 => Some(Modifiers::SHIFT_LEFT),
        0x3C => Some(Modifiers::SHIFT_RIGHT),
        0x3B => Some(Modifiers::CTRL_LEFT),
        0x3E => Some(Modifiers::CTRL_RIGHT),
        0x3A => Some(Modifiers::OPT_LEFT),
        0x3D => Some(Modifiers::OPT_RIGHT),
        0x3F => Some(Modifiers::FN),
        _ => None,
    }
}

fn lock_key_from_keycode(key_code: CGKeyCode) -> Option<Key> {
    match key_code {
        0x39 => Some(Key::CapsLock),
        _ => None,
    }
}

fn key_from_keycode(key_code: CGKeyCode) -> Option<Key> {
    match key_code {
        KeyCode::ANSI_A => Some(Key::A),
        KeyCode::ANSI_B => Some(Key::B),
        KeyCode::ANSI_C => Some(Key::C),
        KeyCode::ANSI_D => Some(Key::D),
        KeyCode::ANSI_E => Some(Key::E),
        KeyCode::ANSI_F => Some(Key::F),
        KeyCode::ANSI_G => Some(Key::G),
        KeyCode::ANSI_H => Some(Key::H),
        KeyCode::ANSI_I => Some(Key::I),
        KeyCode::ANSI_J => Some(Key::J),
        KeyCode::ANSI_K => Some(Key::K),
        KeyCode::ANSI_L => Some(Key::L),
        KeyCode::ANSI_M => Some(Key::M),
        KeyCode::ANSI_N => Some(Key::N),
        KeyCode::ANSI_O => Some(Key::O),
        KeyCode::ANSI_P => Some(Key::P),
        KeyCode::ANSI_Q => Some(Key::Q),
        KeyCode::ANSI_R => Some(Key::R),
        KeyCode::ANSI_S => Some(Key::S),
        KeyCode::ANSI_T => Some(Key::T),
        KeyCode::ANSI_U => Some(Key::U),
        KeyCode::ANSI_V => Some(Key::V),
        KeyCode::ANSI_W => Some(Key::W),
        KeyCode::ANSI_X => Some(Key::X),
        KeyCode::ANSI_Y => Some(Key::Y),
        KeyCode::ANSI_Z => Some(Key::Z),
        KeyCode::ANSI_0 => Some(Key::Num0),
        KeyCode::ANSI_1 => Some(Key::Num1),
        KeyCode::ANSI_2 => Some(Key::Num2),
        KeyCode::ANSI_3 => Some(Key::Num3),
        KeyCode::ANSI_4 => Some(Key::Num4),
        KeyCode::ANSI_5 => Some(Key::Num5),
        KeyCode::ANSI_6 => Some(Key::Num6),
        KeyCode::ANSI_7 => Some(Key::Num7),
        KeyCode::ANSI_8 => Some(Key::Num8),
        KeyCode::ANSI_9 => Some(Key::Num9),
        KeyCode::SPACE => Some(Key::Space),
        KeyCode::RETURN => Some(Key::Return),
        KeyCode::TAB => Some(Key::Tab),
        KeyCode::ESCAPE => Some(Key::Escape),
        KeyCode::DELETE => Some(Key::Delete),
        KeyCode::FORWARD_DELETE => Some(Key::ForwardDelete),
        KeyCode::HOME => Some(Key::Home),
        KeyCode::END => Some(Key::End),
        KeyCode::PAGE_UP => Some(Key::PageUp),
        KeyCode::PAGE_DOWN => Some(Key::PageDown),
        KeyCode::LEFT_ARROW => Some(Key::LeftArrow),
        KeyCode::RIGHT_ARROW => Some(Key::RightArrow),
        KeyCode::UP_ARROW => Some(Key::UpArrow),
        KeyCode::DOWN_ARROW => Some(Key::DownArrow),
        KeyCode::ANSI_MINUS => Some(Key::Minus),
        KeyCode::ANSI_EQUAL => Some(Key::Equal),
        KeyCode::ANSI_LEFT_BRACKET => Some(Key::LeftBracket),
        KeyCode::ANSI_RIGHT_BRACKET => Some(Key::RightBracket),
        KeyCode::ANSI_BACKSLASH => Some(Key::Backslash),
        KeyCode::ANSI_SEMICOLON => Some(Key::Semicolon),
        KeyCode::ANSI_QUOTE => Some(Key::Quote),
        KeyCode::ANSI_COMMA => Some(Key::Comma),
        KeyCode::ANSI_PERIOD => Some(Key::Period),
        KeyCode::ANSI_SLASH => Some(Key::Slash),
        KeyCode::ANSI_GRAVE => Some(Key::Grave),
        KeyCode::F1 => Some(Key::F1),
        KeyCode::F2 => Some(Key::F2),
        KeyCode::F3 => Some(Key::F3),
        KeyCode::F4 => Some(Key::F4),
        KeyCode::F5 => Some(Key::F5),
        KeyCode::F6 => Some(Key::F6),
        KeyCode::F7 => Some(Key::F7),
        KeyCode::F8 => Some(Key::F8),
        KeyCode::F9 => Some(Key::F9),
        KeyCode::F10 => Some(Key::F10),
        KeyCode::F11 => Some(Key::F11),
        KeyCode::F12 => Some(Key::F12),
        KeyCode::F13 => Some(Key::F13),
        KeyCode::F14 => Some(Key::F14),
        KeyCode::F15 => Some(Key::F15),
        KeyCode::F16 => Some(Key::F16),
        KeyCode::F17 => Some(Key::F17),
        KeyCode::F18 => Some(Key::F18),
        KeyCode::F19 => Some(Key::F19),
        KeyCode::F20 => Some(Key::F20),
        KeyCode::ANSI_KEYPAD_0 => Some(Key::Keypad0),
        KeyCode::ANSI_KEYPAD_1 => Some(Key::Keypad1),
        KeyCode::ANSI_KEYPAD_2 => Some(Key::Keypad2),
        KeyCode::ANSI_KEYPAD_3 => Some(Key::Keypad3),
        KeyCode::ANSI_KEYPAD_4 => Some(Key::Keypad4),
        KeyCode::ANSI_KEYPAD_5 => Some(Key::Keypad5),
        KeyCode::ANSI_KEYPAD_6 => Some(Key::Keypad6),
        KeyCode::ANSI_KEYPAD_7 => Some(Key::Keypad7),
        KeyCode::ANSI_KEYPAD_8 => Some(Key::Keypad8),
        KeyCode::ANSI_KEYPAD_9 => Some(Key::Keypad9),
        KeyCode::ANSI_KEYPAD_DECIMAL => Some(Key::KeypadDecimal),
        KeyCode::ANSI_KEYPAD_MULTIPLY => Some(Key::KeypadMultiply),
        KeyCode::ANSI_KEYPAD_PLUS => Some(Key::KeypadPlus),
        KeyCode::ANSI_KEYPAD_CLEAR => Some(Key::KeypadClear),
        KeyCode::ANSI_KEYPAD_DIVIDE => Some(Key::KeypadDivide),
        KeyCode::ANSI_KEYPAD_ENTER => Some(Key::KeypadEnter),
        KeyCode::ANSI_KEYPAD_MINUS => Some(Key::KeypadMinus),
        KeyCode::ANSI_KEYPAD_EQUAL => Some(Key::KeypadEquals),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn function_key_is_a_modifier() {
        assert_eq!(modifier_from_keycode(0x3F), Some(Modifiers::FN));
    }

    #[test]
    fn side_modifier_release_uses_inactive_group_flag() {
        let mut modifiers = Modifiers::OPT_RIGHT;
        let is_down =
            update_modifier_state(&mut modifiers, Modifiers::OPT_RIGHT, CGEventFlags::empty());

        assert!(!is_down);
        assert!(!modifiers.contains(Modifiers::OPT_RIGHT));
    }

    #[test]
    fn stale_single_side_modifier_press_stays_down() {
        let mut modifiers = Modifiers::OPT_RIGHT;
        let is_down = update_modifier_state(
            &mut modifiers,
            Modifiers::OPT_RIGHT,
            CGEventFlags::CGEventFlagAlternate,
        );

        assert!(is_down);
        assert!(modifiers.contains(Modifiers::OPT_RIGHT));
    }

    #[test]
    fn side_modifier_release_keeps_sibling_when_group_stays_active() {
        let mut modifiers = Modifiers::OPT_LEFT | Modifiers::OPT_RIGHT;
        let is_down = update_modifier_state(
            &mut modifiers,
            Modifiers::OPT_RIGHT,
            CGEventFlags::CGEventFlagAlternate,
        );

        assert!(!is_down);
        assert!(modifiers.contains(Modifiers::OPT_LEFT));
        assert!(!modifiers.contains(Modifiers::OPT_RIGHT));
    }

    #[test]
    fn key_event_flag_fallback_does_not_stick_without_flags_changed() {
        let stored_modifiers = Modifiers::empty();
        let paste_key_modifiers =
            modifiers_for_key_event(stored_modifiers, CGEventFlags::CGEventFlagCommand);

        assert!(paste_key_modifiers.contains(Modifiers::CMD_LEFT));
        assert!(stored_modifiers.is_empty());
        assert!(modifiers_for_key_event(stored_modifiers, CGEventFlags::empty()).is_empty());
    }
}
