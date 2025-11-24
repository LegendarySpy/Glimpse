import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import DotMatrix from "./components/DotMatrix";

type TranscriptionMode = "cloud" | "local";

type StoredSettings = {
    shortcut: string;
    transcription_mode: TranscriptionMode;
    local_model: string;
};

type SaveState = "idle" | "saving" | "success" | "error";

type ModelInfo = {
    key: string;
    label: string;
    description: string;
    size_mb: number;
    file_count: number;
    engine: string;
    variant: string;
};

type ModelStatus = {
    key: string;
    installed: boolean;
    bytes_on_disk: number;
    missing_files: string[];
    directory: string;
};

type DownloadProgressPayload = {
    model: string;
    file: string;
    downloaded: number;
    total: number;
    percent: number;
};

type DownloadEvent =
    | { status: "idle"; percent: number; downloaded: number; total: number; file?: string }
    | { status: "downloading"; percent: number; downloaded: number; total: number; file: string }
    | { status: "complete"; percent: number; downloaded: number; total: number }
    | { status: "error"; percent: number; downloaded: number; total: number; message: string };

const modifierOrder = ["Control", "Shift", "Alt", "Command"];

const Settings = () => {
    const [shortcut, setShortcut] = useState("Control+Space");
    const [transcriptionMode, setTranscriptionMode] = useState<TranscriptionMode>("cloud");
    const [localModel, setLocalModel] = useState("parakeet_tdt_int8");
    const [modelCatalog, setModelCatalog] = useState<ModelInfo[]>([]);
    const [modelStatus, setModelStatus] = useState<Record<string, ModelStatus>>({});
    const [downloadState, setDownloadState] = useState<Record<string, DownloadEvent>>({});
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
                setTranscriptionMode(result.transcription_mode);
                setLocalModel(result.local_model);
                setLoading(false);
            })
            .catch((err) => {
                console.error(err);
                setError(String(err));
                setLoading(false);
            });
    }, []);

    const refreshModelStatus = useCallback((modelKey: string) => {
        invoke<ModelStatus>("check_model_status", { model: modelKey })
            .then((status) => {
                setModelStatus((prev) => ({ ...prev, [modelKey]: status }));
            })
            .catch((err) => {
                console.error(err);
                setModelStatus((prev) => ({
                    ...prev,
                    [modelKey]: {
                        key: modelKey,
                        installed: false,
                        bytes_on_disk: 0,
                        missing_files: [],
                        directory: "",
                    },
                }));
            });
    }, []);

    useEffect(() => {
        invoke<ModelInfo[]>("list_models")
            .then((models) => {
                setModelCatalog(models);
                models.forEach((model) => refreshModelStatus(model.key));
            })
            .catch((err) => console.error(err));
    }, [refreshModelStatus]);

    useEffect(() => {
        let unlistenProgress: UnlistenFn | null = null;
        let unlistenComplete: UnlistenFn | null = null;
        let unlistenError: UnlistenFn | null = null;

        const setup = async () => {
            unlistenProgress = await listen<DownloadProgressPayload>("download:progress", (event) => {
                const payload = event.payload;
                setDownloadState((prev) => ({
                    ...prev,
                    [payload.model]: {
                        status: "downloading",
                        percent: Math.min(100, payload.percent),
                        downloaded: payload.downloaded,
                        total: payload.total,
                        file: payload.file,
                    },
                }));
            });

            unlistenComplete = await listen<{ model: string }>("download:complete", (event) => {
                const model = event.payload.model;
                setDownloadState((prev) => ({
                    ...prev,
                    [model]: {
                        status: "complete",
                        percent: 100,
                        downloaded: prev[model]?.downloaded ?? 0,
                        total: prev[model]?.total ?? 0,
                    },
                }));
                refreshModelStatus(model);
            });

            unlistenError = await listen<{ model: string; error: string }>("download:error", (event) => {
                const { model, error } = event.payload;
                setDownloadState((prev) => ({
                    ...prev,
                    [model]: {
                        status: "error",
                        message: error,
                        percent: prev[model]?.percent ?? 0,
                        downloaded: prev[model]?.downloaded ?? 0,
                        total: prev[model]?.total ?? 0,
                    },
                }));
            });
        };

        setup();

        return () => {
            unlistenProgress?.();
            unlistenComplete?.();
            unlistenError?.();
        };
    }, [refreshModelStatus]);

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
            await invoke("update_settings", {
                shortcut,
                transcriptionMode,
                transcription_mode: transcriptionMode,
                localModel,
                local_model: localModel,
            });
            setStatus("success");
            setTimeout(() => setStatus("idle"), 2000);
        } catch (err) {
            console.error(err);
            setError(String(err));
            setStatus("error");
        }
    };

    const handleDownload = async (modelKey: string) => {
        setDownloadState((prev) => ({
            ...prev,
            [modelKey]: {
                status: "downloading",
                percent: 0,
                downloaded: 0,
                total: 0,
                file: "starting",
            },
        }));

        try {
            await invoke("download_model", { model: modelKey });
            refreshModelStatus(modelKey);
        } catch (err) {
            console.error(err);
            setDownloadState((prev) => ({
                ...prev,
                [modelKey]: {
                    status: "error",
                    message: String(err),
                    percent: prev[modelKey]?.percent ?? 0,
                    downloaded: prev[modelKey]?.downloaded ?? 0,
                    total: prev[modelKey]?.total ?? 0,
                },
            }));
        }
    };

    const handleDelete = async (modelKey: string) => {
        try {
            await invoke("delete_model", { model: modelKey });
            setDownloadState((prev) => ({ ...prev, [modelKey]: { status: "idle", percent: 0, downloaded: 0, total: 0 } }));
            refreshModelStatus(modelKey);
        } catch (err) {
            console.error(err);
            setDownloadState((prev) => ({
                ...prev,
                [modelKey]: {
                    status: "error",
                    message: String(err),
                    percent: prev[modelKey]?.percent ?? 0,
                    downloaded: prev[modelKey]?.downloaded ?? 0,
                    total: prev[modelKey]?.total ?? 0,
                },
            }));
        }
    };

    const matrixProgress = (modelKey: string) => {
        const progress = downloadState[modelKey];
        const status = modelStatus[modelKey];
        const installedPercent = status?.installed ? 100 : 0;
        const percent = progress?.percent ?? installedPercent;
        const displayStatus = progress?.status ?? (status?.installed ? "complete" : "idle");

        return (
            <MatrixProgress
                percent={percent}
                status={displayStatus}
            />
        );
    };

    const formatBytes = (bytes: number) => {
        if (!bytes) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
    };

    const statusMessage = (() => {
        if (loading) return "Loading settings…";
        switch (status) {
            case "saving":
                return "Saving…";
            case "success":
                return "Shortcut updated";
            case "error":
                return error ?? "Unable to save";
            default:
                return error ?? "";
        }
    })();

    const [activeTab, setActiveTab] = useState<"general" | "models">("general");

    return (
        <div className="flex h-screen w-screen overflow-hidden bg-[#050505] font-sans text-white select-none">
            {/* Sidebar */}
            <aside className="flex w-64 flex-col border-r border-white/5 bg-[#0a0a0a]">
                <div data-tauri-drag-region className="h-8 w-full shrink-0" />
                <div className="px-6 pb-8">
                    <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-white/80 shadow-[0_0_8px_rgba(255,255,255,0.5)]" />
                        <span className="text-sm font-bold tracking-widest uppercase text-white/90">Glimpse</span>
                    </div>
                </div>
                <nav className="flex-1 space-y-1 px-3">
                    <SidebarItem
                        label="General"
                        active={activeTab === "general"}
                        onClick={() => setActiveTab("general")}
                        icon={
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                                <polyline points="9 22 9 12 15 12 15 22" />
                            </svg>
                        }
                    />
                    <SidebarItem
                        label="Models"
                        active={activeTab === "models"}
                        onClick={() => setActiveTab("models")}
                        icon={
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="3" y="3" width="7" height="7" />
                                <rect x="14" y="3" width="7" height="7" />
                                <rect x="14" y="14" width="7" height="7" />
                                <rect x="3" y="14" width="7" height="7" />
                            </svg>
                        }
                    />
                </nav>
                <div className="p-6">
                    <div className="rounded-xl border border-white/5 bg-white/5 p-4">
                        <p className="text-[10px] uppercase tracking-wider text-gray-500">Status</p>
                        <div className="mt-2 flex items-center gap-2">
                            <div className={`h-1.5 w-1.5 rounded-full ${loading ? "bg-amber-400" : "bg-emerald-400"}`} />
                            <span className="text-xs text-gray-300">{loading ? "Syncing..." : "Ready"}</span>
                        </div>
                    </div>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex flex-1 flex-col bg-[#050505]">
                <div data-tauri-drag-region className="h-8 w-full shrink-0" />
                <div className="flex-1 overflow-y-auto p-8 lg:p-12">
                    <div className="mx-auto max-w-4xl">
                        {activeTab === "general" && (
                            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                <header>
                                    <h1 className="text-3xl font-medium text-white">General</h1>
                                    <p className="mt-2 text-sm text-gray-400">Configure global shortcuts and transcription behavior.</p>
                                </header>

                                <section className="space-y-4">
                                    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 transition-colors hover:border-white/20">
                                        <div className="flex items-start justify-between">
                                            <div>
                                                <h3 className="text-sm font-medium text-white">Global Shortcut</h3>
                                                <p className="mt-1 text-xs text-gray-400">Hold to start recording anywhere.</p>
                                            </div>
                                            <button
                                                onClick={() => {
                                                    pressedModifiers.current.clear();
                                                    primaryKey.current = null;
                                                    setCaptureActive(true);
                                                    setError(null);
                                                }}
                                                className={`h-8 rounded-lg border px-3 text-xs font-medium transition-all ${
                                                    captureActive
                                                        ? "border-white bg-white text-black"
                                                        : "border-white/10 bg-white/5 text-white hover:bg-white/10"
                                                }`}
                                            >
                                                {captureActive ? "Listening..." : "Change"}
                                            </button>
                                        </div>
                                        <div className="mt-6 flex justify-center py-4">
                                            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-6 py-3 shadow-inner">
                                                <span className="font-mono text-lg tracking-wide text-white/90">{shortcut}</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 transition-colors hover:border-white/20">
                                        <div className="flex items-start justify-between">
                                            <div>
                                                <h3 className="text-sm font-medium text-white">Transcription Engine</h3>
                                                <p className="mt-1 text-xs text-gray-400">Choose where your audio is processed.</p>
                                            </div>
                                        </div>
                                        <div className="mt-6 grid grid-cols-2 gap-3">
                                            <button
                                                onClick={() => setTranscriptionMode("cloud")}
                                                className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all ${
                                                    transcriptionMode === "cloud"
                                                        ? "border-white bg-white text-black"
                                                        : "border-white/10 bg-white/5 hover:bg-white/10"
                                                }`}
                                            >
                                                <div className="relative z-10">
                                                    <div className="text-sm font-medium">Cloud API</div>
                                                    <div className={`mt-1 text-[11px] ${transcriptionMode === "cloud" ? "text-gray-600" : "text-gray-400"}`}>
                                                        Fast, lightweight, requires internet.
                                                    </div>
                                                </div>
                                            </button>
                                            <button
                                                onClick={() => setTranscriptionMode("local")}
                                                className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all ${
                                                    transcriptionMode === "local"
                                                        ? "border-white bg-white text-black"
                                                        : "border-white/10 bg-white/5 hover:bg-white/10"
                                                }`}
                                            >
                                                <div className="relative z-10">
                                                    <div className="text-sm font-medium">Local Engine</div>
                                                    <div className={`mt-1 text-[11px] ${transcriptionMode === "local" ? "text-gray-600" : "text-gray-400"}`}>
                                                        Private, offline, uses device resources.
                                                    </div>
                                                </div>
                                            </button>
                                        </div>
                                    </div>
                                </section>

                                <div className="flex items-center justify-between border-t border-white/5 pt-6">
                                    <p className={`text-xs ${status === "error" ? "text-red-400" : "text-gray-500"}`}>
                                        {statusMessage || "Changes are saved manually."}
                                    </p>
                                    <button
                                        disabled={loading || status === "saving"}
                                        onClick={handleSave}
                                        className="rounded-full bg-white px-6 py-2 text-sm font-medium text-black shadow-lg shadow-white/10 transition-transform active:scale-95 disabled:opacity-50"
                                    >
                                        {status === "saving" ? "Saving..." : "Save Changes"}
                                    </button>
                                </div>
                            </div>
                        )}

                        {activeTab === "models" && (
                            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                <header className="flex items-end justify-between">
                                    <div>
                                        <h1 className="text-3xl font-medium text-white">Models</h1>
                                        <p className="mt-2 text-sm text-gray-400">Manage offline transcription engines.</p>
                                    </div>
                                    <div className="text-right">
                                        <p className="text-2xl font-medium text-white">{modelCatalog.length}</p>
                                        <p className="text-xs text-gray-500">Available</p>
                                    </div>
                                </header>

                                <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2 xl:grid-cols-2">
                                    {modelCatalog.map((model) => {
                                        const status = modelStatus[model.key];
                                        const progress = downloadState[model.key];
                                        const isActive = localModel === model.key;
                                        const isDownloading = progress?.status === "downloading";
                                        const installed = status?.installed;
                                        const disableAction = isDownloading;
                                        const showError = progress?.status === "error";

                                        return (
                                            <div
                                                key={model.key}
                                                className={`group relative flex flex-col justify-between overflow-hidden rounded-xl border p-4 transition-all duration-300 ${
                                                    isActive
                                                        ? "border-white/40 bg-white/10 shadow-lg shadow-white/5"
                                                        : "border-white/5 bg-white/5 hover:border-white/10 hover:bg-white/[0.07]"
                                                }`}
                                            >
                                                <div className="relative z-10">
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2">
                                                                <h3 className="font-medium text-white truncate">{model.label}</h3>
                                                                {isActive && (
                                                                    <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
                                                                )}
                                                            </div>
                                                            <p className="mt-0.5 text-[11px] text-gray-400 line-clamp-2 leading-relaxed">
                                                                {model.description}
                                                            </p>
                                                        </div>
                                                        <div className="flex shrink-0 items-center gap-2">
                                                            {installed && (
                                                                <button
                                                                    onClick={() => setLocalModel(model.key)}
                                                                    disabled={isActive}
                                                                    className={`rounded-md px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-all ${
                                                                        isActive
                                                                            ? "bg-emerald-500/20 text-emerald-400 cursor-default"
                                                                            : "bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white"
                                                                    }`}
                                                                >
                                                                    {isActive ? "Active" : "Use"}
                                                                </button>
                                                            )}
                                                            <button
                                                                onClick={() => (installed ? handleDelete(model.key) : handleDownload(model.key))}
                                                                disabled={disableAction}
                                                                title={installed ? "Delete Model" : "Download Model"}
                                                                className={`flex h-7 w-7 items-center justify-center rounded-lg border transition-colors ${
                                                                    installed
                                                                        ? "border-red-500/20 text-red-400 hover:bg-red-500/10 hover:border-red-500/30"
                                                                        : "border-white/10 text-white hover:bg-white/10 hover:border-white/20"
                                                                } ${disableAction ? "cursor-not-allowed opacity-50" : ""}`}
                                                            >
                                                                {installed ? (
                                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                        <path d="M3 6h18" />
                                                                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                                                                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                                                                    </svg>
                                                                ) : (
                                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                                                        <polyline points="7 10 12 15 17 10" />
                                                                        <line x1="12" y1="15" x2="12" y2="3" />
                                                                    </svg>
                                                                )}
                                                            </button>
                                                        </div>
                                                    </div>

                                                    <div className="mt-3 flex items-end justify-between">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <div className="flex items-center gap-1.5 rounded-md bg-black/20 px-2 py-1">
                                                                <div className={`h-1 w-1 rounded-full ${model.engine.includes("Whisper") ? "bg-purple-400" : "bg-blue-400"}`} />
                                                                <span className="text-[10px] font-medium text-gray-300">{model.engine.split(" ")[0]}</span>
                                                            </div>
                                                            <span className="text-[10px] text-gray-500">•</span>
                                                            <span className="text-[10px] text-gray-400">{model.variant}</span>
                                                            <span className="text-[10px] text-gray-500">•</span>
                                                            <span className={`text-[10px] font-medium ${model.size_mb > 1000 ? "text-amber-200/80" : "text-gray-400"}`}>
                                                                {formatBytes(model.size_mb * 1024 * 1024)}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="relative z-10 mt-4">
                                                    <div className="space-y-1.5">
                                                        {matrixProgress(model.key)}
                                                        <div className="flex justify-between text-[9px] font-medium tracking-wide uppercase text-gray-600">
                                                            <span>
                                                                {installed
                                                                    ? "Ready"
                                                                    : progress?.status === "downloading"
                                                                    ? (
                                                                        <span className="flex gap-2">
                                                                            <span className="min-w-[4ch] text-right tabular-nums">{progress.percent.toFixed(0)}%</span>
                                                                            <span className="normal-case text-gray-500 truncate max-w-[120px]">{progress.file}</span>
                                                                        </span>
                                                                    )
                                                                    : "Not Installed"}
                                                            </span>
                                                            {showError && (
                                                                <span className="text-red-400 truncate max-w-[120px] normal-case tracking-normal">
                                                                    {(progress as Extract<DownloadEvent, { status: "error" }>).message}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </main>
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

        if (code.startsWith("Key") && code.length > 3) {
            return code.slice(3).toUpperCase();
        }

        if (code.startsWith("Digit") && code.length > 5) {
            return code.slice(5);
        }

        const namedKeys: Record<string, string> = {
            Space: "Space",
            Enter: "Enter",
            Tab: "Tab",
            Backspace: "Backspace",
            Escape: "Escape",
            Delete: "Delete",
            ArrowUp: "ArrowUp",
            ArrowDown: "ArrowDown",
            ArrowLeft: "ArrowLeft",
            ArrowRight: "ArrowRight",
            Backquote: "`",
            Minus: "-",
            Equal: "=",
            BracketLeft: "[",
            BracketRight: "]",
            Backslash: "\\",
            Semicolon: ";",
            Quote: "'",
            Comma: ",",
            Period: ".",
            Slash: "/",
        };

        if (namedKeys[code]) {
            return namedKeys[code];
        }

        return code;
    }
};

export default Settings;

const MatrixProgress = ({ percent, status }: { percent: number; status: string }) => {
    const rows = 3;
    const cols = 32;
    const totalDots = rows * cols;
    const activeCount = Math.round((percent / 100) * totalDots);
    const activeDots = useMemo(() => Array.from({ length: activeCount }, (_, idx) => idx), [activeCount]);
    const color = status === "error" ? "#f87171" : status === "complete" ? "#4ade80" : "#a5f3fc";

    return (
        <DotMatrix
            rows={rows}
            cols={cols}
            activeDots={activeDots}
            dotSize={3}
            gap={3}
            color={color}
            className="opacity-80"
        />
    );
};

const SidebarItem = ({
    label,
    active,
    onClick,
    icon,
}: {
    label: string;
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
}) => (
    <button
        onClick={onClick}
        className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
            active ? "bg-white/10 text-white" : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
        }`}
    >
        <div className={`transition-colors ${active ? "text-white" : "text-gray-500 group-hover:text-gray-400"}`}>
            {icon}
        </div>
        {label}
    </button>
);
