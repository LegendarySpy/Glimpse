import { I18nProvider } from "@lingui/react";
import { useEffect, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSettings } from "../features/settings/api";
import { activateLocale, i18n } from "../i18n";
import type { StoredSettings } from "../types";

function OverlayLocaleSync() {
  useEffect(() => {
    if (getCurrentWindow().label === "settings") return;

    let cancelled = false;
    let receivedChange = false;
    let unlisten: (() => void) | undefined;

    void listen<StoredSettings>("settings:changed", (event) => {
      receivedChange = true;
      if (!cancelled) void activateLocale(event.payload.app_locale);
    })
      .then(async (stopListening) => {
        if (cancelled) {
          stopListening();
          return;
        }
        unlisten = stopListening;
        const settings = await getSettings();
        if (!cancelled && !receivedChange)
          void activateLocale(settings.app_locale);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <I18nProvider i18n={i18n}>
      <OverlayLocaleSync />
      {children}
    </I18nProvider>
  );
}
