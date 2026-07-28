import { msg } from "@lingui/core/macro";

// Tray and macOS menu bar labels, built in Rust. Nothing imports this: it
// exists so lingui extract writes these keys into messages.po, which
// src-tauri/build.rs compiles into a Rust table. The `native.` prefix is
// the contract build.rs selects on.
export const NATIVE_MENU_STRINGS = [
  // shared between the tray and the macOS menu bar
  msg({ id: "native.menu.check_updates", message: "Check for Updates" }),
  msg({
    id: "native.menu.check_updates_long",
    message: "Check for Updates...",
  }),
  msg({ id: "native.menu.microphone", message: "Microphone" }),
  msg({ id: "native.menu.mic_system_default", message: "System Default" }),
  msg({ id: "native.menu.mic_none", message: "No input devices found" }),
  msg({ id: "native.menu.mic_default_suffix", message: "{name} (Default)" }),
  msg({
    id: "native.menu.mic_unavailable",
    message: "Microphone unavailable ({error})",
  }),
  msg({ id: "native.menu.models", message: "Models" }),
  msg({ id: "native.menu.model_fallback", message: "Fallback: {model}" }),
  msg({ id: "native.menu.recent", message: "Last Transcriptions" }),
  msg({ id: "native.menu.recent_empty", message: "No transcriptions yet" }),
  msg({ id: "native.menu.recent_empty_item", message: "Empty transcription" }),
  msg({
    id: "native.menu.recent_error",
    message: "Unable to load transcriptions",
  }),
  msg({ id: "native.menu.send_feedback", message: "Send Feedback" }),

  // tray only
  msg({ id: "native.tray.open", message: "Open {app}" }),
  msg({ id: "native.tray.quit", message: "Quit {app}" }),

  // macOS menu bar only
  msg({ id: "native.menu.services", message: "Services" }),
  msg({ id: "native.menu.hide", message: "Hide {app}" }),
  msg({ id: "native.menu.hide_others", message: "Hide Others" }),
  msg({ id: "native.menu.show_all", message: "Show All" }),
  msg({ id: "native.menu.quit", message: "Quit {app}" }),
  msg({ id: "native.menu.view", message: "View" }),
  msg({ id: "native.menu.close_window", message: "Close Window" }),
  msg({ id: "native.menu.fullscreen", message: "Toggle Full Screen" }),
  msg({ id: "native.menu.minimize", message: "Minimize" }),
  msg({ id: "native.menu.zoom", message: "Zoom" }),
  msg({ id: "native.menu.edit", message: "Edit" }),
  msg({ id: "native.menu.undo", message: "Undo" }),
  msg({ id: "native.menu.redo", message: "Redo" }),
  msg({ id: "native.menu.cut", message: "Cut" }),
  msg({ id: "native.menu.copy", message: "Copy" }),
  msg({ id: "native.menu.paste", message: "Paste" }),
  msg({ id: "native.menu.select_all", message: "Select All" }),
  msg({ id: "native.menu.help", message: "Help" }),
  msg({ id: "native.menu.github", message: "Github" }),

  msg({
    id: "native.toast.too_quiet",
    message: "That was too quiet to hear. Recording deleted.",
  }),
  msg({
    id: "native.toast.no_speech",
    message: "No speech detected. Recording deleted.",
  }),
  msg({
    id: "native.toast.no_words",
    message: "No words detected. Recording deleted.",
  }),
  msg({ id: "native.toast.cancelled", message: "Transcription cancelled" }),
  msg({ id: "native.toast.copied", message: "Copied to clipboard" }),

  msg({
    id: "native.toast.recovering",
    message: "Recovering your last recording...",
  }),
  msg({ id: "native.toast.recovered_one", message: "Recording recovered" }),
  msg({ id: "native.toast.recovered_many", message: "Recordings recovered" }),
  msg({
    id: "native.toast.recovered_saved_one",
    message: "Recording saved to History.",
  }),
  msg({
    id: "native.toast.recovered_saved_many",
    message: "Recordings saved to History.",
  }),
  msg({ id: "native.toast.view_history", message: "View History" }),
];
