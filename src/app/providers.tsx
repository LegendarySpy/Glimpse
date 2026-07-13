import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { activateLocale, i18n } from "../i18n";
import { settingsKeys, useSettings } from "../features/settings/queries";
import { modelKeys } from "../features/settings/models-queries";
import { transcriptionKeys } from "../features/transcriptions/queries";
import { updateKeys } from "../features/updates/queries";
import type { StoredSettings } from "../types";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function QuerySyncBridge() {
  const isSettingsWindow = getCurrentWindow().label === "settings";

  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    const register = <TPayload,>(
      event: string,
      handler: (payload: TPayload) => void,
    ) => {
      listen<TPayload>(event, (eventPayload) => {
        if (!cancelled) {
          handler(eventPayload.payload);
        }
      })
        .then((fn) => {
          if (cancelled) {
            fn();
          } else {
            unlisteners.push(fn);
          }
        })
        .catch(() => {});
    };

    register<StoredSettings>("settings:changed", (settings) => {
      queryClient.setQueryData(settingsKeys.detail(), settings);
      queryClient.invalidateQueries({ queryKey: modelKeys.speech() });
    });

    if (isSettingsWindow) {
      register("update:available", () => {
        queryClient.invalidateQueries({ queryKey: updateKeys.status() });
      });
      register("update:cleared", () => {
        queryClient.invalidateQueries({ queryKey: updateKeys.status() });
      });
      register("transcription:complete", () => {
        queryClient.invalidateQueries({ queryKey: transcriptionKeys.all });
      });
      register("transcription:error", () => {
        queryClient.invalidateQueries({ queryKey: transcriptionKeys.all });
      });
      register("audio:input-devices-changed", () => {
        queryClient.invalidateQueries({ queryKey: settingsKeys.devices() });
      });
    }

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [isSettingsWindow]);

  return null;
}

function LocaleSyncBridge() {
  const { data: settings } = useSettings(undefined, true);

  useEffect(() => {
    activateLocale(settings?.app_locale);
  }, [settings?.app_locale]);

  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <LocaleSyncBridge />
        <QuerySyncBridge />
        {children}
      </QueryClientProvider>
    </I18nProvider>
  );
}
