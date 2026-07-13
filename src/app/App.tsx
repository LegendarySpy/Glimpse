import { lazy, Suspense, useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

const SettingsWindow = lazy(() => import("./SettingsWindow"));
const PillOverlay = lazy(() => import("../features/pill/PillOverlay"));
const ToastOverlay = lazy(() => import("../features/toast/ToastOverlay"));

function App() {
  const [windowLabel] = useState(() => getCurrentWindow().label);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

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
    return (
      <Suspense
        fallback={
          <div className="settings-view h-screen w-screen overflow-hidden bg-surface-secondary" />
        }
      >
        <SettingsWindow />
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
