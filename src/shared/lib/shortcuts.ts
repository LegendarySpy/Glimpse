import { detectAppPlatform } from "../../platform/service";

const isMacPlatform = detectAppPlatform() === "macos";

const MODIFIER_ORDER = ["Fn", "Cmd", "Opt", "Ctrl", "Shift"] as const;

function modifierRank(token: string): number {
  const index = MODIFIER_ORDER.findIndex(
    (modifier) => token === modifier || token.startsWith(modifier),
  );
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function isModifierToken(token: string): boolean {
  return modifierRank(token) !== Number.MAX_SAFE_INTEGER;
}

function humanizeModifierToken(token: string): string {
  const modifierDisplay: Record<string, string> = {
    Cmd: isMacPlatform ? "Command" : "Meta",
    Opt: isMacPlatform ? "Option" : "Alt",
    Ctrl: "Ctrl",
    Shift: "Shift",
    Fn: "Fn",
  };

  for (const modifier of MODIFIER_ORDER) {
    if (token === modifier) {
      return modifierDisplay[modifier];
    }
    if (token === `${modifier}Left`) {
      return `Left ${modifierDisplay[modifier]}`;
    }
    if (token === `${modifier}Right`) {
      return `Right ${modifierDisplay[modifier]}`;
    }
  }

  return token;
}

function humanizeKeyToken(token: string): string {
  const directDisplay: Record<string, string> = {
    Left: "Left",
    Right: "Right",
    Up: "Up",
    Down: "Down",
    Escape: "Esc",
    Return: "Enter",
    ForwardDelete: isMacPlatform ? "Forward Delete" : "Delete",
    Delete: isMacPlatform ? "Delete" : "Backspace",
    MouseMiddle: "Middle Click",
    MouseBack: "Mouse Back",
    MouseForward: "Mouse Forward",
  };

  if (directDisplay[token]) {
    return directDisplay[token];
  }

  if (/^[A-Z]$/.test(token) || /^\d$/.test(token) || /^F\d+$/.test(token)) {
    return token;
  }

  if (token.startsWith("Keypad")) {
    return token.replace(/^Keypad/, "Keypad ");
  }

  return token.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function normalizeShortcutToken(token: string): string {
  switch (token.trim().toLowerCase()) {
    case "commandorcontrol":
    case "commandorctrl":
    case "cmdorctrl":
    case "cmdorcontrol":
      return isMacPlatform ? "Cmd" : "Ctrl";
    case "command":
    case "cmd":
    case "meta":
    case "super":
    case "win":
    case "windows":
      return "Cmd";
    case "control":
    case "ctrl":
      return "Ctrl";
    case "alt":
    case "option":
    case "opt":
    case "altgr":
      return "Opt";
    case "shift":
      return "Shift";
    case "leftcommand":
      return "CmdLeft";
    case "rightcommand":
      return "CmdRight";
    case "leftcontrol":
      return "CtrlLeft";
    case "rightcontrol":
      return "CtrlRight";
    case "leftalt":
    case "leftoption":
      return "OptLeft";
    case "rightalt":
    case "rightoption":
      return "OptRight";
    case "leftshift":
      return "ShiftLeft";
    case "rightshift":
      return "ShiftRight";
    case "delete":
      return isMacPlatform ? "Delete" : "ForwardDelete";
    case "arrowleft":
      return "Left";
    case "arrowright":
      return "Right";
    case "arrowup":
      return "Up";
    case "arrowdown":
      return "Down";
    case "spacebar":
    case "space":
      return "Space";
    case "mousemiddle":
    case "middleclick":
    case "mouse3":
    case "mb3":
      return "MouseMiddle";
    case "mouseback":
    case "mouse4":
    case "mb4":
    case "xbutton1":
      return "MouseBack";
    case "mouseforward":
    case "mouse5":
    case "mb5":
    case "xbutton2":
      return "MouseForward";
    default:
      return token.trim();
  }
}

function shortcutTokens(shortcut: string): string[] {
  return shortcut.split("+").map(normalizeShortcutToken).filter(Boolean);
}

export function shortcutDisplayParts(shortcut: string): string[] {
  const tokens = shortcutTokens(shortcut);

  const modifiers = tokens
    .filter(isModifierToken)
    .sort((left, right) => modifierRank(left) - modifierRank(right))
    .map(humanizeModifierToken);

  const keys = tokens
    .filter((token) => !isModifierToken(token))
    .map(humanizeKeyToken);

  return [...modifiers, ...keys];
}

export function formatShortcutForDisplay(shortcut: string): string {
  return shortcutDisplayParts(shortcut).join(" + ");
}
