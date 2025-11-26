import { useState, useEffect, ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import PillOverlay from "./pill";
import Home from "./Home";
import "./App.css";

function App() {
  const [windowLabel, setWindowLabel] = useState("");

  useEffect(() => {
    const win = getCurrentWindow();
    setWindowLabel(win.label);
  }, []);

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

  if (windowLabel === "settings") {
    return (
      <div className="settings-view h-screen w-screen overflow-hidden">
        <Home />
      </div>
    );
  }

  const overlayRegistry: Record<string, ComponentType<any>> = {
    main: PillOverlay,
    pill: PillOverlay,
  };

  const ActiveOverlay = overlayRegistry[windowLabel] ?? PillOverlay;
  return (
    <div className="flex h-full w-full items-center justify-center">
      <ActiveOverlay />
    </div>
  );
}

export default App;
