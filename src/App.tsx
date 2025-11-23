import { useState, useEffect, ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import PillOverlay from "./pill";
import Settings from "./Settings";
import "./App.css";

function App() {
  const [windowLabel, setWindowLabel] = useState("");

  useEffect(() => {
    const win = getCurrentWindow();
    setWindowLabel(win.label);
  }, []);

  if (windowLabel === "settings") {
    return <Settings />;
  }

  const overlayRegistry: Record<string, ComponentType<any>> = {
    main: PillOverlay,
    pill: PillOverlay,
  };

  const ActiveOverlay = overlayRegistry[windowLabel] ?? PillOverlay;
  return <ActiveOverlay />;
}

export default App;
