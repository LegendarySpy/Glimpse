import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

type StoredSettings = {
    shortcut: string;
};

type SaveState = "idle" | "saving" | "success" | "error";

const modifierOrder = ["Control", "Shift", "Alt", "Command"];

const Settings = () => {
    const [shortcut, setShortcut] = useState("Control+Space");
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<SaveState>("idle");
    const [error, setError] = useState<string | null>(null);
    const [captureActive, setCaptureActive] = useState(false);
    const pressedModifiers = useRef<Set<string>>(new Set());
    const primaryKey = useRef<string | null>(null);

    useEffect(() => {
        invoke<StoredSettings>("get_settings")
            .then((result) => {
                setShortcut(result.shortcut);
                setLoading(false);
            })
            .catch((err) => {
                console.error(err);
                setError(String(err));
                setLoading(false);
            });
    }, []);

    useEffect(() => {
        if (!captureActive) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            event.preventDefault();
            const modifier = normalizeModifier(event);
            if (modifier) {
                pressedModifiers.current.add(modifier);
            } else if (event.code) {
                primaryKey.current = event.code;
            }
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            event.preventDefault();
            if (!primaryKey.current && pressedModifiers.current.size === 0) {
                return;
            }

            const combo = buildShortcut();
            if (combo) {
                setShortcut(combo);
                setError(null);
            } else {
                setError("Add a base key to your shortcut");
            }

            finalizeCapture();
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                finalizeCapture();
            }
        };

        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("keyup", handleKeyUp, true);
        window.addEventListener("keydown", handleEscape, true);

        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
            window.removeEventListener("keyup", handleKeyUp, true);
            window.removeEventListener("keydown", handleEscape, true);
        };
    }, [captureActive]);

    const finalizeCapture = () => {
        setCaptureActive(false);
        pressedModifiers.current.clear();
        primaryKey.current = null;
    };

    const buildShortcut = () => {
        if (!primaryKey.current) {
            return null;
        }

        const orderedMods = Array.from(pressedModifiers.current).sort(
            (a, b) => modifierOrder.indexOf(a) - modifierOrder.indexOf(b)
        );

        const formattedKey = formatKey(primaryKey.current);
        if (!formattedKey) {
            return null;
        }

        return [...orderedMods, formattedKey].join("+");
    };

    const handleSave = async () => {
        setStatus("saving");
        setError(null);
        try {
            await invoke("update_shortcut", { shortcut });
            setStatus("success");
            setTimeout(() => setStatus("idle"), 2000);
        } catch (err) {
            console.error(err);
            setError(String(err));
            setStatus("error");
        }
    };

    const statusMessage = (() => {
        if (loading) return "Loading settings…";
        switch (status) {
            case "saving":
                return "Saving…";
            case "success":
                return "Shortcut updated";
            case "error":
                return "Unable to save";
            default:
                return error ?? "";
        }
    })();

    return (
        <div className="min-h-screen bg-[#050505] text-white p-6 font-sans">
            <div className="max-w-xl mx-auto space-y-8">
                <header>
                    <p className="text-sm uppercase tracking-[0.4em] text-gray-500">Glimpse</p>
                    <h1 className="text-3xl font-semibold mt-1">Settings</h1>
                    <p className="text-sm text-gray-500 mt-2">
                        Configure the system shortcut that arms Glimpse in listening mode.
                    </p>
                </header>

                <section className="space-y-3">
                    <label className="block text-xs uppercase tracking-[0.3em] text-gray-500">
                        Hold-to-talk shortcut
                    </label>
                    <div className="flex flex-col gap-2 rounded-2xl border border-white/5 bg-white/5 p-4">
                        <div className="flex items-center justify-between gap-3">
                            <span className="font-mono text-base text-white truncate">{shortcut}</span>
                            <button
                                onClick={() => {
                                    pressedModifiers.current.clear();
                                    primaryKey.current = null;
                                    setCaptureActive(true);
                                    setError(null);
                                }}
                                className={`px-3 py-1.5 text-xs rounded-full border border-white/10 transition-colors ${
                                    captureActive ? "bg-white text-black" : "bg-white/10 hover:bg-white/20"
                                }`}
                            >
                                {captureActive ? "Listening…" : "Change"}
                            </button>
                        </div>
                        <p className="text-[11px] text-gray-500">
                            Press the keys you want to use (for example, Control + Space). Release to confirm.
                        </p>
                    </div>
                </section>

                <section className="flex items-center justify-between border-t border-white/5 pt-6">
                    <div>
                        {statusMessage && (
                            <p
                                className={`text-xs ${
                                    status === "error" ? "text-red-400" : "text-gray-400"
                                }`}
                            >
                                {statusMessage}
                            </p>
                        )}
                    </div>
                    <button
                        disabled={loading || status === "saving"}
                        onClick={handleSave}
                        className="px-4 py-2 rounded-full bg-white text-black text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Save Shortcut
                    </button>
                </section>
            </div>
        </div>
    );

    function normalizeModifier(event: KeyboardEvent): string | null {
        if (event.key === "Control" || event.code === "ControlLeft" || event.code === "ControlRight") {
            return "Control";
        }
        if (event.key === "Shift" || event.code === "ShiftLeft" || event.code === "ShiftRight") {
            return "Shift";
        }
        if (event.key === "Alt" || event.key === "Option") {
            return "Alt";
        }
        if (event.key === "Meta") {
            return "Command";
        }
        return null;
    }

    function formatKey(code: string): string | null {
        if (!code) return null;
        if (code.startsWith("Key")) {
            return code.toUpperCase();
        }
        if (code.startsWith("Digit")) {
            return code.replace("Digit", "");
        }
        switch (code) {
            case "Space":
                return "Space";
            case "Enter":
                return "Enter";
            case "Tab":
                return "Tab";
            default:
                return code;
        }
    }
};

export default Settings;
