import { useState, useEffect, ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import PillOverlay from "./pill";
import ToastOverlay from "./ToastOverlay";
import Home from "./Home";
import Onboarding from "./Onboarding";
import "./App.css";

type StoredSettings = {
  onboarding_completed: boolean;
  hold_shortcut: string;
  hold_enabled: boolean;
  toggle_shortcut: string;
  toggle_enabled: boolean;
  transcription_mode: string;
  local_model: string;
  microphone_device: string | null;
  language: string;
  llm_cleanup_enabled: boolean;
  llm_provider: string;
  llm_endpoint: string;
  llm_api_key: string;
  llm_model: string;
  user_context: string;
  dictionary: string[];
};

type AppInfo = {
  version: string;
  data_dir_size_bytes: number;
  data_dir_path: string;
};

const VERSION_STORAGE_KEY = "glimpse_last_version";

function App() {
  const [windowLabel, setWindowLabel] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    setWindowLabel(win.label);
  }, []);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  useEffect(() => {
    if (windowLabel === "settings") {
      const checkOnboarding = async () => {
        try {
          const settings = await invoke<StoredSettings>("get_settings");
          setShowOnboarding(!settings.onboarding_completed);
        } catch (err) {
          console.error("Failed to load settings:", err);
          setShowOnboarding(false);
        } finally {
          setIsLoading(false);
        }
      };
      checkOnboarding();

      const checkVersionAndShowToast = async () => {
        try {
          const info = await invoke<AppInfo>("get_app_info");
          const currentVersion = info.version;
          const storedVersion = localStorage.getItem(VERSION_STORAGE_KEY);

          if (storedVersion && storedVersion !== currentVersion) {
            await invoke("debug_show_toast", {
              toastType: "update",
              message: `Updated to v${currentVersion}`,
              action: "open_whats_new",
              actionLabel: "See what's new",
            });
          }

          localStorage.setItem(VERSION_STORAGE_KEY, currentVersion);
        } catch (err) {
          console.error("Failed to check version:", err);
        }
      };
      checkVersionAndShowToast();
    } else {
      setIsLoading(false);
    }
  }, [windowLabel]);

  useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    if (windowLabel === "settings") {
      body.classList.add("settings-body");
      html.classList.add("settings-html");
      html.style.backgroundColor = "#030303";
      body.style.backgroundColor = "#030303";
    } else {
      body.classList.remove("settings-body");
      html.classList.remove("settings-html");
      html.style.backgroundColor = "";
      body.style.backgroundColor = "";
    }
    return () => {
      body.classList.remove("settings-body");
      html.classList.remove("settings-html");
      html.style.backgroundColor = "";
      body.style.backgroundColor = "";
    };
  }, [windowLabel]);

  const handleOnboardingComplete = () => {
    setShowOnboarding(false);
  };

  if (windowLabel === "settings") {
    if (isLoading) {
      return (
        <div className="settings-view h-screen w-screen overflow-hidden bg-surface-secondary" />
      );
    }

    // Show onboarding if not completed
    if (showOnboarding) {
      return (
        <div className="settings-view h-screen w-screen overflow-hidden">
          <Onboarding onComplete={handleOnboardingComplete} />
        </div>
      );
    }

    // Show main app
    return (
      <div className="settings-view h-screen w-screen overflow-hidden">
        <Home />
      </div>
    );
  }

  const overlayRegistry: Record<string, ComponentType<any>> = {
    main: PillOverlay,
    pill: PillOverlay,
    toast: ToastOverlay,
  };

  const ActiveOverlay = overlayRegistry[windowLabel] ?? PillOverlay;
  return (
    <div className="flex h-full w-full items-center justify-center">
      <ActiveOverlay />
    </div>
  );
}

export default App;
