import { lazy, Suspense, useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "../features/settings/queries";
import type { TextSizeMode, ThemeMode } from "../types";
import { detectAppPlatform } from "../platform/service";
import {
  parseTextSizeMode,
  resolveTextScale,
  TEXT_SIZE_MODE_STORAGE_KEY,
} from "../shared/lib/textSize";
import "./App.css";

const Home = lazy(() => import("../Home"));
const PillOverlay = lazy(() => import("../features/pill/PillOverlay"));
const ToastOverlay = lazy(() => import("../features/toast/ToastOverlay"));
const AneCompileOverlay = lazy(
  () => import("../features/settings/components/AneCompileOverlay"),
);
const OnboardingScreen = lazy(
  () => import("../features/onboarding/OnboardingScreen"),
);

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

function App() {
  const [windowLabel] = useState(() => getCurrentWindow().label);

  const isSettingsWindow = windowLabel === "settings";

  const { data: settings, isLoading: settingsLoading } = useSettings(
    undefined,
    isSettingsWindow,
  );
  const showOnboarding =
    isSettingsWindow && !!settings && !settings.onboarding_completed;

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    if (windowLabel !== "settings") {
      root.classList.remove("text-scale-anim-ready");
      root.style.setProperty("--ui-text-scale", "1");
      return;
    }

    const platform = detectAppPlatform();
    const applyTextScale = (mode: TextSizeMode) => {
      const scaleValue = resolveTextScale(mode, platform);
      root.style.setProperty("--ui-text-scale", scaleValue);
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
  }, [windowLabel]);

  // Pill & toast overlays always render in dark: they're transparent
  // floating chrome that lives on top of the user's workspace, not app UI.
  // The settings window boots dark until settings load. Onboarding follows the
  // system appearance (the user hasn't picked a theme yet); the app otherwise
  // follows the saved theme.
  useEffect(() => {
    const root = document.documentElement;

    if (windowLabel !== "settings" || settingsLoading) {
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
  }, [settings?.theme_mode, settingsLoading, showOnboarding, windowLabel]);

  useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    if (windowLabel === "settings") {
      html.style.backgroundColor = "var(--color-bg-secondary)";
      body.style.backgroundColor = "var(--color-bg-secondary)";
    } else {
      html.style.backgroundColor = "";
      body.style.backgroundColor = "";
    }
    return () => {
      html.style.backgroundColor = "";
      body.style.backgroundColor = "";
    };
  }, [windowLabel]);

  if (windowLabel === "settings") {
    if (settingsLoading) {
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
          {showOnboarding ? (
            <OnboardingScreen onComplete={() => {}} />
          ) : (
            <Home />
          )}
          <AneCompileOverlay />
        </div>
      </Suspense>
    );
  }

  if (windowLabel !== "toast") {
    return (
      <div className="flex h-screen w-screen items-center justify-center overflow-hidden">
        <Suspense fallback={null}>
          <PillOverlay />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center overflow-hidden">
      <Suspense fallback={null}>
        <ToastOverlay />
      </Suspense>
    </div>
  );
}

export default App;
