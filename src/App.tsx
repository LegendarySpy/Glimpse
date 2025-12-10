import { useState, useEffect, ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import PillOverlay from "./pill";
import ToastOverlay from "./ToastOverlay";
import Home from "./Home";
import Onboarding from "./Onboarding";
import FAQ from "./components/FAQ";
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

  // Check onboarding status for settings window
  useEffect(() => {
    if (windowLabel === "settings") {
      const checkOnboarding = async () => {
        try {
          const settings = await invoke<StoredSettings>("get_settings");
          setShowOnboarding(!settings.onboarding_completed);
        } catch (err) {
          console.error("Failed to load settings:", err);
          // On error, assume onboarding is complete to not block users
          setShowOnboarding(false);
        } finally {
          setIsLoading(false);
        }
      };
      checkOnboarding();
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
    } else {
      body.classList.remove("settings-body");
      html.classList.remove("settings-html");
    }
    return () => {
      body.classList.remove("settings-body");
      html.classList.remove("settings-html");
    };
  }, [windowLabel]);

  // Handle onboarding completion
  const handleOnboardingComplete = () => {
    setShowOnboarding(false);
  };

  // FAQ window
  if (windowLabel === "faq") {
    return (
      <div className="h-screen w-screen overflow-hidden bg-[#0a0a0c]">
        <FAQ />
      </div>
    );
  }

  if (windowLabel === "settings") {
    // Show loading state briefly while checking onboarding
    if (isLoading) {
      return (
        <div className="settings-view h-screen w-screen overflow-hidden bg-[#0a0a0c]" />
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
