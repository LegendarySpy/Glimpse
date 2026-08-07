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

fn handle_event(
    event_type: CGEventType,
    event: &CGEvent,
    tx: &Sender<KeyEvent>,
    blocking_hotkeys: &BlockingHotkeys,
    can_block: bool,
    reenable_tap: &AtomicBool,
) -> CallbackResult {
    let key_event = match event_type {
        CGEventType::KeyDown => key_event(event, true),
        CGEventType::KeyUp => key_event(event, false),
        CGEventType::FlagsChanged => flags_changed_event(event),
        CGEventType::OtherMouseDown => mouse_event(event, true),
        CGEventType::OtherMouseUp => mouse_event(event, false),
        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
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

fn key_event(event: &CGEvent, is_key_down: bool) -> Option<KeyEvent> {
    let key_code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as CGKeyCode;
    let key = key_from_keycode(key_code)?;
    let repeat =
        is_key_down && event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT) != 0;

    let mut modifiers = modifiers_from_flags(event.get_flags(), None);
    if key.is_function_key() {
        modifiers.remove(Modifiers::FN);
    }

    Some(KeyEvent {
        modifiers,
        key: Some(key),
        is_key_down,
        changed_modifier: None,
        repeat,
    })
}

fn mouse_event(event: &CGEvent, is_key_down: bool) -> Option<KeyEvent> {
    let button = event.get_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER);
    let key = match button {
        2 => Key::MouseMiddle,
        3 => Key::MouseBack,
        4 => Key::MouseForward,
        _ => return None,
    };

    Some(KeyEvent {
        modifiers: modifiers_from_flags(event.get_flags(), None),
        key: Some(key),
        is_key_down,
        changed_modifier: None,
        repeat: false,
    })
}

fn flags_changed_event(event: &CGEvent) -> Option<KeyEvent> {
    let flags = event.get_flags();
    let key_code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as CGKeyCode;

    if let Some(key) = lock_key_from_keycode(key_code) {
        return Some(KeyEvent {
            modifiers: modifiers_from_flags(flags, None),
            key: Some(key),
            is_key_down: flags.contains(CGEventFlags::CGEventFlagAlphaShift),
            changed_modifier: None,
            repeat: false,
        });
    }

    let changed_modifier = modifier_from_keycode(key_code)?;
    let modifiers = modifiers_from_flags(flags, Some(changed_modifier));

    Some(KeyEvent {
        modifiers,
        key: None,
        is_key_down: modifiers.contains(changed_modifier),
        changed_modifier: Some(changed_modifier),
        repeat: false,
    })
}

// CGEventFlags is the IOKit NX flags word, whose low bits name the physical side of each
// held modifier (IOLLEvent.h). IOHIDFamily stamps them from the HID usage, so every event
// carries the whole chord and nothing has to be remembered between events.
const MODIFIER_GROUPS: [(CGEventFlags, u64, u64, Modifiers, Modifiers); 4] = [
    (
        CGEventFlags::CGEventFlagCommand,
        0x8,
        0x10,
        Modifiers::CMD_LEFT,
        Modifiers::CMD_RIGHT,
    ),
    (
        CGEventFlags::CGEventFlagShift,
        0x2,
        0x4,
        Modifiers::SHIFT_LEFT,
        Modifiers::SHIFT_RIGHT,
    ),
    (
        CGEventFlags::CGEventFlagControl,
        0x1,
        0x2000,
        Modifiers::CTRL_LEFT,
        Modifiers::CTRL_RIGHT,
    ),
    (
        CGEventFlags::CGEventFlagAlternate,
        0x20,
        0x40,
        Modifiers::OPT_LEFT,
        Modifiers::OPT_RIGHT,
    ),
];

fn modifiers_from_flags(flags: CGEventFlags, changed_modifier: Option<Modifiers>) -> Modifiers {
    let raw = flags.bits();
    let mut modifiers = Modifiers::empty();

    for (group_flag, left_bit, right_bit, left, right) in MODIFIER_GROUPS {
        if !flags.contains(group_flag) {
            continue;
        }
        if raw & left_bit != 0 {
            modifiers.insert(left);
        }
        if raw & right_bit != 0 {
            modifiers.insert(right);
        }
        // Posted events carry the group flag alone, so the side has to be inferred: from the
        // keycode on a modifier transition, otherwise left by macOS convention.
        if raw & (left_bit | right_bit) == 0 {
            modifiers.insert(match changed_modifier {
                Some(modifier) if modifier == right => right,
                _ => left,
            });
        }
    }

    if flags.contains(CGEventFlags::CGEventFlagSecondaryFn) {
        modifiers.insert(Modifiers::FN);
    }
    modifiers
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
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    const D_LCMD: u64 = 0x8;
    const D_RCMD: u64 = 0x10;
    const D_RALT: u64 = 0x40;
    const CMD: u64 = 0x0010_0000;
    const ALT: u64 = 0x0008_0000;

    fn flags_changed(key_code: CGKeyCode, raw_flags: u64) -> KeyEvent {
        let source = CGEventSource::new(CGEventSourceStateID::Private).unwrap();
        let event = CGEvent::new_keyboard_event(source, key_code, true).unwrap();
        event.set_flags(CGEventFlags::from_bits_retain(raw_flags));
        flags_changed_event(&event).unwrap()
    }

    #[test]
    fn function_key_is_a_modifier() {
        assert_eq!(modifier_from_keycode(0x3F), Some(Modifiers::FN));
    }

    #[test]
    fn device_bits_name_the_side_that_is_held() {
        let event = flags_changed(0x36, CMD | D_RCMD);

        assert_eq!(event.modifiers, Modifiers::CMD_RIGHT);
        assert_eq!(event.changed_modifier, Some(Modifiers::CMD_RIGHT));
        assert!(event.is_key_down);
    }

    #[test]
    fn releasing_one_side_keeps_the_other_held() {
        let event = flags_changed(0x37, CMD | D_RCMD);

        assert_eq!(event.modifiers, Modifiers::CMD_RIGHT);
        assert_eq!(event.changed_modifier, Some(Modifiers::CMD_LEFT));
        assert!(!event.is_key_down);
    }

    #[test]
    fn a_missed_release_cannot_wedge_later_events() {
        // Right Option goes down and its release is never delivered.
        flags_changed(0x3D, ALT | D_RALT);

        // The next event is still read purely from its own flags.
        let event = flags_changed(0x37, CMD | D_LCMD);

        assert_eq!(event.modifiers, Modifiers::CMD_LEFT);
        assert!(Modifiers::CMD_LEFT.matches(event.modifiers));
    }

    #[test]
    fn posted_events_without_device_bits_assume_left() {
        // Our own synthesized paste sets the group flag and nothing else.
        let source = CGEventSource::new(CGEventSourceStateID::Private).unwrap();
        let event = CGEvent::new_keyboard_event(source, KeyCode::ANSI_V, true).unwrap();
        event.set_flags(CGEventFlags::CGEventFlagCommand);

        let event = key_event(&event, true).unwrap();
        assert_eq!(event.modifiers, Modifiers::CMD_LEFT);
    }

    #[test]
    fn arrow_keys_do_not_report_the_fn_they_always_carry() {
        const FN: u64 = 0x0080_0000;
        const CTRL: u64 = 0x0004_0000;
        const D_LCTRL: u64 = 0x1;

        let source = CGEventSource::new(CGEventSourceStateID::Private).unwrap();
        let event = CGEvent::new_keyboard_event(source, KeyCode::LEFT_ARROW, true).unwrap();
        event.set_flags(CGEventFlags::from_bits_retain(FN | CTRL | D_LCTRL));

        let event = key_event(&event, true).unwrap();
        assert_eq!(event.modifiers, Modifiers::CTRL_LEFT);
    }

    #[test]
    fn posted_modifier_transitions_take_the_side_from_the_keycode() {
        let event = flags_changed(0x36, CMD);

        assert_eq!(event.modifiers, Modifiers::CMD_RIGHT);
        assert!(event.is_key_down);
    }
}
