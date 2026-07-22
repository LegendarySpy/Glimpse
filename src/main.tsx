import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./app/App";
import { AppProviders } from "./app/providers";
import { detectAppPlatform } from "./platform/service";
import {
  parseTextSizeMode,
  resolveTextScale,
  TEXT_SIZE_MODE_STORAGE_KEY,
} from "./shared/lib/textSize";

type CrashSource = "render" | "window_error" | "unhandled_rejection";

const MAX_REASON_CHARS = 256;
const reportedCrashes = new Set<string>();

const errorKind = (error: unknown): string => {
  if (!(error instanceof Error)) return "unknown";
  return [
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
  ].includes(error.name)
    ? error.name
    : "unknown";
};

const describeReason = (reason: unknown): string => {
  if (typeof reason === "string") return reason.slice(0, MAX_REASON_CHARS);
  if (reason !== null && typeof reason === "object") {
    const name = reason.constructor?.name ?? "Object";
    const keys = Object.keys(reason).sort().slice(0, 5).join(",");
    return keys ? `${name}:{${keys}}` : name;
  }
  return String(reason).slice(0, MAX_REASON_CHARS);
};

// Bounded categories only; the message itself never leaves the device.
// Must stay in sync with the allowlist in report_frontend_crash.
const REASON_RULES: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "undefined_access",
    [
      "undefined is not",
      "null is not",
      "cannot read",
      "is not a function",
      "is not an object",
    ],
  ],
  ["timeout", ["timeout", "timed out"]],
  ["cancelled", ["cancel", "abort"]],
  ["permission", ["permission", "not allowed", "access denied"]],
  ["network", ["network", "fetch", "connect", "load failed"]],
  ["not_found", ["not found", "no such file"]],
];

const reasonCode = (reason: unknown): string => {
  // Error.message can be a non-string at runtime; never call methods on it.
  const message =
    reason instanceof Error && typeof reason.message === "string"
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "";
  const lowered = message.toLowerCase();
  const match = REASON_RULES.find(([, needles]) =>
    needles.some((needle) => lowered.includes(needle)),
  );
  return match ? match[0] : "unknown";
};

const crashFingerprint = (error: unknown, componentStack = ""): string => {
  const input =
    error instanceof Error
      ? `${error.name}\n${error.stack ?? ""}\n${componentStack}`
      : `nonerror\n${describeReason(error)}\n${componentStack}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const reportFrontendCrash = (
  source: CrashSource,
  error: unknown,
  componentStack = "",
) => {
  const fingerprint = crashFingerprint(error, componentStack);
  const dedupeKey = `${source}:${fingerprint}`;
  if (reportedCrashes.has(dedupeKey)) return;
  reportedCrashes.add(dedupeKey);
  void invoke("report_frontend_crash", {
    windowLabel: getCurrentWindow().label,
    source,
    errorKind: errorKind(error),
    fingerprint,
    reasonCode: reasonCode(error),
  }).catch(() => {});
};

class CrashBoundary extends React.Component<
  React.PropsWithChildren,
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportFrontendCrash("render", error, info.componentStack ?? "");
  }

  render() {
    if (!this.state.crashed) return this.props.children;

    return (
      <main
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: 24,
          background: "#f7f5f0",
          color: "#181713",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          textAlign: "center",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            Glimpse hit an error
          </h1>
          <p style={{ margin: "8px 0 0", fontSize: 14 }}>
            Please restart the app.
          </p>
        </div>
      </main>
    );
  }
}

window.addEventListener("error", (event) => {
  if (event.error !== undefined && event.error !== null) {
    reportFrontendCrash("window_error", event.error);
  }
});
window.addEventListener("unhandledrejection", (event) => {
  if (event.reason !== undefined && event.reason !== null) {
    reportFrontendCrash("unhandled_rejection", event.reason);
  }
});

const applyInitialTextScale = () => {
  if (getCurrentWindow().label !== "settings") return;

  const mode = parseTextSizeMode(
    localStorage.getItem(TEXT_SIZE_MODE_STORAGE_KEY),
  );
  document.documentElement.style.setProperty(
    "--ui-text-scale",
    resolveTextScale(mode, detectAppPlatform()),
  );
};

applyInitialTextScale();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CrashBoundary>
      <AppProviders>
        <App />
      </AppProviders>
    </CrashBoundary>
  </React.StrictMode>,
);
