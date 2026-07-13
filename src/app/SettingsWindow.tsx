import { lazy, Suspense, useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { activateLocale } from "../i18n";
import { detectAppPlatform } from "../platform/service";
import {
  parseTextSizeMode,
  resolveTextScale,
  TEXT_SIZE_MODE_STORAGE_KEY,
} from "../shared/lib/textSize";
import { modelKeys } from "../features/settings/models-queries";
import { settingsKeys, useSettings } from "../features/settings/queries";
import { transcriptionKeys } from "../features/transcriptions/queries";
import { updateKeys } from "../features/updates/queries";
import type { StoredSettings, TextSizeMode, ThemeMode } from "../types";

const Home = lazy(() => import("../Home"));
const AneCompileOverlay = lazy(
  () => import("../features/settings/components/AneCompileOverlay"),
);
const OnboardingScreen = lazy(
  () => import("../features/onboarding/OnboardingScreen"),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const parseThemeMode = (value: string | null): ThemeMode =>
  value === "light" || value === "dark" || value === "system"
    ? value
    : "system";

const resolveThemeAttribute = (mode: ThemeMode): "light" | "dark" => {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return mode;
};

function QuerySyncBridge() {
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    const register = <TPayload,>(
      event: string,
      handler: (payload: TPayload) => void,
    ) => {
      listen<TPayload>(event, (eventPayload) => {
        if (!cancelled) handler(eventPayload.payload);
      })
        .then((unlisten) => {
          if (cancelled) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(() => {});
    };

    register<StoredSettings>("settings:changed", (settings) => {
      queryClient.setQueryData(settingsKeys.detail(), settings);
      queryClient.invalidateQueries({ queryKey: modelKeys.speech() });
    });
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

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  return null;
}

function SettingsContent() {
  const { data: settings, isLoading } = useSettings();
  const showOnboarding = !!settings && !settings.onboarding_completed;

  useEffect(() => {
    activateLocale(settings?.app_locale);
  }, [settings?.app_locale]);

  useEffect(() => {
    const root = document.documentElement;
    const applyTextScale = (mode: TextSizeMode) => {
      root.style.setProperty(
        "--ui-text-scale",
        resolveTextScale(mode, detectAppPlatform()),
      );
    };

    applyTextScale(
      parseTextSizeMode(localStorage.getItem(TEXT_SIZE_MODE_STORAGE_KEY)),
    );
    root.classList.add("text-scale-anim-ready");

    const unlistenPromise = listen<{ mode?: TextSizeMode }>(
      "ui:text_size_changed",
      (event) => {
        applyTextScale(parseTextSizeMode(event.payload?.mode ?? null));
      },
    );

    return () => {
      root.classList.remove("text-scale-anim-ready");
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (isLoading) {
      root.dataset.theme = "dark";
      return;
    }

    let currentMode: ThemeMode = showOnboarding
      ? "system"
      : parseThemeMode(settings?.theme_mode ?? null);

    const applyTheme = (mode: ThemeMode) => {
      currentMode = mode;
      root.dataset.theme = resolveThemeAttribute(mode);
    };

    applyTheme(currentMode);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleSystemChange = () => {
      if (currentMode === "system") applyTheme("system");
    };
    mediaQuery.addEventListener("change", handleSystemChange);

    const unlistenPromise = listen<{ mode?: ThemeMode }>(
      "ui:theme_changed",
      (event) => {
        applyTheme(parseThemeMode(event.payload?.mode ?? null));
      },
    );

    return () => {
      mediaQuery.removeEventListener("change", handleSystemChange);
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [isLoading, settings?.theme_mode, showOnboarding]);

  if (isLoading) {
    return (
      <div className="settings-view h-screen w-screen overflow-hidden bg-surface-secondary" />
    );
  }

  return (
    <Suspense
      fallback={
        <div className="settings-view h-screen w-screen overflow-hidden bg-surface-secondary" />
      }
    >
      <div className="settings-view h-screen w-screen overflow-hidden">
        {showOnboarding ? <OnboardingScreen onComplete={() => {}} /> : <Home />}
        <AneCompileOverlay />
      </div>
    </Suspense>
  );
}

export default function SettingsWindow() {
  return (
    <QueryClientProvider client={queryClient}>
      <QuerySyncBridge />
      <SettingsContent />
    </QueryClientProvider>
  );
}
