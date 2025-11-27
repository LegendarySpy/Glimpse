import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
    X,
    Keyboard,
    Cpu,
    Cloud,
    HardDrive,
    Download,
    Trash2,
    Loader2,
    AlertCircle,
    ChevronRight,
    Info,
    User,
    Mic,
    ChevronDown,
} from "lucide-react";
import DotMatrix from "./DotMatrix";

type TranscriptionMode = "cloud" | "local";

type StoredSettings = {
    hold_shortcut: string;
    hold_enabled: boolean;
    toggle_shortcut: string;
    toggle_enabled: boolean;
    transcription_mode: TranscriptionMode;
    local_model: string;
    microphone_device: string | null;
    language: string;
};

type AppInfo = {
    version: string;
    data_dir_size_bytes: number;
    data_dir_path: string;
};

type ModelInfo = {
    key: string;
    label: string;
    description: string;
    size_mb: number;
    file_count: number;
    engine: string;
    variant: string;
    tags: string[];
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

type DeviceInfo = {
    id: string;
    name: string;
    is_default: boolean;
};

type DownloadEvent =
    | { status: "idle"; percent: number; downloaded: number; total: number; file?: string }
    | { status: "downloading"; percent: number; downloaded: number; total: number; file: string }
    | { status: "complete"; percent: number; downloaded: number; total: number }
    | { status: "error"; percent: number; downloaded: number; total: number; message: string };

const modifierOrder = ["Control", "Shift", "Alt", "Command"];

const languages = [
    { code: "en", name: "English" },
    { code: "es", name: "Spanish" },
    { code: "fr", name: "French" },
    { code: "de", name: "German" },
    { code: "it", name: "Italian" },
    { code: "pt", name: "Portuguese" },
    { code: "nl", name: "Dutch" },
    { code: "ru", name: "Russian" },
    { code: "zh", name: "Chinese" },
    { code: "ja", name: "Japanese" },
    { code: "ko", name: "Korean" },
];

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const SettingsModal = ({ isOpen, onClose }: SettingsModalProps) => {
    const [holdShortcut, setHoldShortcut] = useState("Control+Space");
    const [holdEnabled, setHoldEnabled] = useState(true);
    const [toggleShortcut, setToggleShortcut] = useState("Control+Shift+Space");
    const [toggleEnabled, setToggleEnabled] = useState(true);
    const [transcriptionMode, setTranscriptionMode] = useState<TranscriptionMode>("cloud");
    const [localModel, setLocalModel] = useState("parakeet_tdt_int8");
    const [microphoneDevice, setMicrophoneDevice] = useState<string | null>(null);
    const [language, setLanguage] = useState("en");
    const [inputDevices, setInputDevices] = useState<DeviceInfo[]>([]);
    const [modelCatalog, setModelCatalog] = useState<ModelInfo[]>([]);
    const [modelStatus, setModelStatus] = useState<Record<string, ModelStatus>>({});
    const [downloadState, setDownloadState] = useState<Record<string, DownloadEvent>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [captureActive, setCaptureActive] = useState<"hold" | "toggle" | null>(null);
    const pressedModifiers = useRef<Set<string>>(new Set());
    const primaryKey = useRef<string | null>(null);
    const [activeTab, setActiveTab] = useState<"general" | "models" | "about" | "account">("general");
    const [shortcutsExpanded, setShortcutsExpanded] = useState(false);
    const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

    useEffect(() => {
        if (transcriptionMode === "cloud" && activeTab === "models") {
            setActiveTab("general");
        }
    }, [transcriptionMode, activeTab]);

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
        if (isOpen) {
            const loadData = async () => {
                setLoading(true);
                try {
                    const settings = await invoke<StoredSettings>("get_settings");
                    setHoldShortcut(settings.hold_shortcut);
                    setHoldEnabled(settings.hold_enabled);
                    setToggleShortcut(settings.toggle_shortcut);
                    setToggleEnabled(settings.toggle_enabled);
                    setTranscriptionMode(settings.transcription_mode);
                    setLocalModel(settings.local_model);
                    setMicrophoneDevice(settings.microphone_device);
                    setLanguage(settings.language);
                } catch (err) {
                    console.error("Failed to load settings:", err);
                    setError("Failed to load settings");
                }

                try {
                    const devices = await invoke<DeviceInfo[]>("list_input_devices");
                    setInputDevices(devices);
                } catch (err) {
                    console.error("Failed to list input devices:", err);
                }

                try {
                    const models = await invoke<ModelInfo[]>("list_models");
                    setModelCatalog(models);
                    models.forEach((model) => refreshModelStatus(model.key));
                } catch (err) {
                    console.error("Failed to list models:", err);
                }
                setLoading(false);
            };
            loadData();
        }
    }, [isOpen, refreshModelStatus]);

    useEffect(() => {
        if (isOpen) {
            invoke<AppInfo>("get_app_info")
                .then((result) => {
                    setAppInfo(result);
                })
                .catch((err) => {
                    console.error("Failed to get app info:", err);
                });
        }
    }, [isOpen]);



    useEffect(() => {
        if (!isOpen) return;

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
    }, [isOpen, refreshModelStatus]);

    useEffect(() => {
        if (!captureActive) return;

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
            if (!primaryKey.current && pressedModifiers.current.size === 0) return;

            const combo = buildShortcut();
            if (combo) {
                if (captureActive === "hold") {
                    setHoldShortcut(combo);
                } else if (captureActive === "toggle") {
                    setToggleShortcut(combo);
                }
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

    useEffect(() => {
        if (!isOpen) return;
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !captureActive) onClose();
        };
        window.addEventListener("keydown", handleEscape);
        return () => window.removeEventListener("keydown", handleEscape);
    }, [isOpen, captureActive, onClose]);

    const finalizeCapture = () => {
        setCaptureActive(null);
        pressedModifiers.current.clear();
        primaryKey.current = null;
    };

    const buildShortcut = () => {
        if (!primaryKey.current) return null;
        const orderedMods = Array.from(pressedModifiers.current).sort(
            (a, b) => modifierOrder.indexOf(a) - modifierOrder.indexOf(b)
        );
        const formattedKey = formatKey(primaryKey.current);
        if (!formattedKey) return null;
        return [...orderedMods, formattedKey].join("+");
    };

    useEffect(() => {
        if (loading) return;

        const saveSettings = async () => {
            try {
                await invoke("update_settings", {
                    holdShortcut,
                    holdEnabled,
                    toggleShortcut,
                    toggleEnabled,
                    transcriptionMode,
                    localModel,
                    microphoneDevice,
                    language,
                });
                setError(null);
            } catch (err) {
                console.error(err);
                setError(String(err));
            }
        };

        saveSettings();
    }, [
        loading,
        holdShortcut,
        holdEnabled,
        toggleShortcut,
        toggleEnabled,
        transcriptionMode,
        localModel,
        microphoneDevice,
        language,
    ]);

    const handleDownload = async (modelKey: string) => {
        setDownloadState((prev) => ({
            ...prev,
            [modelKey]: { status: "downloading", percent: 0, downloaded: 0, total: 0, file: "starting" },
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

            // If deleting the active model, switch to another installed model
            if (localModel === modelKey) {
                const otherInstalledModel = modelCatalog.find(
                    (m) => m.key !== modelKey && modelStatus[m.key]?.installed
                );
                if (otherInstalledModel) {
                    setLocalModel(otherInstalledModel.key);
                }
                // If no other model is installed, keep the selection - the warning will show
            }

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

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        // Show 1 decimal place for GB and above, 0 for others
        const decimals = i >= 3 ? 1 : 0;
        return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i];
    };

    const backdropVariants = {
        hidden: { opacity: 0 },
        visible: { opacity: 1 },
    };

    const modalVariants = {
        hidden: { opacity: 0, scale: 0.97, y: 6 },
        visible: {
            opacity: 1,
            scale: 1,
            y: 0,
            transition: { type: "spring" as const, stiffness: 400, damping: 30 }
        },
        exit: {
            opacity: 0,
            scale: 0.97,
            y: 6,
            transition: { duration: 0.12 }
        },
    };

    const tabContentVariants = {
        hidden: { opacity: 0, x: 8 },
        visible: { opacity: 1, x: 0, transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const } },
        exit: { opacity: 0, x: -8, transition: { duration: 0.12 } },
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    className="fixed inset-0 z-50 flex items-center justify-center"
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                >
                    <motion.div
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        variants={backdropVariants}
                        onClick={onClose}
                    />

                    <motion.div
                        className="relative flex max-h-[80vh] h-[625px] w-[850px] overflow-hidden rounded-2xl border border-[#2a2a30] bg-[#161618] shadow-2xl shadow-black/50"
                        variants={modalVariants}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <motion.button
                            onClick={onClose}
                            className="absolute right-3 top-3 z-20 flex h-7 w-7 items-center justify-center rounded-lg text-[#6b6b76] hover:bg-[#1e1e22] hover:text-[#a0a0ab] transition-colors"
                            whileTap={{ scale: 0.95 }}
                        >
                            <X size={14} />
                        </motion.button>

                        {/* Sidebar */}
                        <aside className="flex w-44 flex-col border-r border-[#1e1e22] bg-[#111113]">
                            <div className="px-4 pt-5 pb-4">
                                <h2 className="text-[13px] font-semibold text-[#e8e8eb]">Settings</h2>
                            </div>
                            <nav className="flex-1 px-2 space-y-4">
                                {/* Account Section */}
                                <div className="space-y-1">
                                    <p className="px-2.5 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-[#4a4a54]">Account</p>
                                    <ModalNavItem
                                        icon={<User size={14} />}
                                        label="Account"
                                        active={activeTab === "account"}
                                        onClick={() => setActiveTab("account")}
                                    />
                                </div>

                                {/* General Section */}
                                <div className="space-y-1">
                                    <p className="px-2.5 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-[#4a4a54]">General</p>
                                    <ModalNavItem
                                        icon={<Keyboard size={14} />}
                                        label="General"
                                        active={activeTab === "general"}
                                        onClick={() => setActiveTab("general")}
                                    />
                                    <ModalNavItem
                                        icon={<Info size={14} />}
                                        label="About"
                                        active={activeTab === "about"}
                                        onClick={() => setActiveTab("about")}
                                    />
                                </div>

                                {/* Local Section - only when local mode */}
                                <AnimatePresence>
                                    {transcriptionMode === "local" && (
                                        <motion.div
                                            initial={{ opacity: 0, height: 0 }}
                                            animate={{ opacity: 1, height: "auto" }}
                                            exit={{ opacity: 0, height: 0 }}
                                            transition={{ duration: 0.15 }}
                                        >
                                            <p className="px-2.5 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-[#4a4a54]">Local</p>
                                            <ModalNavItem
                                                icon={<Cpu size={14} />}
                                                label="Models"
                                                active={activeTab === "models"}
                                                onClick={() => setActiveTab("models")}
                                            />
                                        </motion.div>
                                    )}
                                </AnimatePresence>

                            </nav>
                        </aside>

                        {/* Main Content */}
                        <main className="flex flex-1 flex-col bg-[#161618] overflow-hidden">
                            <div className="flex-1 overflow-y-auto p-6 settings-scroll">
                                <AnimatePresence mode="wait">
                                    {activeTab === "account" && (
                                        <motion.div
                                            key="account"
                                            variants={tabContentVariants}
                                            initial="hidden"
                                            animate="visible"
                                            exit="exit"
                                            className="space-y-4"
                                        >
                                            <header>
                                                <h1 className="text-lg font-medium text-[#e8e8eb]">Account</h1>
                                                <p className="mt-1 text-[12px] text-[#6b6b76]">Manage your account settings and preferences.</p>
                                            </header>

                                            <div className="rounded-xl border border-[#1e1e22] bg-[#111113] p-8 text-center">
                                                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#1a1a1e] border border-[#2a2a30]">
                                                    <User size={24} className="text-[#6b6b76]" />
                                                </div>
                                                <h3 className="text-[13px] font-medium text-[#e8e8eb]">Not Signed In</h3>
                                                <p className="mt-1 text-[11px] text-[#6b6b76]">Sign in to sync your settings and history.</p>
                                                <button className="mt-4 rounded-lg bg-[#e8e8eb] px-4 py-2 text-[12px] font-medium text-black hover:bg-white transition-colors">
                                                    Sign In
                                                </button>
                                            </div>
                                        </motion.div>
                                    )}

                                    {activeTab === "general" && (
                                        <motion.div
                                            key="general"
                                            variants={tabContentVariants}
                                            initial="hidden"
                                            animate="visible"
                                            exit="exit"
                                            className="space-y-5"
                                        >
                                            <header>
                                                <h1 className="text-lg font-medium text-[#e8e8eb]">General</h1>
                                                <p className="mt-1 text-[12px] text-[#6b6b76]">Configure your recording shortcuts and transcription engine.</p>
                                            </header>

                                            <div className="space-y-3">
                                                {/* Shortcuts Section - Collapsible */}
                                                <div className="rounded-xl border border-[#1e1e22] bg-[#111113] overflow-hidden">
                                                    <motion.button
                                                        onClick={() => setShortcutsExpanded(!shortcutsExpanded)}
                                                        className="w-full p-4 flex items-center justify-between hover:bg-[#1a1a1e] transition-colors"
                                                    >
                                                        <div className="flex items-center gap-3">
                                                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1a1a1e] border border-[#2a2a30]">
                                                                <Keyboard size={14} className="text-[#6b6b76]" />
                                                            </div>
                                                            <div className="text-left">
                                                                <h3 className="text-[13px] font-medium text-[#e8e8eb]">Shortcuts</h3>
                                                                <AnimatePresence initial={false}>
                                                                    {!shortcutsExpanded && (
                                                                        <motion.p
                                                                            initial={{ opacity: 0, height: 0, marginTop: 0 }}
                                                                            animate={{ opacity: 1, height: "auto", marginTop: 2 }}
                                                                            exit={{ opacity: 0, height: 0, marginTop: 0 }}
                                                                            className="text-[11px] text-[#6b6b76] font-mono block"
                                                                        >
                                                                            {holdEnabled ? `Hold: ${holdShortcut}` : ""}
                                                                            {holdEnabled && toggleEnabled ? " • " : ""}
                                                                            {toggleEnabled ? `Toggle: ${toggleShortcut}` : ""}
                                                                        </motion.p>
                                                                    )}
                                                                </AnimatePresence>
                                                            </div>
                                                        </div>
                                                        <motion.div
                                                            animate={{ rotate: shortcutsExpanded ? 90 : 0 }}
                                                            transition={{ duration: 0.2 }}
                                                        >
                                                            <ChevronRight size={16} className="text-[#6b6b76]" />
                                                        </motion.div>
                                                    </motion.button>

                                                    <AnimatePresence initial={false}>
                                                        {shortcutsExpanded && (
                                                            <motion.div
                                                                initial={{ height: 0, opacity: 0 }}
                                                                animate={{ height: "auto", opacity: 1 }}
                                                                exit={{ height: 0, opacity: 0 }}
                                                                transition={{
                                                                    type: "spring",
                                                                    stiffness: 400,
                                                                    damping: 35,
                                                                    mass: 0.8
                                                                }}
                                                                className="overflow-hidden"
                                                            >
                                                                <div className="px-4 pb-4 space-y-3 border-t border-[#1e1e22] pt-4">
                                                                    {/* Hold Shortcut */}
                                                                    <div className={`rounded-xl border p-4 transition-colors ${holdEnabled
                                                                        ? "border-[#1e1e22] bg-[#111113]"
                                                                        : "border-[#1e1e22]/50 bg-[#111113]/50"
                                                                        }`}>
                                                                        <div className="flex items-center justify-between">
                                                                            <div className="flex items-center gap-3">
                                                                                <div className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${holdEnabled
                                                                                    ? "bg-[#1a1a1e] border-[#2a2a30]"
                                                                                    : "bg-[#1a1a1e]/50 border-[#2a2a30]/50"
                                                                                    }`}>
                                                                                    <Keyboard size={14} className={holdEnabled ? "text-[#6b6b76]" : "text-[#4a4a54]"} />
                                                                                </div>
                                                                                <div>
                                                                                    <h3 className={`text-[13px] font-medium ${holdEnabled ? "text-[#e8e8eb]" : "text-[#6b6b76]"}`}>Hold Shortcut</h3>
                                                                                    <p className="text-[11px] text-[#4a4a54]">Hold to record, release to stop</p>
                                                                                </div>
                                                                            </div>
                                                                            <div className="flex items-center gap-2">
                                                                                <motion.button
                                                                                    onClick={() => {
                                                                                        if (!holdEnabled && !toggleEnabled) return;
                                                                                        setHoldEnabled(!holdEnabled);
                                                                                    }}
                                                                                    disabled={holdEnabled && !toggleEnabled}
                                                                                    className={`relative w-10 h-5 rounded-full transition-colors ${holdEnabled ? "bg-amber-400" : "bg-[#2a2a30]"
                                                                                        } ${holdEnabled && !toggleEnabled ? "opacity-50 cursor-not-allowed" : ""}`}
                                                                                    whileTap={!(holdEnabled && !toggleEnabled) ? { scale: 0.95 } : {}}
                                                                                >
                                                                                    <motion.div
                                                                                        className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm"
                                                                                        animate={{ left: holdEnabled ? "calc(100% - 18px)" : "2px" }}
                                                                                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                                                                                    />
                                                                                </motion.button>
                                                                                <motion.button
                                                                                    onClick={() => {
                                                                                        if (!holdEnabled) return;
                                                                                        pressedModifiers.current.clear();
                                                                                        primaryKey.current = null;
                                                                                        setCaptureActive("hold");
                                                                                        setError(null);
                                                                                    }}
                                                                                    disabled={!holdEnabled}
                                                                                    className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition-all ${captureActive === "hold"
                                                                                        ? "bg-amber-400 text-black"
                                                                                        : holdEnabled
                                                                                            ? "bg-[#1a1a1e] border border-[#2a2a30] text-[#a0a0ab] hover:bg-[#232328] hover:text-[#e8e8eb]"
                                                                                            : "bg-[#1a1a1e]/50 border border-[#2a2a30]/50 text-[#4a4a54] cursor-not-allowed"
                                                                                        }`}
                                                                                    whileTap={holdEnabled ? { scale: 0.97 } : {}}
                                                                                >
                                                                                    {captureActive === "hold" ? "Listening..." : "Change"}
                                                                                </motion.button>
                                                                            </div>
                                                                        </div>
                                                                        <motion.div
                                                                            className={`mt-3 inline-flex items-center rounded-lg border px-3 py-2 transition-colors ${holdEnabled
                                                                                ? "border-[#2a2a30] bg-[#1a1a1e]"
                                                                                : "border-[#2a2a30]/50 bg-[#1a1a1e]/50"
                                                                                }`}
                                                                            animate={captureActive === "hold" ? {
                                                                                borderColor: ["#2a2a30", "#fbbf24", "#2a2a30"]
                                                                            } : {}}
                                                                            transition={{ duration: 1.2, repeat: captureActive === "hold" ? Infinity : 0 }}
                                                                        >
                                                                            <span className={`font-mono text-[12px] ${holdEnabled ? "text-[#e8e8eb]" : "text-[#6b6b76]"}`}>{holdShortcut}</span>
                                                                        </motion.div>
                                                                    </div>

                                                                    {/* Toggle Shortcut */}
                                                                    <div className={`rounded-xl border p-4 transition-colors ${toggleEnabled
                                                                        ? "border-[#1e1e22] bg-[#111113]"
                                                                        : "border-[#1e1e22]/50 bg-[#111113]/50"
                                                                        }`}>
                                                                        <div className="flex items-center justify-between">
                                                                            <div className="flex items-center gap-3">
                                                                                <div className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${toggleEnabled
                                                                                    ? "bg-[#1a1a1e] border-[#2a2a30]"
                                                                                    : "bg-[#1a1a1e]/50 border-[#2a2a30]/50"
                                                                                    }`}>
                                                                                    <Keyboard size={14} className={toggleEnabled ? "text-[#6b6b76]" : "text-[#4a4a54]"} />
                                                                                </div>
                                                                                <div>
                                                                                    <h3 className={`text-[13px] font-medium ${toggleEnabled ? "text-[#e8e8eb]" : "text-[#6b6b76]"}`}>Toggle Shortcut</h3>
                                                                                    <p className="text-[11px] text-[#4a4a54]">Press to start, press again to stop</p>
                                                                                </div>
                                                                            </div>
                                                                            <div className="flex items-center gap-2">
                                                                                <motion.button
                                                                                    onClick={() => {
                                                                                        if (!toggleEnabled && !holdEnabled) return;
                                                                                        setToggleEnabled(!toggleEnabled);
                                                                                    }}
                                                                                    disabled={toggleEnabled && !holdEnabled}
                                                                                    className={`relative w-10 h-5 rounded-full transition-colors ${toggleEnabled ? "bg-amber-400" : "bg-[#2a2a30]"
                                                                                        } ${toggleEnabled && !holdEnabled ? "opacity-50 cursor-not-allowed" : ""}`}
                                                                                    whileTap={!(toggleEnabled && !holdEnabled) ? { scale: 0.95 } : {}}
                                                                                >
                                                                                    <motion.div
                                                                                        className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm"
                                                                                        animate={{ left: toggleEnabled ? "calc(100% - 18px)" : "2px" }}
                                                                                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                                                                                    />
                                                                                </motion.button>
                                                                                <motion.button
                                                                                    onClick={() => {
                                                                                        if (!toggleEnabled) return;
                                                                                        pressedModifiers.current.clear();
                                                                                        primaryKey.current = null;
                                                                                        setCaptureActive("toggle");
                                                                                        setError(null);
                                                                                    }}
                                                                                    disabled={!toggleEnabled}
                                                                                    className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition-all ${captureActive === "toggle"
                                                                                        ? "bg-amber-400 text-black"
                                                                                        : toggleEnabled
                                                                                            ? "bg-[#1a1a1e] border border-[#2a2a30] text-[#a0a0ab] hover:bg-[#232328] hover:text-[#e8e8eb]"
                                                                                            : "bg-[#1a1a1e]/50 border border-[#2a2a30]/50 text-[#4a4a54] cursor-not-allowed"
                                                                                        }`}
                                                                                    whileTap={toggleEnabled ? { scale: 0.97 } : {}}
                                                                                >
                                                                                    {captureActive === "toggle" ? "Listening..." : "Change"}
                                                                                </motion.button>
                                                                            </div>
                                                                        </div>
                                                                        <motion.div
                                                                            className={`mt-3 inline-flex items-center rounded-lg border px-3 py-2 transition-colors ${toggleEnabled
                                                                                ? "border-[#2a2a30] bg-[#1a1a1e]"
                                                                                : "border-[#2a2a30]/50 bg-[#1a1a1e]/50"
                                                                                }`}
                                                                            animate={captureActive === "toggle" ? {
                                                                                borderColor: ["#2a2a30", "#fbbf24", "#2a2a30"]
                                                                            } : {}}
                                                                            transition={{ duration: 1.2, repeat: captureActive === "toggle" ? Infinity : 0 }}
                                                                        >
                                                                            <span className={`font-mono text-[12px] ${toggleEnabled ? "text-[#e8e8eb]" : "text-[#6b6b76]"}`}>{toggleShortcut}</span>
                                                                        </motion.div>
                                                                    </div>
                                                                </div>
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </div>

                                                {/* Audio Section */}
                                                <div className="rounded-xl border border-[#1e1e22] bg-[#111113] p-4 space-y-4">
                                                    <div className="flex items-center gap-3 mb-2">
                                                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1a1a1e] border border-[#2a2a30]">
                                                            <Mic size={14} className="text-[#6b6b76]" />
                                                        </div>
                                                        <div>
                                                            <h3 className="text-[13px] font-medium text-[#e8e8eb]">Audio & Language</h3>
                                                            <p className="text-[11px] text-[#6b6b76]">Configure input device and transcription language.</p>
                                                        </div>
                                                    </div>

                                                    <div className="grid grid-cols-2 gap-4">
                                                        <div className="space-y-1.5">
                                                            <label className="text-[11px] font-medium text-[#6b6b76] ml-1">Microphone</label>
                                                            <div className="relative">
                                                                <select
                                                                    value={microphoneDevice || ""}
                                                                    onChange={(e) => setMicrophoneDevice(e.target.value || null)}
                                                                    className="w-full appearance-none rounded-lg bg-[#1a1a1e] border border-[#2a2a30] py-2 pl-3 pr-8 text-[12px] text-[#e8e8eb] focus:border-[#4a4a54] focus:outline-none transition-colors"
                                                                >
                                                                    <option value="">Default System Device</option>
                                                                    {inputDevices.map((device) => (
                                                                        <option key={device.id} value={device.id}>
                                                                            {device.name} {device.is_default ? "(Default)" : ""}
                                                                        </option>
                                                                    ))}
                                                                </select>
                                                                <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6b6b76]">
                                                                    <ChevronDown size={12} />
                                                                </div>
                                                            </div>
                                                        </div>

                                                        <div className="space-y-1.5">
                                                            <label className="text-[11px] font-medium text-[#6b6b76] ml-1">Language</label>
                                                            <div className="relative">
                                                                <select
                                                                    value={language}
                                                                    onChange={(e) => setLanguage(e.target.value)}
                                                                    className="w-full appearance-none rounded-lg bg-[#1a1a1e] border border-[#2a2a30] py-2 pl-3 pr-8 text-[12px] text-[#e8e8eb] focus:border-[#4a4a54] focus:outline-none transition-colors"
                                                                >
                                                                    {languages.map((lang) => (
                                                                        <option key={lang.code} value={lang.code}>
                                                                            {lang.name}
                                                                        </option>
                                                                    ))}
                                                                </select>
                                                                <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6b6b76]">
                                                                    <ChevronDown size={12} />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Transcription Mode Section */}

                                                {/* Transcription Mode */}
                                                <motion.div
                                                    layout
                                                    transition={{ type: "spring", stiffness: 400, damping: 35 }}
                                                    className="rounded-xl border border-[#1e1e22] bg-[#111113] p-4"
                                                >
                                                    <div className="flex items-center gap-3 mb-4">
                                                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1a1a1e] border border-[#2a2a30]">
                                                            {transcriptionMode === "cloud" ? (
                                                                <Cloud size={14} className="text-[#6b6b76]" />
                                                            ) : (
                                                                <HardDrive size={14} className="text-[#6b6b76]" />
                                                            )}
                                                        </div>
                                                        <div>
                                                            <h3 className="text-[13px] font-medium text-[#e8e8eb]">Transcription Engine</h3>
                                                            <p className="text-[11px] text-[#4a4a54]">Choose how your audio is processed</p>
                                                        </div>
                                                    </div>
                                                    <div className="grid grid-cols-2 gap-2">
                                                        <ModeButton
                                                            icon={<Cloud size={16} />}
                                                            label="Cloud"
                                                            description="Fast & lightweight"
                                                            active={transcriptionMode === "cloud"}
                                                            onClick={() => setTranscriptionMode("cloud")}
                                                        />
                                                        <ModeButton
                                                            icon={<HardDrive size={16} />}
                                                            label="Local"
                                                            description="Private & offline"
                                                            active={transcriptionMode === "local"}
                                                            onClick={() => setTranscriptionMode("local")}
                                                        />
                                                    </div>

                                                    {/* Warning when local mode enabled but model not installed */}
                                                    <AnimatePresence>
                                                        {transcriptionMode === "local" && !modelStatus[localModel]?.installed && (
                                                            <motion.div
                                                                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                                                                animate={{ opacity: 1, height: "auto", marginTop: 12 }}
                                                                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                                                                transition={{ duration: 0.2 }}
                                                                className="overflow-hidden"
                                                            >
                                                                <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                                                                    <AlertCircle size={14} className="text-amber-400 shrink-0 mt-0.5" />
                                                                    <div className="flex-1 min-w-0">
                                                                        <p className="text-[11px] font-medium text-amber-400">No model installed</p>
                                                                        <p className="text-[10px] text-amber-400/70 mt-0.5">
                                                                            Download a model from the <button
                                                                                onClick={() => setActiveTab("models")}
                                                                                className="underline hover:text-amber-300 transition-colors"
                                                                            >Models</button> tab to use local transcription.
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </motion.div>
                                            </div>

                                            {/* Error Display */}
                                            <AnimatePresence>
                                                {error && (
                                                    <motion.div
                                                        initial={{ opacity: 0, height: 0 }}
                                                        animate={{ opacity: 1, height: "auto" }}
                                                        exit={{ opacity: 0, height: 0 }}
                                                        className="pt-4 border-t border-[#1e1e22]"
                                                    >
                                                        <p className="flex items-center gap-1.5 text-[11px] text-red-400">
                                                            <AlertCircle size={12} />
                                                            {error}
                                                        </p>
                                                    </motion.div>
                                                )}
                                            </AnimatePresence>
                                        </motion.div>
                                    )}

                                    {activeTab === "models" && (
                                        <motion.div
                                            key="models"
                                            variants={tabContentVariants}
                                            initial="hidden"
                                            animate="visible"
                                            exit="exit"
                                            className="space-y-4"
                                        >
                                            <header>
                                                <h1 className="text-lg font-medium text-[#e8e8eb]">Local Models</h1>
                                                <p className="mt-1 text-[12px] text-[#6b6b76]">Download and manage offline transcription engines.</p>
                                            </header>

                                            <div className="space-y-2">
                                                {modelCatalog.map((model, index) => {
                                                    const modelStat = modelStatus[model.key];
                                                    const progress = downloadState[model.key];
                                                    const installed = modelStat?.installed;
                                                    // Only show as active if it's both selected AND installed
                                                    const isActive = localModel === model.key && installed;
                                                    const isDownloading = progress?.status === "downloading";
                                                    const showError = progress?.status === "error";
                                                    const percent = progress?.percent ?? (installed ? 100 : 0);

                                                    return (
                                                        <motion.div
                                                            key={model.key}
                                                            initial={{ opacity: 0, y: 6 }}
                                                            animate={{ opacity: 1, y: 0 }}
                                                            transition={{ delay: index * 0.04 }}
                                                            className={`rounded-xl border p-4 transition-colors ${isActive
                                                                ? "border-amber-400/30 bg-amber-400/[0.04]"
                                                                : "border-[#1e1e22] bg-[#111113] hover:border-[#2a2a30]"
                                                                }`}
                                                        >
                                                            <div className="flex items-start justify-between gap-3">
                                                                <div className="flex-1 min-w-0">
                                                                    <div className="flex items-center gap-2">
                                                                        <h3 className="text-[13px] font-medium text-[#e8e8eb]">{model.label}</h3>
                                                                        {isActive && (
                                                                            <span className="px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider bg-amber-400/20 text-amber-400">Active</span>
                                                                        )}
                                                                    </div>
                                                                    <div className="flex flex-wrap gap-1.5 mt-1 mb-1.5">
                                                                        {model.tags.map(tag => (
                                                                            <span key={tag} className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-[#1a1a1e] text-[#6b6b76] border border-[#2a2a30]">
                                                                                {tag}
                                                                            </span>
                                                                        ))}
                                                                    </div>
                                                                    <p className="text-[11px] text-[#6b6b76] line-clamp-1">{model.description}</p>
                                                                    <div className="mt-2 flex items-center gap-2">

                                                                        <span className="text-[10px] text-[#4a4a54]">{model.variant}</span>
                                                                        <span className="text-[10px] text-[#4a4a54]">•</span>
                                                                        <span className="text-[10px] text-[#4a4a54]">{formatBytes(model.size_mb * 1024 * 1024)}</span>
                                                                    </div>
                                                                </div>
                                                                <div className="flex shrink-0 items-center gap-2">
                                                                    {installed && !isActive && (
                                                                        <motion.button
                                                                            onClick={() => setLocalModel(model.key)}
                                                                            className="rounded-lg bg-[#1a1a1e] border border-[#2a2a30] px-3 py-1.5 text-[10px] font-medium text-[#a0a0ab] hover:bg-[#232328] hover:text-[#e8e8eb] transition-colors"
                                                                            whileTap={{ scale: 0.97 }}
                                                                        >
                                                                            Use
                                                                        </motion.button>
                                                                    )}
                                                                    <motion.button
                                                                        onClick={() => (installed ? handleDelete(model.key) : handleDownload(model.key))}
                                                                        disabled={isDownloading}
                                                                        className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${installed
                                                                            ? "border-red-500/20 text-red-400 hover:bg-red-500/10"
                                                                            : "border-[#2a2a30] text-[#6b6b76] hover:bg-[#1a1a1e] hover:text-[#a0a0ab]"
                                                                            } ${isDownloading ? "opacity-50 cursor-wait" : ""}`}
                                                                        whileTap={!isDownloading ? { scale: 0.95 } : {}}
                                                                    >
                                                                        {isDownloading ? (
                                                                            <Loader2 size={12} className="animate-spin" />
                                                                        ) : installed ? (
                                                                            <Trash2 size={12} />
                                                                        ) : (
                                                                            <Download size={12} />
                                                                        )}
                                                                    </motion.button>
                                                                </div>
                                                            </div>

                                                            {/* Progress bar - 3 rows tall, only when downloading or not installed */}
                                                            {(isDownloading || !installed) && (
                                                                <div className="mt-3">
                                                                    <ModelProgress percent={percent} status={progress?.status ?? "idle"} />
                                                                    {isDownloading && (
                                                                        <p className="mt-1.5 text-[10px] text-[#6b6b76] tabular-nums">
                                                                            Downloading... {progress?.percent?.toFixed(0)}%
                                                                        </p>
                                                                    )}
                                                                    {showError && (
                                                                        <p className="mt-1.5 text-[10px] text-red-400 flex items-center gap-1">
                                                                            <AlertCircle size={10} />
                                                                            {(progress as Extract<DownloadEvent, { status: "error" }>).message}
                                                                        </p>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </motion.div>
                                                    );
                                                })}
                                            </div>
                                        </motion.div>
                                    )}

                                    {activeTab === "about" && (
                                        <motion.div
                                            key="about"
                                            variants={tabContentVariants}
                                            initial="hidden"
                                            animate="visible"
                                            exit="exit"
                                            className="space-y-4"
                                        >
                                            <header>
                                                <h1 className="text-lg font-medium text-[#e8e8eb]">About Glimpse</h1>
                                                <p className="mt-1 text-[12px] text-[#6b6b76]">Application information and details.</p>
                                            </header>

                                            <div className="space-y-2">
                                                <AboutItem
                                                    label="Version"
                                                    value={appInfo?.version ?? "Loading..."}
                                                />
                                                <AboutItem
                                                    label="Data Directory Size"
                                                    value={appInfo ? formatBytes(appInfo.data_dir_size_bytes) : "Loading..."}
                                                />
                                                <AboutItem
                                                    label="Data Directory"
                                                    value={appInfo?.data_dir_path ?? "Loading..."}
                                                    mono
                                                />
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </main>
                    </motion.div>
                </motion.div>
            )
            }
        </AnimatePresence >
    );

    function normalizeModifier(event: KeyboardEvent): string | null {
        if (event.key === "Control" || event.code === "ControlLeft" || event.code === "ControlRight") return "Control";
        if (event.key === "Shift" || event.code === "ShiftLeft" || event.code === "ShiftRight") return "Shift";
        if (event.key === "Alt" || event.key === "Option") return "Alt";
        if (event.key === "Meta") return "Command";
        return null;
    }

    function formatKey(code: string): string | null {
        if (!code) return null;
        if (code.startsWith("Key") && code.length > 3) return code.slice(3).toUpperCase();
        if (code.startsWith("Digit") && code.length > 5) return code.slice(5);
        const namedKeys: Record<string, string> = {
            Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace",
            Escape: "Escape", Delete: "Delete", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
            ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Backquote: "`", Minus: "-",
            Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
            Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
        };
        return namedKeys[code] ?? code;
    }
};

const ModalNavItem = ({ icon, label, active, onClick }: {
    icon: React.ReactNode; label: string; active: boolean; onClick: () => void;
}) => (
    <motion.button
        onClick={onClick}
        className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] font-medium transition-all ${active ? "bg-[#1a1a1e] text-[#e8e8eb]" : "text-[#6b6b76] hover:bg-[#1a1a1e] hover:text-[#a0a0ab]"
            }`}
        whileTap={{ scale: 0.98 }}
    >
        <div className={active ? "text-amber-400/80" : "text-[#4a4a54]"}>{icon}</div>
        {label}
    </motion.button>
);

const ModeButton = ({ icon, label, description, active, onClick }: {
    icon: React.ReactNode; label: string; description: string; active: boolean; onClick: () => void;
}) => (
    <motion.button
        onClick={onClick}
        className={`rounded-xl border p-3 text-left transition-all ${active
            ? "border-amber-400/40 bg-amber-400/10"
            : "border-[#2a2a30] bg-[#1a1a1e] hover:border-[#3a3a42]"
            }`}
        whileTap={{ scale: 0.98 }}
    >
        <div className={`mb-1.5 ${active ? "text-amber-400" : "text-[#6b6b76]"}`}>{icon}</div>
        <div className={`text-[12px] font-medium ${active ? "text-[#e8e8eb]" : "text-[#a0a0ab]"}`}>{label}</div>
        <div className={`text-[10px] ${active ? "text-amber-400/60" : "text-[#4a4a54]"}`}>{description}</div>
    </motion.button>
);

const ModelProgress = ({ percent, status }: { percent: number; status: string }) => {
    const cols = 50;
    const rows = 3; // 3 dots tall as requested
    const totalDots = cols * rows;
    const activeCount = Math.round((percent / 100) * totalDots);

    // Fill row by row for a nicer effect
    const activeDots = useMemo(() => {
        const dots: number[] = [];
        for (let i = 0; i < activeCount && i < totalDots; i++) {
            dots.push(i);
        }
        return dots;
    }, [activeCount, totalDots]);

    const color = status === "error" ? "#f87171" : status === "complete" ? "#4ade80" : "#fbbf24";

    return (
        <DotMatrix
            rows={rows}
            cols={cols}
            activeDots={activeDots}
            dotSize={3}
            gap={2}
            color={color}
            className="opacity-70"
        />
    );
}; const AboutItem = ({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) => (
    <div className="rounded-xl border border-[#1e1e22] bg-[#111113] p-4">
        <div className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-medium uppercase tracking-wider text-[#4a4a54]">{label}</h3>
            <p className={`text-[12px] text-[#e8e8eb] ${mono ? "font-mono text-[11px]" : ""} break-all`}>
                {value}
            </p>
        </div>
    </div>
);

export default SettingsModal;
