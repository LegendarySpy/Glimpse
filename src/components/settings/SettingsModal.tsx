import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
    checkAccessibilityPermission,
    checkMicrophonePermission,
    requestAccessibilityPermission,
} from "tauri-plugin-macos-permissions-api";
import {
    X,
    Keyboard,
    Cpu,
    Download,
    Trash2,
    Loader2,
    AlertCircle,
    Info,
    User,
    Server,
    Key,
    Github,
    Square,
    Mail,
    Sliders,
    Check,
    Eye,
    EyeOff,
    Copy,
    Bug,
} from "lucide-react";
import DotMatrix from "../DotMatrix";
import AccountView from "./AccountView";
import FAQModal from "../FAQModal";
import { UpdateChecker } from "./UpdateChecker";
import DebugSection from "./DebugSection";
import { logout, getOAuth2Url, login, createAccount, type User as AppwriteUser } from "../../lib/auth";
import WhatsNewModal from "./WhatsNewModal";
import { Dropdown } from "../Dropdown";

import { OAuthProvider } from "appwrite";


type TranscriptionMode = "cloud" | "local";
type LlmProvider = "none" | "lmstudio" | "ollama" | "openai" | "custom";

type StoredSettings = {
    smart_shortcut: string;
    smart_enabled: boolean;
    hold_shortcut: string;
    hold_enabled: boolean;
    toggle_shortcut: string;
    toggle_enabled: boolean;
    transcription_mode: TranscriptionMode;
    local_model: string;
    microphone_device: string | null;
    language: string;
    llm_cleanup_enabled: boolean;
    llm_provider: LlmProvider;
    llm_endpoint: string;
    llm_api_key: string;
    llm_model: string;
    user_context: string;
    dictionary: string[];
    edit_mode_enabled: boolean;
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
    | { status: "cancelled"; percent: number; downloaded: number; total: number }
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
    initialTab?: "general" | "account" | "models" | "about";
    currentUser: AppwriteUser | null;
    onUpdateUser: () => Promise<void>;
    transcriptionMode: TranscriptionMode;
}

const SettingsModal = ({
    isOpen,
    onClose,
    initialTab = "general",
    currentUser,
    onUpdateUser,
    transcriptionMode: initialTranscriptionMode,
}: SettingsModalProps) => {
    const [smartShortcut, setSmartShortcut] = useState("Control+Space");
    const [smartEnabled, setSmartEnabled] = useState(true);
    const [holdShortcut, setHoldShortcut] = useState("Control+Shift+Space");
    const [holdEnabled, setHoldEnabled] = useState(false);
    const [toggleShortcut, setToggleShortcut] = useState("Control+Alt+Space");
    const [toggleEnabled, setToggleEnabled] = useState(false);
    const [transcriptionMode, setTranscriptionMode] = useState<TranscriptionMode>(initialTranscriptionMode);
    const [localModel, setLocalModel] = useState("parakeet_tdt_int8");
    const [microphoneDevice, setMicrophoneDevice] = useState<string | null>(null);
    const [language, setLanguage] = useState("en");
    const [inputDevices, setInputDevices] = useState<DeviceInfo[]>([]);
    const [modelCatalog, setModelCatalog] = useState<ModelInfo[]>([]);
    const [modelStatus, setModelStatus] = useState<Record<string, ModelStatus>>({});
    const [downloadState, setDownloadState] = useState<Record<string, DownloadEvent>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [authErrorCopied, setAuthErrorCopied] = useState(false);
    const [errorCopied, setErrorCopied] = useState(false);
    const [captureActive, setCaptureActive] = useState<"smart" | "hold" | "toggle" | null>(null);
    const [capturePreview, setCapturePreview] = useState<string>("");
    const pressedModifiers = useRef<Set<string>>(new Set());
    const primaryKey = useRef<string | null>(null);
    const [activeTab, setActiveTab] = useState<"general" | "models" | "about" | "account" | "advanced" | "developer">("general");
    const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
    const [llmCleanupEnabled, setLlmCleanupEnabled] = useState(false);
    const [llmProvider, setLlmProvider] = useState<LlmProvider>("none");
    const [llmEndpoint, setLlmEndpoint] = useState("");
    const [llmApiKey, setLlmApiKey] = useState("");
    const [llmModel, setLlmModel] = useState("");
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [editModeEnabled, setEditModeEnabled] = useState(false);

    const [authLoading, setAuthLoading] = useState(false);
    const [authError, setAuthError] = useState<string | null>(null);
    const [showEmailForm, setShowEmailForm] = useState(false);
    const [showFAQModal, setShowFAQModal] = useState(false);
    const [showNewAccountConfirm, setShowNewAccountConfirm] = useState(false);
    const [pendingAuth, setPendingAuth] = useState<{ email: string; password: string } | null>(null);
    const [micPermission, setMicPermission] = useState<boolean | null>(null);
    const [accessibilityPermission, setAccessibilityPermission] = useState<boolean | null>(null);
    const [authEmail, setAuthEmail] = useState("");
    const [authPassword, setAuthPassword] = useState("");
    const [authShowPassword, setAuthShowPassword] = useState(false);
    const [whatsNewOpen, setWhatsNewOpen] = useState(false);

    const isSubscriber = currentUser?.labels?.includes("subscriber") ?? false;
    const isDeveloper = currentUser?.labels?.includes("dev") ?? false;

    const [cloudSyncEnabled, setCloudSyncEnabled] = useState(() => {
        const stored = localStorage.getItem("glimpse_cloud_sync_enabled");
        return stored !== null ? stored === "true" : false;
    });

    useEffect(() => {
        // Only disable cloud sync if we have a user but they're not a subscriber
        // Don't disable if currentUser is null (still loading)
        if (currentUser && !isSubscriber && cloudSyncEnabled) {
            setCloudSyncEnabled(false);
        }
    }, [currentUser, isSubscriber, cloudSyncEnabled]);

    useEffect(() => {
        if (isOpen && initialTab) {
            setActiveTab(initialTab);
        }
    }, [isOpen, initialTab]);

    useEffect(() => {
        localStorage.setItem("glimpse_cloud_sync_enabled", String(cloudSyncEnabled));
        emit("auth:changed").catch(() => { });
    }, [cloudSyncEnabled]);

    useEffect(() => {
        let unlisten: (() => void) | undefined;

        listen("open_whats_new", () => {
            setWhatsNewOpen(true);
        }).then((fn) => {
            unlisten = fn;
        });

        return () => {
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        if (activeTab === "advanced" && isOpen) {
            const checkPermissions = async () => {
                try {
                    const nativeMic = await checkMicrophonePermission();
                    if (nativeMic) {
                        setMicPermission(true);
                    } else {
                        try {
                            const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
                            setMicPermission(result.state === 'granted');
                        } catch {
                            setMicPermission(false);
                        }
                    }
                } catch {
                    setMicPermission(false);
                }
                try {
                    const acc = await checkAccessibilityPermission();
                    setAccessibilityPermission(acc);
                } catch {
                    setAccessibilityPermission(false);
                }
            };
            checkPermissions();
            const interval = setInterval(checkPermissions, 1500);
            return () => clearInterval(interval);
        }
    }, [activeTab, isOpen]);

    const handleOpenDataDir = useCallback(async () => {
        if (!appInfo?.data_dir_path) return;
        try {
            await invoke("open_data_dir", { path: appInfo.data_dir_path });
        } catch (err) {
            console.error("Failed to open data directory:", err);
        }
    }, [appInfo?.data_dir_path]);

    useEffect(() => {
        if (transcriptionMode === "cloud" && activeTab === "models") {
            setActiveTab("general");
        }
    }, [transcriptionMode, activeTab]);

    useEffect(() => {
        const unlistenPromise = listen<StoredSettings>("settings:changed", (event) => {
            const settings = event.payload;
            if (!settings) return;
            setSmartShortcut(settings.smart_shortcut);
            setSmartEnabled(settings.smart_enabled);
            setHoldShortcut(settings.hold_shortcut);
            setHoldEnabled(settings.hold_enabled);
            setToggleShortcut(settings.toggle_shortcut);
            setToggleEnabled(settings.toggle_enabled);
            setTranscriptionMode(settings.transcription_mode);
            setLocalModel(settings.local_model);
            setMicrophoneDevice(settings.microphone_device);
            setLanguage(settings.language);
            setLlmCleanupEnabled(settings.llm_cleanup_enabled ?? false);
            setLlmProvider(settings.llm_provider ?? "none");
            setLlmEndpoint(settings.llm_endpoint ?? "");
            setLlmApiKey(settings.llm_api_key ?? "");
            setLlmModel(settings.llm_model ?? "");
            setEditModeEnabled(settings.edit_mode_enabled ?? false);
        });

        return () => {
            unlistenPromise.then((unlisten) => unlisten()).catch(() => { });
        };
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
        if (isOpen) {
            const loadData = async () => {
                setLoading(true);
                try {
                    const settings = await invoke<StoredSettings>("get_settings");
                    setSmartShortcut(settings.smart_shortcut);
                    setSmartEnabled(settings.smart_enabled);
                    setHoldShortcut(settings.hold_shortcut);
                    setHoldEnabled(settings.hold_enabled);
                    setToggleShortcut(settings.toggle_shortcut);
                    setToggleEnabled(settings.toggle_enabled);
                    setTranscriptionMode(settings.transcription_mode);
                    setLocalModel(settings.local_model);
                    setMicrophoneDevice(settings.microphone_device);
                    setLanguage(settings.language);
                    setLlmCleanupEnabled(settings.llm_cleanup_enabled ?? false);
                    setLlmProvider(settings.llm_provider ?? "none");
                    setLlmEndpoint(settings.llm_endpoint ?? "");
                    setLlmApiKey(settings.llm_api_key ?? "");
                    setLlmModel(settings.llm_model ?? "");
                    setEditModeEnabled(settings.edit_mode_enabled ?? false);
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


    const handleSignOut = async () => {
        setAuthLoading(true);
        try {
            await logout();
            await onUpdateUser();
        } catch (err) {
            setAuthError(err instanceof Error ? err.message : "Sign out failed");
        } finally {
            setAuthLoading(false);
        }
    };

    const handleCancelAuth = () => {
        setAuthLoading(false);
        setAuthError(null);
        setShowEmailForm(false);
    };

    const fetchAvailableModels = useCallback(async () => {
        try {
            const models = await invoke<string[]>("fetch_llm_models", {
                endpoint: llmEndpoint,
                provider: llmProvider,
                apiKey: llmApiKey,
            });
            setAvailableModels(models);
        } catch {
            setAvailableModels([]);
        }
    }, [llmEndpoint, llmProvider, llmApiKey]);


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
                if (error.toLowerCase().includes("cancelled")) return;
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
        if (!captureActive) {
            setCapturePreview("");
            return;
        }

        const updatePreview = () => {
            const mods = Array.from(pressedModifiers.current).sort(
                (a, b) => ["Control", "Alt", "Shift", "Command"].indexOf(a) - ["Control", "Alt", "Shift", "Command"].indexOf(b)
            );
            const key = primaryKey.current ? formatKey(primaryKey.current) : null;
            const parts = [...mods, key].filter(Boolean);
            setCapturePreview(parts.length > 0 ? parts.join("+") : "");
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            event.preventDefault();
            const modifier = normalizeModifier(event);
            if (modifier) {
                pressedModifiers.current.add(modifier);
            } else if (event.code) {
                primaryKey.current = event.code;
            }
            updatePreview();
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            event.preventDefault();
            if (!primaryKey.current && pressedModifiers.current.size === 0) return;

            const combo = buildShortcut();
            if (combo) {
                if (captureActive === "smart") {
                    setSmartShortcut(combo);
                } else if (captureActive === "hold") {
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
                    smartShortcut,
                    smartEnabled,
                    holdShortcut,
                    holdEnabled,
                    toggleShortcut,
                    toggleEnabled,
                    transcriptionMode,
                    localModel,
                    microphoneDevice,
                    language,
                    llmCleanupEnabled,
                    llmProvider,
                    llmEndpoint,
                    llmApiKey,
                    llmModel,
                    userContext: "",
                    editModeEnabled,
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
        smartShortcut,
        smartEnabled,
        holdShortcut,
        holdEnabled,
        toggleShortcut,
        toggleEnabled,
        transcriptionMode,
        localModel,
        microphoneDevice,
        language,
        llmCleanupEnabled,
        llmProvider,
        llmEndpoint,
        llmApiKey,
        llmModel,
        editModeEnabled,
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
            const errorMsg = String(err);
            if (errorMsg.toLowerCase().includes("cancelled")) {
                return;
            }
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

            if (localModel === modelKey) {
                const otherInstalledModel = modelCatalog.find(
                    (m) => m.key !== modelKey && modelStatus[m.key]?.installed
                );
                if (otherInstalledModel) {
                    setLocalModel(otherInstalledModel.key);
                }
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

    const handleCancelDownload = async (modelKey: string) => {
        try {
            await invoke("cancel_download", { model: modelKey });
            setDownloadState((prev) => ({ ...prev, [modelKey]: { status: "cancelled", percent: 0, downloaded: 0, total: 0 } }));
            // Auto-clear after brief display
            setTimeout(() => {
                setDownloadState((prev) => {
                    if (prev[modelKey]?.status === "cancelled") {
                        return { ...prev, [modelKey]: { status: "idle", percent: 0, downloaded: 0, total: 0 } };
                    }
                    return prev;
                });
            }, 1500);
        } catch (err) {
            console.error("Failed to cancel download:", err);
        }
    };

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
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
                        className="relative flex max-h-[80vh] h-[625px] w-[850px] overflow-hidden rounded-2xl border border-border-secondary bg-surface-overlay shadow-2xl shadow-black/50"
                        variants={modalVariants}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <motion.button
                            onClick={onClose}
                            className="absolute right-2 top-3 z-20 flex h-7 w-7 items-center justify-center rounded-lg text-content-muted hover:bg-surface-elevated hover:text-content-secondary transition-colors"
                            whileTap={{ scale: 0.95 }}
                        >
                            <X size={14} />
                        </motion.button>
                        <aside className="flex w-44 flex-col border-r border-border-primary bg-surface-surface">
                            <div className="px-4 pt-5 pb-4">
                                <h2 className="text-[13px] font-semibold text-content-primary">Settings</h2>
                            </div>
                            <nav className="flex-1 px-2 space-y-4">
                                <div className="space-y-1">
                                    <p className="px-2.5 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-content-disabled">Account</p>
                                    <ModalNavItem
                                        icon={<User size={14} />}
                                        label="Account"
                                        active={activeTab === "account"}
                                        onClick={() => setActiveTab("account")}
                                    />
                                </div>

                                <div className="space-y-1">
                                    <p className="px-2.5 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-content-disabled">General</p>
                                    <ModalNavItem
                                        icon={<Keyboard size={14} />}
                                        label="General"
                                        active={activeTab === "general"}
                                        onClick={() => setActiveTab("general")}
                                    />
                                    <ModalNavItem
                                        icon={<Sliders size={14} />}
                                        label="Advanced"
                                        active={activeTab === "advanced"}
                                        onClick={() => setActiveTab("advanced")}
                                    />
                                    <ModalNavItem
                                        icon={<Info size={14} />}
                                        label="About"
                                        active={activeTab === "about"}
                                        onClick={() => setActiveTab("about")}
                                    />
                                </div>

                                <AnimatePresence>
                                    {!loading && transcriptionMode === "local" && (
                                        <motion.div
                                            initial={{ opacity: 0, height: 0 }}
                                            animate={{ opacity: 1, height: "auto" }}
                                            exit={{ opacity: 0, height: 0 }}
                                            transition={{ duration: 0.15 }}
                                        >
                                            <p className="px-2.5 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-content-disabled">Local</p>
                                            <ModalNavItem
                                                icon={<Cpu size={14} />}
                                                label="Models"
                                                active={activeTab === "models"}
                                                onClick={() => setActiveTab("models")}
                                            />
                                        </motion.div>
                                    )}
                                </AnimatePresence>

                                {isDeveloper && (
                                    <div className="space-y-1">
                                        <p className="px-2.5 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-red-400/60">Developer</p>
                                        <ModalNavItem
                                            icon={<Bug size={14} />}
                                            label="Debug"
                                            active={activeTab === "developer"}
                                            onClick={() => setActiveTab("developer")}
                                        />
                                    </div>
                                )}

                            </nav>
                        </aside>

                        <main className="flex flex-1 flex-col min-h-0 bg-surface-overlay">
                            <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-8 pb-5 settings-scroll">
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
                                                <h1 className="text-lg font-medium text-content-primary">Account</h1>
                                                <p className="mt-1 text-[12px] text-content-muted">Manage your profile, sessions, and subscription.</p>
                                            </header>

                                            {authError && (
                                                <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                                                    <AlertCircle size={16} className="shrink-0" />
                                                    <span className="flex-1">{authError}</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            navigator.clipboard.writeText(authError);
                                                            setAuthErrorCopied(true);
                                                            setTimeout(() => setAuthErrorCopied(false), 1500);
                                                        }}
                                                        className="shrink-0 p-1 rounded hover:bg-red-500/20 transition-colors"
                                                        title="Copy error"
                                                    >
                                                        {authErrorCopied ? <Check size={14} /> : <Copy size={14} />}
                                                    </button>
                                                </div>
                                            )}

                                            {authLoading ? (
                                                <div className="flex flex-col items-center justify-center py-16">
                                                    <Loader2 size={24} className="animate-spin text-cloud mb-3" />
                                                    <p className="text-[12px] text-content-muted mb-3">Loading...</p>
                                                    <button
                                                        onClick={handleCancelAuth}
                                                        className="text-[11px] text-content-disabled hover:text-content-muted transition-colors"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : currentUser ? (
                                                <AccountView
                                                    currentUser={currentUser}
                                                    cloudSyncEnabled={cloudSyncEnabled}
                                                    onCloudSyncToggle={() => setCloudSyncEnabled(!cloudSyncEnabled)}
                                                    onUserUpdate={async () => {
                                                        await onUpdateUser();
                                                        setShowEmailForm(false);
                                                    }}
                                                    onSignOut={handleSignOut}
                                                />

                                            ) : (
                                                <div className="grid grid-cols-5 gap-4">
                                                    <div className="col-span-3 relative rounded-2xl border border-border-primary bg-surface-tertiary p-5 shadow-[0_10px_24px_rgba(0,0,0,0.28)] overflow-hidden min-h-[280px]">
                                                        <div className="absolute inset-0 pointer-events-none opacity-18">
                                                            <DotMatrix rows={8} cols={24} activeDots={[1, 4, 7, 10, 12, 15, 18, 20, 23]} dotSize={2} gap={4} color="var(--color-border-secondary)" />
                                                        </div>
                                                        <div className="relative flex flex-col h-full">
                                                            <div className="flex items-center gap-2 mb-3">
                                                                <DotMatrix rows={2} cols={2} activeDots={[0, 3]} dotSize={3} gap={2} color="var(--color-cloud)" />
                                                                <span className="text-[10px] font-semibold text-cloud">Glimpse Cloud</span>
                                                                <span className="ml-auto rounded-lg bg-surface-elevated px-2 py-0.5 text-[9px] font-medium text-content-muted">$5.99/mo</span>
                                                            </div>

                                                            <div className="flex flex-col gap-1.5 text-[11px] text-content-primary font-medium mb-4">
                                                                <div className="flex items-center gap-2">
                                                                    <div className="h-1 w-3 rounded-full bg-cloud/80" />
                                                                    <span>Cross-device sync</span>
                                                                </div>
                                                                <div className="flex items-center gap-2">
                                                                    <div className="h-1 w-3 rounded-full bg-cloud/80" />
                                                                    <span>Bigger & better models</span>
                                                                </div>
                                                                <div className="flex items-center gap-2">
                                                                    <div className="h-1 w-3 rounded-full bg-cloud/80" />
                                                                    <span>Faster processing</span>
                                                                </div>
                                                            </div>

                                                            <div className="mt-auto flex items-center gap-3 rounded-xl border border-border-primary bg-surface-tertiary px-3 py-2 text-[10px] text-content-secondary leading-relaxed">
                                                                <DotMatrix rows={3} cols={5} activeDots={[0, 2, 4, 6, 8, 10, 12, 14]} dotSize={2} gap={2} color="var(--color-bg-hover)" />
                                                                <p className="flex-1">Get faster processing, better models and cross-device sync with cloud.</p>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="col-span-2 relative rounded-2xl border border-border-primary bg-surface-tertiary p-5 shadow-[0_10px_24px_rgba(0,0,0,0.28)] overflow-hidden min-h-[280px] flex flex-col">
                                                        <div className="absolute inset-0 pointer-events-none opacity-18">
                                                            <DotMatrix rows={8} cols={12} activeDots={[0, 3, 6, 9, 12, 15, 18, 21]} dotSize={2} gap={4} color="var(--color-border-secondary)" />
                                                        </div>

                                                        <div className="relative flex flex-col flex-1">
                                                            <AnimatePresence mode="wait">
                                                                {showEmailForm ? (
                                                                    <motion.div
                                                                        key="email-form"
                                                                        initial={{ opacity: 0 }}
                                                                        animate={{ opacity: 1 }}
                                                                        exit={{ opacity: 0, scale: 0.95 }}
                                                                        transition={{ duration: 0.15 }}
                                                                        className="relative flex flex-col h-full"
                                                                    >
                                                                        <div className="flex items-center justify-between mb-3">
                                                                            <div className="flex items-center gap-2">
                                                                                <DotMatrix rows={2} cols={2} activeDots={[0, 1, 2, 3]} dotSize={3} gap={2} color="var(--color-cloud)" />
                                                                                <span className="text-[10px] font-semibold text-content-secondary">Continue with Email</span>
                                                                            </div>
                                                                            <button
                                                                                onClick={() => setShowEmailForm(false)}
                                                                                className="text-[9px] text-content-disabled hover:text-content-muted transition-colors"
                                                                            >
                                                                                Back
                                                                            </button>
                                                                        </div>

                                                                        <form
                                                                            onSubmit={async (e) => {
                                                                                e.preventDefault();
                                                                                setAuthError(null);
                                                                                setAuthLoading(true);
                                                                                try {
                                                                                    await login(authEmail, authPassword);
                                                                                    await onUpdateUser();
                                                                                    setShowEmailForm(false);
                                                                                } catch (loginErr) {
                                                                                    const errorMsg = loginErr instanceof Error ? loginErr.message : "";
                                                                                    if (errorMsg.includes("Invalid credentials") || errorMsg.includes("user") || errorMsg.includes("not found")) {
                                                                                        setPendingAuth({ email: authEmail, password: authPassword });
                                                                                        setShowNewAccountConfirm(true);
                                                                                    } else {
                                                                                        setAuthError(errorMsg || "Authentication failed");
                                                                                    }
                                                                                } finally {
                                                                                    setAuthLoading(false);
                                                                                }
                                                                            }}
                                                                            className="flex-1 flex flex-col gap-2"
                                                                        >
                                                                            <input
                                                                                type="email"
                                                                                placeholder="Email"
                                                                                value={authEmail}
                                                                                onChange={(e) => setAuthEmail(e.target.value)}
                                                                                required
                                                                                className="w-full rounded-lg border border-border-primary bg-surface-surface px-3 py-2 text-[11px] text-white placeholder-content-disabled outline-none focus:border-border-hover"
                                                                            />
                                                                            <div className="relative">
                                                                                <input
                                                                                    type={authShowPassword ? "text" : "password"}
                                                                                    placeholder="Password"
                                                                                    value={authPassword}
                                                                                    onChange={(e) => setAuthPassword(e.target.value)}
                                                                                    required
                                                                                    minLength={8}
                                                                                    className="w-full rounded-lg border border-border-primary bg-surface-surface px-3 py-2 pr-9 text-[11px] text-white placeholder-content-disabled outline-none focus:border-border-hover"
                                                                                />
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={() => setAuthShowPassword(!authShowPassword)}
                                                                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-content-disabled hover:text-content-muted transition-colors"
                                                                                >
                                                                                    {authShowPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                                                                                </button>
                                                                            </div>
                                                                            <button
                                                                                type="submit"
                                                                                className="mt-auto w-full rounded-xl bg-cloud py-2.5 text-[11px] font-semibold text-black hover:bg-cloud-light transition-colors"
                                                                            >
                                                                                Continue
                                                                            </button>
                                                                        </form>
                                                                    </motion.div>
                                                                ) : (
                                                                    <motion.div
                                                                        key="oauth-options"
                                                                        initial={{ opacity: 0 }}
                                                                        animate={{ opacity: 1 }}
                                                                        exit={{ opacity: 0, scale: 0.95 }}
                                                                        transition={{ duration: 0.15 }}
                                                                        className="relative flex flex-col h-full"
                                                                    >
                                                                        <div className="flex items-center gap-2 mb-3">
                                                                            <DotMatrix rows={2} cols={2} activeDots={[0, 1, 2, 3]} dotSize={3} gap={2} color="var(--color-cloud)" />
                                                                            <span className="text-[10px] font-semibold text-content-secondary">Sign In</span>
                                                                        </div>

                                                                        <p className="text-[10px] text-content-muted mb-4 leading-relaxed">
                                                                            Sign in to sync your transcriptions across devices.
                                                                        </p>

                                                                        <div className="flex flex-col gap-2 mt-auto">
                                                                            <button
                                                                                onClick={() => {
                                                                                    const url = getOAuth2Url(OAuthProvider.Google, window.location.href);
                                                                                    openUrl(url);
                                                                                }}
                                                                                className="flex items-center justify-center gap-2 w-full rounded-xl border border-border-secondary bg-surface-secondary px-3 py-2.5 text-[11px] text-content-primary hover:bg-surface-surface hover:border-border-hover transition-all"
                                                                            >
                                                                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24">
                                                                                    <path fill="#EA4335" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                                                                                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                                                                                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                                                                                    <path fill="#4285F4" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                                                                                </svg>
                                                                                Google
                                                                            </button>
                                                                            <button
                                                                                onClick={() => {
                                                                                    const url = getOAuth2Url(OAuthProvider.Github, window.location.href);
                                                                                    openUrl(url);
                                                                                }}
                                                                                className="flex items-center justify-center gap-2 w-full rounded-xl border border-border-secondary bg-surface-secondary px-3 py-2.5 text-[11px] text-content-primary hover:bg-surface-surface hover:border-border-hover transition-all"
                                                                            >
                                                                                <Github size={14} fill="currentColor" />
                                                                                GitHub
                                                                            </button>
                                                                            <button
                                                                                onClick={() => setShowEmailForm(true)}
                                                                                className="flex items-center justify-center gap-2 w-full rounded-xl border border-border-secondary bg-surface-secondary px-3 py-2.5 text-[11px] text-content-primary hover:bg-surface-surface hover:border-border-hover transition-all"
                                                                            >
                                                                                <Mail size={14} />
                                                                                Email
                                                                            </button>
                                                                        </div>
                                                                    </motion.div>
                                                                )}
                                                            </AnimatePresence>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </motion.div>
                                    )}

                                    {activeTab === "general" && (
                                        <motion.div
                                            key="general"
                                            variants={tabContentVariants}
                                            initial="hidden"
                                            animate="visible"
                                            exit="exit"
                                            className="space-y-6"
                                        >
                                            {/* Mode Selector - Primary at top */}
                                            <div className="space-y-2">
                                                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Processing</h2>
                                                <div className="grid grid-cols-2 gap-3">
                                                    <button
                                                        onClick={() => setTranscriptionMode("cloud")}
                                                        className={`py-3 px-3.5 rounded-lg border text-left transition-all ${transcriptionMode === "cloud"
                                                            ? "border-cloud-30 bg-cloud-5"
                                                            : "border-border-primary bg-transparent hover:border-border-secondary"
                                                            }`}
                                                    >
                                                        <div className="flex items-baseline gap-1.5">
                                                            <span className={`text-[13px] font-medium ${transcriptionMode === "cloud" ? "text-cloud" : "text-content-secondary"
                                                                }`}>Cloud</span>
                                                            <span className={`text-[10px] ${transcriptionMode === "cloud" ? "text-cloud-50" : "text-content-disabled"
                                                                }`}>fast</span>
                                                        </div>
                                                        <p className={`text-[10px] mt-1 ${transcriptionMode === "cloud" ? "text-cloud-50" : "text-content-disabled"
                                                            }`}>Process audio in the cloud</p>
                                                    </button>
                                                    <button
                                                        onClick={() => setTranscriptionMode("local")}
                                                        className={`py-3 px-3.5 rounded-lg border text-left transition-all ${transcriptionMode === "local"
                                                            ? "border-local-30 bg-local-5"
                                                            : "border-border-primary bg-transparent hover:border-border-secondary"
                                                            }`}
                                                    >
                                                        <div className="flex items-baseline gap-1.5">
                                                            <span className={`text-[13px] font-medium ${transcriptionMode === "local" ? "text-local" : "text-content-secondary"
                                                                }`}>Local</span>
                                                            <span className={`text-[10px] ${transcriptionMode === "local" ? "text-local-50" : "text-content-disabled"
                                                                }`}>private</span>
                                                        </div>
                                                        <p className={`text-[10px] mt-1 ${transcriptionMode === "local" ? "text-local-50" : "text-content-disabled"
                                                            }`}>Runs entirely on your device</p>
                                                    </button>
                                                </div>
                                                <AnimatePresence>
                                                    {!loading && transcriptionMode === "local" && !modelStatus[localModel]?.installed && (
                                                        <motion.p
                                                            initial={{ opacity: 0, height: 0 }}
                                                            animate={{ opacity: 1, height: "auto" }}
                                                            exit={{ opacity: 0, height: 0 }}
                                                            className="text-[10px] text-warning"
                                                        >
                                                            No model installed. <button onClick={() => setActiveTab("models")} className="underline hover:text-cloud transition-colors">Download one</button> to use local.
                                                        </motion.p>
                                                    )}
                                                </AnimatePresence>
                                            </div>

                                            {/* Bento Grid Layout */}
                                            <div className="grid grid-cols-2 gap-3">
                                                {/* Microphone */}
                                                <div className="space-y-1.5">
                                                    <label className="text-[10px] font-medium text-content-muted">Microphone</label>
                                                    <div className="relative z-20">
                                                        <Dropdown
                                                            value={microphoneDevice || ""}
                                                            onChange={(val) => setMicrophoneDevice(val === "" ? null : val)}
                                                            options={[
                                                                { value: "", label: "System Default" },
                                                                ...inputDevices.map((device) => ({
                                                                    value: device.id,
                                                                    label: device.name,
                                                                })),
                                                            ]}
                                                            placeholder="Select microphone..."
                                                        />
                                                    </div>
                                                </div>

                                                {/* Language */}
                                                <div className="space-y-1.5">
                                                    <label className="text-[10px] font-medium text-content-muted">Language</label>
                                                    <div className="relative z-10">
                                                        <Dropdown
                                                            value={language}
                                                            onChange={(val) => setLanguage(val)}
                                                            options={languages.map(lang => ({
                                                                value: lang.code,
                                                                label: lang.name
                                                            }))}
                                                            searchable
                                                            searchPlaceholder="Search language..."
                                                        />
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Shortcuts Section */}
                                            <div className="grid grid-cols-2 gap-3">
                                                <div className="space-y-2">
                                                    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Shortcuts</h2>

                                                    <div className="space-y-1.5">
                                                        <ShortcutRow
                                                            label="Smart"
                                                            description="tap to hold, long-press to toggle"
                                                            shortcut={smartShortcut}
                                                            enabled={smartEnabled}
                                                            isCapturing={captureActive === "smart"}
                                                            capturePreview={capturePreview}
                                                            onToggle={() => {
                                                                if (!smartEnabled && !holdEnabled && !toggleEnabled) return;
                                                                setSmartEnabled(!smartEnabled);
                                                            }}
                                                            onCapture={() => {
                                                                if (!smartEnabled) return;
                                                                pressedModifiers.current.clear();
                                                                primaryKey.current = null;
                                                                setCaptureActive("smart");
                                                                setError(null);
                                                            }}
                                                            canDisable={holdEnabled || toggleEnabled}
                                                        />
                                                        <ShortcutRow
                                                            label="Hold"
                                                            description="hold to talk, release to stop"
                                                            shortcut={holdShortcut}
                                                            enabled={holdEnabled}
                                                            isCapturing={captureActive === "hold"}
                                                            capturePreview={capturePreview}
                                                            onToggle={() => {
                                                                if (!holdEnabled && !toggleEnabled && !smartEnabled) return;
                                                                setHoldEnabled(!holdEnabled);
                                                            }}
                                                            onCapture={() => {
                                                                if (!holdEnabled) return;
                                                                pressedModifiers.current.clear();
                                                                primaryKey.current = null;
                                                                setCaptureActive("hold");
                                                                setError(null);
                                                            }}
                                                            canDisable={smartEnabled || toggleEnabled}
                                                        />
                                                        <ShortcutRow
                                                            label="Toggle"
                                                            description="tap to start, tap to stop"
                                                            shortcut={toggleShortcut}
                                                            enabled={toggleEnabled}
                                                            isCapturing={captureActive === "toggle"}
                                                            capturePreview={capturePreview}
                                                            onToggle={() => {
                                                                if (!toggleEnabled && !holdEnabled && !smartEnabled) return;
                                                                setToggleEnabled(!toggleEnabled);
                                                            }}
                                                            onCapture={() => {
                                                                if (!toggleEnabled) return;
                                                                pressedModifiers.current.clear();
                                                                primaryKey.current = null;
                                                                setCaptureActive("toggle");
                                                                setError(null);
                                                            }}
                                                            canDisable={smartEnabled || holdEnabled}
                                                        />
                                                    </div>
                                                </div>

                                                <div className="space-y-2">
                                                    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Features</h2>

                                                    {/* Edit Mode */}
                                                    <div className={`rounded-lg border transition-all ${editModeEnabled ? "border-border-secondary bg-surface-surface" : "border-border-primary bg-transparent"
                                                        }`}>
                                                        <div className="py-2 px-2.5">
                                                            <div className="flex items-center justify-between">
                                                                <span className="text-[11px] font-medium text-content-primary">Edit Mode</span>
                                                                <button
                                                                    onClick={() => setEditModeEnabled(!editModeEnabled)}
                                                                    className={`w-7 h-4 rounded-full transition-colors relative ${editModeEnabled ? "bg-cloud" : "bg-border-secondary"
                                                                        }`}
                                                                >
                                                                    <motion.div
                                                                        className="absolute top-[2px] w-3 h-3 rounded-full bg-white shadow-sm"
                                                                        animate={{ left: editModeEnabled ? "calc(100% - 14px)" : "2px" }}
                                                                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                                                                    />
                                                                </button>
                                                            </div>
                                                            <div className="flex items-center justify-between mt-0.5">
                                                                <span className="text-[9px] text-content-disabled">transform selected text with voice</span>
                                                                <div className="relative group">
                                                                    <button className="p-0.5 text-content-disabled hover:text-content-muted transition-colors">
                                                                        <Info size={10} />
                                                                    </button>
                                                                    <div className="absolute right-0 bottom-full mb-1 hidden group-hover:block z-10">
                                                                        <div className="bg-surface-overlay border border-border-secondary rounded-lg px-2.5 py-1.5 text-[9px] text-content-secondary w-44 shadow-lg leading-tight">
                                                                            <p>Select text in any app, use your shortcut, speak a command like "make formal" or "fix grammar"</p>
                                                                            {transcriptionMode === "local" && !llmCleanupEnabled && (
                                                                                <p className="text-warning mt-1">Requires LLM in Models tab</p>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Error display */}
                                            <AnimatePresence>
                                                {error && (
                                                    <motion.div
                                                        initial={{ opacity: 0, height: 0 }}
                                                        animate={{ opacity: 1, height: "auto" }}
                                                        exit={{ opacity: 0, height: 0 }}
                                                    >
                                                        <div className="flex items-center gap-2 text-[11px] text-error">
                                                            <span className="flex-1">{error}</span>
                                                            <button
                                                                onClick={() => {
                                                                    navigator.clipboard.writeText(error || "");
                                                                    setErrorCopied(true);
                                                                    setTimeout(() => setErrorCopied(false), 1500);
                                                                }}
                                                                className="text-error/60 hover:text-error transition-colors"
                                                            >
                                                                {errorCopied ? <Check size={11} /> : <Copy size={11} />}
                                                            </button>
                                                        </div>
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
                                            className="space-y-5"
                                        >
                                            <header>
                                                <h1 className="text-lg font-medium text-content-primary">Local Models</h1>
                                                <p className="mt-1 text-[12px] text-content-muted">Manage transcription engines and AI cleanup.</p>
                                            </header>
                                            <div className="rounded-xl border border-border-primary bg-surface-surface">
                                                <div className="p-4">
                                                    <div className="flex items-center justify-between mb-3">
                                                        <div>
                                                            <h3 className="text-[13px] font-medium text-content-primary">AI Cleanup</h3>
                                                            <p className="text-[11px] text-content-disabled">Use an LLM to clean up transcriptions</p>
                                                        </div>
                                                        <motion.button
                                                            onClick={() => setLlmCleanupEnabled(!llmCleanupEnabled)}
                                                            className={`relative w-10 h-5 rounded-full transition-colors ${llmCleanupEnabled ? "bg-cloud" : "bg-border-secondary"}`}
                                                            whileTap={{ scale: 0.95 }}
                                                        >
                                                            <motion.div
                                                                className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm"
                                                                animate={{ left: llmCleanupEnabled ? "calc(100% - 18px)" : "2px" }}
                                                                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                                                            />
                                                        </motion.button>
                                                    </div>

                                                    <AnimatePresence initial={false}>
                                                        {llmCleanupEnabled && (
                                                            <motion.div
                                                                initial={{ height: 0, opacity: 0 }}
                                                                animate={{ height: "auto", opacity: 1 }}
                                                                exit={{ height: 0, opacity: 0 }}
                                                                transition={{ type: "spring", stiffness: 400, damping: 35 }}
                                                                style={{ overflow: "visible" }}
                                                            >
                                                                <div className="pt-3 border-t border-border-primary space-y-3">
                                                                    <div className="space-y-1.5">
                                                                        <label className="text-[11px] font-medium text-content-muted ml-1">Provider</label>
                                                                        <div className="grid grid-cols-4 gap-2">
                                                                            <LlmProviderButton
                                                                                label="LM Studio"
                                                                                active={llmProvider === "lmstudio"}
                                                                                onClick={() => setLlmProvider("lmstudio")}
                                                                            />
                                                                            <LlmProviderButton
                                                                                label="Ollama"
                                                                                active={llmProvider === "ollama"}
                                                                                onClick={() => setLlmProvider("ollama")}
                                                                            />
                                                                            <LlmProviderButton
                                                                                label="OpenAI"
                                                                                active={llmProvider === "openai"}
                                                                                onClick={() => setLlmProvider("openai")}
                                                                            />
                                                                            <LlmProviderButton
                                                                                label="Custom"
                                                                                active={llmProvider === "custom"}
                                                                                onClick={() => setLlmProvider("custom")}
                                                                            />
                                                                        </div>
                                                                    </div>

                                                                    <div className="space-y-1.5">
                                                                        <label className="text-[11px] font-medium text-content-muted ml-1 flex items-center gap-1.5">
                                                                            <Server size={10} />
                                                                            Endpoint {llmProvider !== "custom" && <span className="text-content-disabled">(optional override)</span>}
                                                                        </label>
                                                                        <input
                                                                            type="text"
                                                                            value={llmEndpoint}
                                                                            onChange={(e) => setLlmEndpoint(e.target.value)}
                                                                            placeholder={
                                                                                llmProvider === "lmstudio" ? "http://localhost:1234" :
                                                                                    llmProvider === "ollama" ? "http://localhost:11434" :
                                                                                        llmProvider === "openai" ? "https://api.openai.com" :
                                                                                            "https://your-llm-endpoint.com"
                                                                            }
                                                                            className="w-full rounded-lg bg-surface-elevated border border-border-secondary py-2 px-3 text-[12px] text-content-primary placeholder-content-disabled focus:border-content-disabled focus:outline-none transition-colors"
                                                                        />
                                                                    </div>

                                                                    <div className="space-y-1.5">
                                                                        <label className="text-[11px] font-medium text-content-muted ml-1 flex items-center gap-1.5">
                                                                            <Key size={10} />
                                                                            API Key {llmProvider !== "openai" && <span className="text-content-disabled">(if required)</span>}
                                                                        </label>
                                                                        <input
                                                                            type="password"
                                                                            value={llmApiKey}
                                                                            onChange={(e) => setLlmApiKey(e.target.value)}
                                                                            placeholder={llmProvider === "openai" ? "sk-..." : "Optional"}
                                                                            className="w-full rounded-lg bg-surface-elevated border border-border-secondary py-2 px-3 text-[12px] text-content-primary placeholder-content-disabled focus:border-content-disabled focus:outline-none transition-colors"
                                                                        />
                                                                    </div>

                                                                    <div className="relative z-0">
                                                                        <Dropdown
                                                                            value={llmModel}
                                                                            onChange={(val) => setLlmModel(val)}
                                                                            onOpen={fetchAvailableModels}
                                                                            options={[
                                                                                {
                                                                                    value: "",
                                                                                    label: `Default (${llmProvider === "lmstudio" ? "Uses loaded model" :
                                                                                        llmProvider === "ollama" ? "llama3.2" :
                                                                                            llmProvider === "openai" ? "gpt-4o-mini" :
                                                                                                "None"})`
                                                                                },
                                                                                // If llmModel is set but not in availableModels, add it as an option so it displays correctly
                                                                                ...(llmModel && !availableModels.includes(llmModel) ? [{ value: llmModel, label: llmModel }] : []),
                                                                                ...availableModels.map(m => ({ value: m, label: m }))
                                                                            ]}
                                                                            placeholder="Select model..."
                                                                            searchable
                                                                            searchPlaceholder="Search available models..."
                                                                        />
                                                                    </div>

                                                                    <div className="flex items-start gap-2 rounded-lg border border-border-secondary bg-surface-elevated px-3 py-2">
                                                                        <Info size={12} className="text-content-muted shrink-0 mt-0.5" />
                                                                        <p className="text-[10px] text-content-muted">
                                                                            Removes filler words, fixes repetitions, and cleans up speech disfluencies while preserving your meaning.
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </div>
                                            </div>
                                            <div>
                                                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-disabled mb-3">Transcription Engines</h3>
                                                <div className="space-y-2">
                                                    {modelCatalog.map((model, index) => {
                                                        const modelStat = modelStatus[model.key];
                                                        const progress = downloadState[model.key];
                                                        const installed = modelStat?.installed;
                                                        const isActive = localModel === model.key && installed;
                                                        const isDownloading = progress?.status === "downloading";
                                                        const isCancelled = progress?.status === "cancelled";
                                                        const showError = progress?.status === "error";
                                                        const percent = progress?.percent ?? (installed ? 100 : 0);

                                                        return (
                                                            <motion.div
                                                                key={model.key}
                                                                initial={{ opacity: 0, y: 6 }}
                                                                animate={{ opacity: 1, y: 0 }}
                                                                transition={{ delay: index * 0.04 }}
                                                                className={`rounded-xl border p-4 transition-colors ${isActive
                                                                    ? "border-cloud-30 bg-cloud/[0.04]"
                                                                    : "border-border-primary bg-surface-surface hover:border-border-secondary"
                                                                    }`}
                                                            >
                                                                <div className="flex items-start justify-between gap-3">
                                                                    <div className="flex-1 min-w-0">
                                                                        <div className="flex items-center gap-2">
                                                                            <h3 className="text-[13px] font-medium text-content-primary">{model.label}</h3>
                                                                            {isActive && (
                                                                                <span className="px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider bg-cloud/20 text-cloud">Active</span>
                                                                            )}
                                                                        </div>
                                                                        <div className="flex flex-wrap gap-1.5 mt-1 mb-1.5">
                                                                            {model.tags.map(tag => {
                                                                                const isRecommended = tag.toLowerCase() === "recommended";
                                                                                return (
                                                                                    <span
                                                                                        key={tag}
                                                                                        className={
                                                                                            isRecommended
                                                                                                ? "px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border bg-local-10 text-local border-local-40"
                                                                                                : "px-1.5 py-0.5 rounded text-[9px] font-medium bg-surface-elevated text-content-muted border border-border-secondary"
                                                                                        }
                                                                                    >
                                                                                        {tag}
                                                                                    </span>
                                                                                );
                                                                            })}
                                                                        </div>
                                                                        <p className="text-[11px] text-content-muted line-clamp-1">{model.description}</p>
                                                                        <div className="mt-2 flex items-center gap-2">

                                                                            <span className="text-[10px] text-content-disabled">{model.variant}</span>
                                                                            <span className="text-[10px] text-content-disabled">•</span>
                                                                            <span className="text-[10px] text-content-disabled">{formatBytes(model.size_mb * 1024 * 1024)}</span>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex shrink-0 items-center gap-2">
                                                                        {installed && !isActive && (
                                                                            <motion.button
                                                                                onClick={() => setLocalModel(model.key)}
                                                                                className="rounded-lg bg-surface-elevated border border-border-secondary px-3 py-1.5 text-[10px] font-medium text-content-secondary hover:bg-surface-elevated-hover hover:text-content-primary transition-colors"
                                                                                whileTap={{ scale: 0.97 }}
                                                                            >
                                                                                Use
                                                                            </motion.button>
                                                                        )}
                                                                        {isDownloading ? (
                                                                            <motion.button
                                                                                onClick={() => handleCancelDownload(model.key)}
                                                                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-error/30 text-error hover:bg-error/10 transition-colors"
                                                                                whileTap={{ scale: 0.95 }}
                                                                                title="Stop download"
                                                                            >
                                                                                <Square size={10} fill="currentColor" />
                                                                            </motion.button>
                                                                        ) : (
                                                                            <motion.button
                                                                                onClick={() => (installed ? handleDelete(model.key) : handleDownload(model.key))}
                                                                                disabled={isCancelled}
                                                                                className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${installed
                                                                                    ? "border-error/20 text-error hover:bg-error/10"
                                                                                    : isCancelled
                                                                                        ? "border-border-secondary text-content-disabled cursor-default"
                                                                                        : "border-border-secondary text-content-muted hover:bg-surface-elevated hover:text-content-secondary"
                                                                                    }`}
                                                                                whileTap={!isCancelled ? { scale: 0.95 } : {}}
                                                                            >
                                                                                {installed ? (
                                                                                    <Trash2 size={12} />
                                                                                ) : (
                                                                                    <Download size={12} className={isCancelled ? "" : ""} />
                                                                                )}
                                                                            </motion.button>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                {(isDownloading || !installed) && (
                                                                    <div className="mt-3">
                                                                        <ModelProgress percent={percent} status={progress?.status ?? "idle"} />
                                                                        <div className="h-4 flex items-center mt-1.5">
                                                                            {isDownloading && (
                                                                                <p className="text-[10px] leading-none text-content-muted tabular-nums truncate w-full">
                                                                                    {progress?.percent?.toFixed(0)}% · {(progress as Extract<DownloadEvent, { status: "downloading" }>).file}
                                                                                </p>
                                                                            )}
                                                                            {showError && (
                                                                                <p className="text-[10px] leading-none text-error flex items-center gap-1 w-full truncate">
                                                                                    <AlertCircle size={10} />
                                                                                    {(progress as Extract<DownloadEvent, { status: "error" }>).message}
                                                                                </p>
                                                                            )}
                                                                            {isCancelled && (
                                                                                <p className="text-[10px] leading-none text-content-muted">
                                                                                    Cancelled
                                                                                </p>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </motion.div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        </motion.div>
                                    )}

                                    {activeTab === "advanced" && (
                                        <motion.div
                                            key="advanced"
                                            variants={tabContentVariants}
                                            initial="hidden"
                                            animate="visible"
                                            exit="exit"
                                            className="space-y-6"
                                        >
                                            {/* Permissions Section */}
                                            <div className="space-y-2">
                                                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Permissions</h2>

                                                <div className="grid grid-cols-2 gap-2">
                                                    {/* Microphone Permission */}
                                                    <div className="rounded-lg border border-border-primary bg-surface-surface">
                                                        <div className="py-2.5 px-3">
                                                            <div className="flex items-center justify-between">
                                                                <span className="text-[11px] font-medium text-content-primary">Microphone</span>
                                                                {micPermission === null ? (
                                                                    <Loader2 size={10} className="animate-spin text-content-muted" />
                                                                ) : micPermission ? (
                                                                    <span className="text-[10px] text-success flex items-center gap-1">
                                                                        <Check size={10} />
                                                                    </span>
                                                                ) : (
                                                                    <span className="text-[10px] text-warning">off</span>
                                                                )}
                                                            </div>
                                                            <span className="text-[9px] text-content-disabled block mt-0.5">required for transcription</span>
                                                            <button
                                                                onClick={() => invoke("open_microphone_settings")}
                                                                className="mt-2 text-[10px] text-content-muted hover:text-content-secondary transition-colors"
                                                            >
                                                                Open Settings
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {/* Accessibility Permission */}
                                                    <div className="rounded-lg border border-border-primary bg-surface-surface">
                                                        <div className="py-2.5 px-3">
                                                            <div className="flex items-center justify-between">
                                                                <span className="text-[11px] font-medium text-content-primary">Accessibility</span>
                                                                {accessibilityPermission === null ? (
                                                                    <Loader2 size={10} className="animate-spin text-content-muted" />
                                                                ) : accessibilityPermission ? (
                                                                    <span className="text-[10px] text-success flex items-center gap-1">
                                                                        <Check size={10} />
                                                                    </span>
                                                                ) : (
                                                                    <span className="text-[10px] text-warning">off</span>
                                                                )}
                                                            </div>
                                                            <span className="text-[9px] text-content-disabled block mt-0.5">required for auto-paste</span>
                                                            <button
                                                                onClick={async () => {
                                                                    try {
                                                                        const granted = await requestAccessibilityPermission();
                                                                        if (!granted) await invoke("open_accessibility_settings");
                                                                    } catch {
                                                                        await invoke("open_accessibility_settings");
                                                                    }
                                                                }}
                                                                className="mt-2 text-[10px] text-content-muted hover:text-content-secondary transition-colors"
                                                            >
                                                                Open Settings
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>

                                                <p className="text-[9px] text-content-disabled px-0.5">
                                                    Restart Glimpse after changing permissions in System Settings.
                                                </p>
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
                                            className="space-y-6"
                                        >
                                            {/* App Info Section */}
                                            <div className="space-y-2">
                                                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">App Info</h2>

                                                <div className="grid grid-cols-2 gap-3">
                                                    <div className="rounded-lg border border-border-primary bg-surface-surface py-2.5 px-3">
                                                        <span className="text-[9px] text-content-disabled block">Version</span>
                                                        <span className="text-[12px] text-content-primary font-medium">{appInfo?.version ?? "-"}</span>
                                                    </div>
                                                    <div className="rounded-lg border border-border-primary bg-surface-surface py-2.5 px-3">
                                                        <span className="text-[9px] text-content-disabled block">Storage Used</span>
                                                        <span className="text-[12px] text-content-primary font-medium">{appInfo ? formatBytes(appInfo.data_dir_size_bytes) : "-"}</span>
                                                    </div>
                                                </div>

                                                <button
                                                    type="button"
                                                    onClick={handleOpenDataDir}
                                                    disabled={!appInfo?.data_dir_path}
                                                    className="w-full rounded-lg border border-border-primary bg-surface-surface py-2 px-3 text-left hover:border-border-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                >
                                                    <span className="text-[9px] text-content-disabled block">Data Location</span>
                                                    <span className="text-[11px] text-content-muted font-mono truncate block"><span className="border-b border-dotted border-content-disabled pb-[1px]">{appInfo?.data_dir_path ?? "-"}</span></span>
                                                </button>
                                            </div>

                                            {/* Updates Section */}
                                            <div className="space-y-2">
                                                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Updates</h2>
                                                <UpdateChecker />
                                            </div>

                                            {/* Setup Section */}
                                            <div className="space-y-2">
                                                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Setup</h2>

                                                <div className="grid grid-cols-2 gap-3">
                                                    <button
                                                        onClick={async () => {
                                                            try {
                                                                await invoke("reset_onboarding");
                                                                window.location.reload();
                                                            } catch (err) {
                                                                console.error("Failed to restart onboarding:", err);
                                                            }
                                                        }}
                                                        className="rounded-lg border border-border-primary bg-surface-surface py-2.5 px-3 text-left hover:border-border-secondary transition-colors"
                                                    >
                                                        <span className="text-[11px] font-medium text-content-primary block">Restart Onboarding</span>
                                                        <span className="text-[9px] text-content-disabled">re-run setup wizard</span>
                                                    </button>

                                                    <button
                                                        onClick={() => setShowFAQModal(true)}
                                                        className="rounded-lg border border-border-primary bg-surface-surface py-2.5 px-3 text-left hover:border-border-secondary transition-colors"
                                                    >
                                                        <span className="text-[11px] font-medium text-content-primary block">FAQ & Help</span>
                                                        <span className="text-[9px] text-content-disabled">common questions</span>
                                                    </button>
                                                </div>
                                            </div>
                                        </motion.div>
                                    )}

                                    {activeTab === "developer" && isDeveloper && (
                                        <motion.div
                                            key="developer"
                                            initial={{ opacity: 0, y: 10 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0, y: -10 }}
                                            transition={{ duration: 0.15 }}
                                            className="p-6"
                                        >
                                            <DebugSection />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </main>
                    </motion.div>
                </motion.div>
            )}

            <FAQModal isOpen={showFAQModal} onClose={() => setShowFAQModal(false)} />
            <WhatsNewModal isOpen={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />

            <AnimatePresence>
                {showNewAccountConfirm && pendingAuth && (
                    <motion.div
                        key="new-account-confirm"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm px-6"
                        onClick={() => setShowNewAccountConfirm(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.96, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.96, opacity: 0 }}
                            transition={{ duration: 0.18 }}
                            className="w-full max-w-sm rounded-2xl border border-border-primary bg-surface-tertiary p-5 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="flex items-center gap-3 mb-3">
                                <Mail size={20} className="text-cloud shrink-0" />
                                <div>
                                    <p className="text-[14px] font-semibold text-content-primary">Create new account?</p>
                                    <p className="text-[11px] text-content-disabled">No account found for <span className="text-content-muted">{pendingAuth.email}</span>. Would you like to create a new account?</p>
                                </div>
                            </div>
                            <div className="flex justify-end gap-2">
                                <button
                                    onClick={() => {
                                        setShowNewAccountConfirm(false);
                                        setPendingAuth(null);
                                    }}
                                    className="rounded-lg border border-border-secondary px-4 py-2 text-[12px] font-medium text-content-secondary hover:border-border-hover transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={async () => {
                                        setShowNewAccountConfirm(false);
                                        setAuthLoading(true);
                                        try {
                                            await createAccount(pendingAuth.email, pendingAuth.password);
                                            await onUpdateUser();
                                            setShowEmailForm(false);
                                            setPendingAuth(null);
                                        } catch (err) {
                                            setAuthError(err instanceof Error ? err.message : "Failed to create account");
                                            setPendingAuth(null);
                                        } finally {
                                            setAuthLoading(false);
                                        }
                                    }}
                                    className="rounded-lg bg-cloud px-4 py-2 text-[12px] font-semibold text-black hover:bg-cloud-light transition-colors"
                                >
                                    Create Account
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </AnimatePresence>
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
        className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] font-medium transition-all ${active ? "bg-surface-elevated text-content-primary" : "text-content-muted hover:bg-surface-elevated hover:text-content-secondary"
            }`}
        whileTap={{ scale: 0.98 }}
    >
        <div className={active ? "text-cloud/80" : "text-content-disabled"}>{icon}</div>
        {label}
    </motion.button>
);

const ShortcutRow = ({ label, description, shortcut, enabled, isCapturing, capturePreview, onToggle, onCapture, canDisable }: {
    label: string;
    description: string;
    shortcut: string;
    enabled: boolean;
    isCapturing: boolean;
    capturePreview: string;
    onToggle: () => void;
    onCapture: () => void;
    canDisable: boolean;
}) => (
    <div className={`rounded-lg border transition-all ${enabled ? "border-border-secondary bg-surface-surface" : "border-border-primary bg-transparent"
        }`}>
        <div className="py-2 px-2.5">
            {/* Top row: label + toggle */}
            <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-content-primary">{label}</span>
                <button
                    onClick={onToggle}
                    disabled={enabled && !canDisable}
                    className={`w-7 h-4 rounded-full transition-colors relative ${enabled ? "bg-cloud" : "bg-border-secondary"
                        } ${enabled && !canDisable ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                    <motion.div
                        className="absolute top-[2px] w-3 h-3 rounded-full bg-white shadow-sm"
                        animate={{ left: enabled ? "calc(100% - 14px)" : "2px" }}
                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                    />
                </button>
            </div>
            {/* Bottom row: description + shortcut */}
            <div className="flex items-center justify-between mt-0.5">
                <span className="text-[9px] text-content-disabled">{description}</span>
                <motion.button
                    onClick={onCapture}
                    disabled={!enabled}
                    className={`font-mono text-[10px] px-1.5 py-0.5 rounded transition-all ${isCapturing
                        ? "text-content-primary border border-border-hover"
                        : enabled
                            ? "text-content-secondary hover:text-content-primary hover:bg-surface-elevated"
                            : "text-content-disabled cursor-not-allowed"
                        }`}
                >
                    {isCapturing ? (
                        <span className="flex items-center gap-1.5">
                            <motion.span
                                className="w-1 h-1 rounded-full bg-cloud"
                                animate={{ opacity: [0.3, 1, 0.3] }}
                                transition={{ duration: 1, repeat: Infinity }}
                            />
                            <span className={capturePreview ? "text-content-primary" : "text-content-muted"}>
                                {capturePreview || "..."}
                            </span>
                        </span>
                    ) : shortcut}
                </motion.button>
            </div>
        </div>
    </div>
);

const LlmProviderButton = ({ label, active, onClick }: {
    label: string; active: boolean; onClick: () => void;
}) => (
    <motion.button
        onClick={onClick}
        className={`rounded-lg border py-2 px-3 text-[11px] font-medium transition-all ${active
            ? "border-cloud-30 bg-cloud-10 text-cloud"
            : "border-border-secondary bg-surface-elevated text-content-secondary hover:border-border-hover hover:text-content-primary"
            }`}
        whileTap={{ scale: 0.97 }}
    >
        {label}
    </motion.button>
);

const ModelProgress = ({ percent, status }: { percent: number; status: string }) => {
    const cols = 50;
    const rows = 3;
    const totalDots = cols * rows;
    const activeCount = Math.round((percent / 100) * totalDots);

    const activeDots = useMemo(() => {
        const dots: number[] = [];
        for (let i = 0; i < activeCount && i < totalDots; i++) {
            dots.push(i);
        }
        return dots;
    }, [activeCount, totalDots]);

    const color = status === "error" ? "var(--color-error)" : status === "complete" ? "var(--color-success)" : "var(--color-cloud)";

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
};

export default SettingsModal;
