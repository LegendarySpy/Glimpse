import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
    Wand2,
    Server,
    Key,
    RotateCcw,
    FolderOpen,
    Github,

    Mail,
    HelpCircle,
    Sliders,
    Accessibility,
    Check,
    Eye,
    EyeOff,
    Copy,
    Bug,
} from "lucide-react";
import DotMatrix from "./DotMatrix";
import AccountView from "./AccountView";
import FAQModal from "./FAQModal";
import { UpdateChecker } from "./UpdateChecker";
import DebugSection from "./DebugSection";
import { getCurrentUser, logout, getOAuth2Url, login, createAccount, type User as AppwriteUser } from "../lib/auth";
import WhatsNewModal from "./WhatsNewModal";

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
    const pressedModifiers = useRef<Set<string>>(new Set());
    const primaryKey = useRef<string | null>(null);
    const [activeTab, setActiveTab] = useState<"general" | "models" | "about" | "account" | "advanced" | "developer">("general");
    const [shortcutsExpanded, setShortcutsExpanded] = useState(false);
    const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
    const [llmCleanupEnabled, setLlmCleanupEnabled] = useState(false);
    const [llmProvider, setLlmProvider] = useState<LlmProvider>("none");
    const [llmEndpoint, setLlmEndpoint] = useState("");
    const [llmApiKey, setLlmApiKey] = useState("");
    const [llmModel, setLlmModel] = useState("");
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
    const [modelsLoading, setModelsLoading] = useState(false);
    const modelDropdownRef = useRef<HTMLDivElement>(null);

    const [authLoading, setAuthLoading] = useState(false);
    const [authError, setAuthError] = useState<string | null>(null);
    const [showEmailForm, setShowEmailForm] = useState(false);
    const [showFAQModal, setShowFAQModal] = useState(false);
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
        if (!isSubscriber && cloudSyncEnabled) {
            setCloudSyncEnabled(false);
        }
    }, [isSubscriber, cloudSyncEnabled]);

    useEffect(() => {
        if (isOpen && initialTab) {
            setActiveTab(initialTab);
        }
    }, [isOpen, initialTab]);

    useEffect(() => {
        localStorage.setItem("glimpse_cloud_sync_enabled", String(cloudSyncEnabled));
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
        if (isOpen) {
            setAuthLoading(true);
            getCurrentUser()
                .then(() => {
                    setAuthError(null);
                })
                .catch(() => { })
                .finally(() => {
                    setAuthLoading(false);
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
        setModelsLoading(true);
        try {
            const models = await invoke<string[]>("fetch_llm_models", {
                endpoint: llmEndpoint,
                provider: llmProvider,
                apiKey: llmApiKey,
            });
            setAvailableModels(models);
        } catch {
            setAvailableModels([]);
        } finally {
            setModelsLoading(false);
        }
    }, [llmEndpoint, llmProvider, llmApiKey]);

    useEffect(() => {
        if (modelDropdownOpen) {
            fetchAvailableModels();
        }
    }, [modelDropdownOpen, fetchAvailableModels]);

    useEffect(() => {
        if (!modelDropdownOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
                setModelDropdownOpen(false);
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setModelDropdownOpen(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEscape);

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [modelDropdownOpen]);

    useEffect(() => {
        if (!llmCleanupEnabled) {
            setModelDropdownOpen(false);
        }
    }, [llmCleanupEnabled]);

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
                        <aside className="flex w-44 flex-col border-r border-[#1e1e22] bg-[#111113]">
                            <div className="px-4 pt-5 pb-4">
                                <h2 className="text-[13px] font-semibold text-[#e8e8eb]">Settings</h2>
                            </div>
                            <nav className="flex-1 px-2 space-y-4">
                                <div className="space-y-1">
                                    <p className="px-2.5 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-[#4a4a54]">Account</p>
                                    <ModalNavItem
                                        icon={<User size={14} />}
                                        label="Account"
                                        active={activeTab === "account"}
                                        onClick={() => setActiveTab("account")}
                                    />
                                </div>

                                <div className="space-y-1">
                                    <p className="px-2.5 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-[#4a4a54]">General</p>
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

                        <main className="flex flex-1 flex-col min-h-0 bg-[#161618]">
                            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 settings-scroll">
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
                                                <p className="mt-1 text-[12px] text-[#6b6b76]">Manage your profile, sessions, and subscription.</p>
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
                                                    <Loader2 size={24} className="animate-spin text-amber-400 mb-3" />
                                                    <p className="text-[12px] text-[#6b6b76] mb-3">Loading...</p>
                                                    <button
                                                        onClick={handleCancelAuth}
                                                        className="text-[11px] text-[#4a4a54] hover:text-[#6b6b76] transition-colors"
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
                                                    <div className="col-span-3 relative rounded-2xl border border-[#1f1f28] bg-[#0d0d10] p-5 shadow-[0_10px_24px_rgba(0,0,0,0.28)] overflow-hidden min-h-[280px]">
                                                        <div className="absolute inset-0 pointer-events-none opacity-18">
                                                            <DotMatrix rows={8} cols={24} activeDots={[1, 4, 7, 10, 12, 15, 18, 20, 23]} dotSize={2} gap={4} color="#2e2e37" />
                                                        </div>
                                                        <div className="relative flex flex-col h-full">
                                                            <div className="flex items-center gap-2 mb-3">
                                                                <DotMatrix rows={2} cols={2} activeDots={[0, 3]} dotSize={3} gap={2} color="#fbbf24" />
                                                                <span className="text-[10px] font-semibold text-amber-400">Glimpse Cloud</span>
                                                                <span className="ml-auto rounded-lg bg-[#1a1a22] px-2 py-0.5 text-[9px] font-medium text-[#6b6b76]">$5.99/mo</span>
                                                            </div>

                                                            <div className="flex flex-col gap-1.5 text-[11px] text-[#f0f0f5] font-medium mb-4">
                                                                <div className="flex items-center gap-2">
                                                                    <div className="h-1 w-3 rounded-full bg-amber-400/80" />
                                                                    <span>Cross-device sync</span>
                                                                </div>
                                                                <div className="flex items-center gap-2">
                                                                    <div className="h-1 w-3 rounded-full bg-amber-400/80" />
                                                                    <span>Bigger & better models</span>
                                                                </div>
                                                                <div className="flex items-center gap-2">
                                                                    <div className="h-1 w-3 rounded-full bg-amber-400/80" />
                                                                    <span>Faster processing</span>
                                                                </div>
                                                            </div>

                                                            <div className="mt-auto flex items-center gap-3 rounded-xl border border-[#1a1a22] bg-[#0d0d12]/90 px-3 py-2 text-[10px] text-[#a0a0ab] leading-relaxed">
                                                                <DotMatrix rows={3} cols={5} activeDots={[0, 2, 4, 6, 8, 10, 12, 14]} dotSize={2} gap={2} color="#2a2a34" />
                                                                <p className="flex-1">Cloud is optional. Get faster processing, better models and cross-device sync.</p>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="col-span-2 relative rounded-2xl border border-[#1f1f28] bg-[#0d0d10] p-5 shadow-[0_10px_24px_rgba(0,0,0,0.28)] overflow-hidden min-h-[280px] flex flex-col">
                                                        <div className="absolute inset-0 pointer-events-none opacity-18">
                                                            <DotMatrix rows={8} cols={12} activeDots={[0, 3, 6, 9, 12, 15, 18, 21]} dotSize={2} gap={4} color="#2e2e37" />
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
                                                                                <DotMatrix rows={2} cols={2} activeDots={[0, 1, 2, 3]} dotSize={3} gap={2} color="#fbbf24" />
                                                                                <span className="text-[10px] font-semibold text-[#9ca3af]">Continue with Email</span>
                                                                            </div>
                                                                            <button
                                                                                onClick={() => setShowEmailForm(false)}
                                                                                className="text-[9px] text-[#4a4a54] hover:text-[#6b6b76] transition-colors"
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
                                                                                    try {
                                                                                        await login(authEmail, authPassword);
                                                                                    } catch (loginErr) {
                                                                                        const errorMsg = loginErr instanceof Error ? loginErr.message : "";
                                                                                        if (errorMsg.includes("Invalid credentials") || errorMsg.includes("user") || errorMsg.includes("not found")) {
                                                                                            await createAccount(authEmail, authPassword);
                                                                                        } else {
                                                                                            throw loginErr;
                                                                                        }
                                                                                    }
                                                                                    await onUpdateUser();
                                                                                    setShowEmailForm(false);
                                                                                } catch (err) {
                                                                                    setAuthError(err instanceof Error ? err.message : "Authentication failed");
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
                                                                                className="w-full rounded-lg border border-[#1e1e28] bg-[#111115] px-3 py-2 text-[11px] text-white placeholder-[#4a4a54] outline-none focus:border-[#3a3a45]"
                                                                            />
                                                                            <div className="relative">
                                                                                <input
                                                                                    type={authShowPassword ? "text" : "password"}
                                                                                    placeholder="Password"
                                                                                    value={authPassword}
                                                                                    onChange={(e) => setAuthPassword(e.target.value)}
                                                                                    required
                                                                                    minLength={8}
                                                                                    className="w-full rounded-lg border border-[#1e1e28] bg-[#111115] px-3 py-2 pr-9 text-[11px] text-white placeholder-[#4a4a54] outline-none focus:border-[#3a3a45]"
                                                                                />
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={() => setAuthShowPassword(!authShowPassword)}
                                                                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#4a4a54] hover:text-[#6b6b76] transition-colors"
                                                                                >
                                                                                    {authShowPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                                                                                </button>
                                                                            </div>
                                                                            <button
                                                                                type="submit"
                                                                                className="mt-auto w-full rounded-xl bg-amber-400 py-2.5 text-[11px] font-semibold text-black hover:bg-amber-300 transition-colors"
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
                                                                            <DotMatrix rows={2} cols={2} activeDots={[0, 1, 2, 3]} dotSize={3} gap={2} color="#fbbf24" />
                                                                            <span className="text-[10px] font-semibold text-[#9ca3af]">Sign In</span>
                                                                        </div>

                                                                        <p className="text-[10px] text-[#6b6b76] mb-4 leading-relaxed">
                                                                            Sign in to sync your transcriptions across devices.
                                                                        </p>

                                                                        <div className="flex flex-col gap-2 mt-auto">
                                                                            <button
                                                                                onClick={() => {
                                                                                    const url = getOAuth2Url(OAuthProvider.Google, window.location.href);
                                                                                    openUrl(url);
                                                                                }}
                                                                                className="flex items-center justify-center gap-2 w-full rounded-xl border border-[#2a2a34] bg-[#0c0c10] px-3 py-2.5 text-[11px] text-[#e8e8eb] hover:bg-[#151518] hover:border-[#3a3a45] transition-all"
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
                                                                                className="flex items-center justify-center gap-2 w-full rounded-xl border border-[#2a2a34] bg-[#0c0c10] px-3 py-2.5 text-[11px] text-[#e8e8eb] hover:bg-[#151518] hover:border-[#3a3a45] transition-all"
                                                                            >
                                                                                <Github size={14} fill="currentColor" />
                                                                                GitHub
                                                                            </button>
                                                                            <button
                                                                                onClick={() => setShowEmailForm(true)}
                                                                                className="flex items-center justify-center gap-2 w-full rounded-xl border border-[#2a2a34] bg-[#0c0c10] px-3 py-2.5 text-[11px] text-[#e8e8eb] hover:bg-[#151518] hover:border-[#3a3a45] transition-all"
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
                                            className="space-y-5"
                                        >
                                            <header>
                                                <h1 className="text-lg font-medium text-[#e8e8eb]">General</h1>
                                                <p className="mt-1 text-[12px] text-[#6b6b76]">Configure your recording shortcuts and transcription engine.</p>
                                            </header>

                                            <div className="space-y-3">
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
                                                                            {smartEnabled ? `Smart: ${smartShortcut}` : ""}
                                                                            {smartEnabled && (holdEnabled || toggleEnabled) ? " • " : ""}
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
                                                                    <div className={`rounded-xl border p-4 transition-colors ${smartEnabled
                                                                        ? "border-amber-400/30 bg-amber-400/5"
                                                                        : "border-[#1e1e22]/50 bg-[#111113]/50"
                                                                        }`}>
                                                                        <div className="flex items-center justify-between">
                                                                            <div className="flex items-center gap-3">
                                                                                <div className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${smartEnabled
                                                                                    ? "bg-amber-400/10 border-amber-400/30"
                                                                                    : "bg-[#1a1a1e]/50 border-[#2a2a30]/50"
                                                                                    }`}>
                                                                                    <Wand2 size={14} className={smartEnabled ? "text-amber-400" : "text-[#4a4a54]"} />
                                                                                </div>
                                                                                <div>
                                                                                    <h3 className={`text-[13px] font-medium ${smartEnabled ? "text-[#e8e8eb]" : "text-[#6b6b76]"}`}>Smart Mode</h3>
                                                                                    <p className="text-[11px] text-[#4a4a54]">Quick tap = hold, long press = toggle</p>
                                                                                </div>
                                                                            </div>
                                                                            <div className="flex items-center gap-2">
                                                                                <motion.button
                                                                                    onClick={() => {
                                                                                        if (!smartEnabled && !holdEnabled && !toggleEnabled) return;
                                                                                        setSmartEnabled(!smartEnabled);
                                                                                    }}
                                                                                    disabled={smartEnabled && !holdEnabled && !toggleEnabled}
                                                                                    className={`relative w-10 h-5 rounded-full transition-colors ${smartEnabled ? "bg-amber-400" : "bg-[#2a2a30]"
                                                                                        } ${smartEnabled && !holdEnabled && !toggleEnabled ? "opacity-50 cursor-not-allowed" : ""}`}
                                                                                    whileTap={!(smartEnabled && !holdEnabled && !toggleEnabled) ? { scale: 0.95 } : {}}
                                                                                >
                                                                                    <motion.div
                                                                                        className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm"
                                                                                        animate={{ left: smartEnabled ? "calc(100% - 18px)" : "2px" }}
                                                                                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                                                                                    />
                                                                                </motion.button>
                                                                                <motion.button
                                                                                    onClick={() => {
                                                                                        if (!smartEnabled) return;
                                                                                        pressedModifiers.current.clear();
                                                                                        primaryKey.current = null;
                                                                                        setCaptureActive("smart");
                                                                                        setError(null);
                                                                                    }}
                                                                                    disabled={!smartEnabled}
                                                                                    className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition-all ${captureActive === "smart"
                                                                                        ? "bg-amber-400 text-black"
                                                                                        : smartEnabled
                                                                                            ? "bg-[#1a1a1e] border border-[#2a2a30] text-[#a0a0ab] hover:bg-[#232328] hover:text-[#e8e8eb]"
                                                                                            : "bg-[#1a1a1e]/50 border border-[#2a2a30]/50 text-[#4a4a54] cursor-not-allowed"
                                                                                        }`}
                                                                                    whileTap={smartEnabled ? { scale: 0.97 } : {}}
                                                                                >
                                                                                    {captureActive === "smart" ? "Listening..." : "Change"}
                                                                                </motion.button>
                                                                            </div>
                                                                        </div>
                                                                        <motion.div
                                                                            className={`mt-3 inline-flex items-center rounded-lg border px-3 py-2 transition-colors ${smartEnabled
                                                                                ? "border-amber-400/30 bg-amber-400/10"
                                                                                : "border-[#2a2a30]/50 bg-[#1a1a1e]/50"
                                                                                }`}
                                                                            animate={captureActive === "smart" ? {
                                                                                borderColor: ["rgba(251, 191, 36, 0.3)", "rgba(251, 191, 36, 0.8)", "rgba(251, 191, 36, 0.3)"]
                                                                            } : {}}
                                                                            transition={{ duration: 1.2, repeat: captureActive === "smart" ? Infinity : 0 }}
                                                                        >
                                                                            <span className={`font-mono text-[12px] ${smartEnabled ? "text-[#e8e8eb]" : "text-[#6b6b76]"}`}>{smartShortcut}</span>
                                                                        </motion.div>
                                                                    </div>

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
                                                                                        if (!holdEnabled && !toggleEnabled && !smartEnabled) return;
                                                                                        setHoldEnabled(!holdEnabled);
                                                                                    }}
                                                                                    disabled={holdEnabled && !toggleEnabled && !smartEnabled}
                                                                                    className={`relative w-10 h-5 rounded-full transition-colors ${holdEnabled ? "bg-amber-400" : "bg-[#2a2a30]"
                                                                                        } ${holdEnabled && !toggleEnabled && !smartEnabled ? "opacity-50 cursor-not-allowed" : ""}`}
                                                                                    whileTap={!(holdEnabled && !toggleEnabled && !smartEnabled) ? { scale: 0.95 } : {}}
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
                                                                                        if (!toggleEnabled && !holdEnabled && !smartEnabled) return;
                                                                                        setToggleEnabled(!toggleEnabled);
                                                                                    }}
                                                                                    disabled={toggleEnabled && !holdEnabled && !smartEnabled}
                                                                                    className={`relative w-10 h-5 rounded-full transition-colors ${toggleEnabled ? "bg-amber-400" : "bg-[#2a2a30]"
                                                                                        } ${toggleEnabled && !holdEnabled && !smartEnabled ? "opacity-50 cursor-not-allowed" : ""}`}
                                                                                    whileTap={!(toggleEnabled && !holdEnabled && !smartEnabled) ? { scale: 0.95 } : {}}
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
                                                            variant="cloud"
                                                            loading={loading}
                                                        />
                                                        <ModeButton
                                                            icon={<HardDrive size={16} />}
                                                            label="Local"
                                                            description="Private & offline"
                                                            active={transcriptionMode === "local"}
                                                            onClick={() => setTranscriptionMode("local")}
                                                            variant="local"
                                                            loading={loading}
                                                        />
                                                    </div>

                                                    <AnimatePresence>
                                                        {!loading && transcriptionMode === "local" && !modelStatus[localModel]?.installed && (
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

                                            <AnimatePresence>
                                                {error && (
                                                    <motion.div
                                                        initial={{ opacity: 0, height: 0 }}
                                                        animate={{ opacity: 1, height: "auto" }}
                                                        exit={{ opacity: 0, height: 0 }}
                                                        className="pt-4 border-t border-[#1e1e22]"
                                                    >
                                                        <div className="flex items-center gap-1.5 text-[11px] text-red-400">
                                                            <AlertCircle size={12} className="shrink-0" />
                                                            <span className="flex-1">{error}</span>
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    navigator.clipboard.writeText(error || "");
                                                                    setErrorCopied(true);
                                                                    setTimeout(() => setErrorCopied(false), 1500);
                                                                }}
                                                                className="shrink-0 p-0.5 rounded hover:bg-red-500/20 transition-colors"
                                                                title="Copy error"
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
                                                <h1 className="text-lg font-medium text-[#e8e8eb]">Local Models</h1>
                                                <p className="mt-1 text-[12px] text-[#6b6b76]">Manage transcription engines and AI cleanup.</p>
                                            </header>
                                            <div className="rounded-xl border border-[#1e1e22] bg-[#111113]">
                                                <div className="p-4">
                                                    <div className="flex items-center justify-between mb-3">
                                                        <div className="flex items-center gap-3">
                                                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1a1a1e] border border-[#2a2a30]">
                                                                <Wand2 size={14} className="text-[#6b6b76]" />
                                                            </div>
                                                            <div>
                                                                <h3 className="text-[13px] font-medium text-[#e8e8eb]">AI Cleanup</h3>
                                                                <p className="text-[11px] text-[#4a4a54]">Use an LLM to clean up transcriptions</p>
                                                            </div>
                                                        </div>
                                                        <motion.button
                                                            onClick={() => setLlmCleanupEnabled(!llmCleanupEnabled)}
                                                            className={`relative w-10 h-5 rounded-full transition-colors ${llmCleanupEnabled ? "bg-amber-400" : "bg-[#2a2a30]"}`}
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
                                                                <div className="pt-3 border-t border-[#1e1e22] space-y-3">
                                                                    <div className="space-y-1.5">
                                                                        <label className="text-[11px] font-medium text-[#6b6b76] ml-1">Provider</label>
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
                                                                        <label className="text-[11px] font-medium text-[#6b6b76] ml-1 flex items-center gap-1.5">
                                                                            <Server size={10} />
                                                                            Endpoint {llmProvider !== "custom" && <span className="text-[#4a4a54]">(optional override)</span>}
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
                                                                            className="w-full rounded-lg bg-[#1a1a1e] border border-[#2a2a30] py-2 px-3 text-[12px] text-[#e8e8eb] placeholder-[#4a4a54] focus:border-[#4a4a54] focus:outline-none transition-colors"
                                                                        />
                                                                    </div>

                                                                    <div className="space-y-1.5">
                                                                        <label className="text-[11px] font-medium text-[#6b6b76] ml-1 flex items-center gap-1.5">
                                                                            <Key size={10} />
                                                                            API Key {llmProvider !== "openai" && <span className="text-[#4a4a54]">(if required)</span>}
                                                                        </label>
                                                                        <input
                                                                            type="password"
                                                                            value={llmApiKey}
                                                                            onChange={(e) => setLlmApiKey(e.target.value)}
                                                                            placeholder={llmProvider === "openai" ? "sk-..." : "Optional"}
                                                                            className="w-full rounded-lg bg-[#1a1a1e] border border-[#2a2a30] py-2 px-3 text-[12px] text-[#e8e8eb] placeholder-[#4a4a54] focus:border-[#4a4a54] focus:outline-none transition-colors"
                                                                        />
                                                                    </div>

                                                                    <div className="space-y-1.5" ref={modelDropdownRef}>
                                                                        <label className="text-[11px] font-medium text-[#6b6b76] ml-1 flex items-center gap-1.5">
                                                                            <Cpu size={10} />
                                                                            Model {<span className="text-[#4a4a54]">(leave empty for default)</span>}
                                                                        </label>
                                                                        <div className="relative">
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => {
                                                                                    if (!modelDropdownOpen) {
                                                                                        setModelsLoading(true);
                                                                                    }
                                                                                    setModelDropdownOpen(!modelDropdownOpen);
                                                                                }}
                                                                                className="w-full flex items-center justify-between rounded-lg bg-[#1a1a1e] border border-[#2a2a30] py-2 px-3 text-[12px] text-left hover:border-[#3a3a40] focus:border-[#4a4a54] focus:outline-none transition-colors"
                                                                            >
                                                                                <span className={llmModel ? "text-[#e8e8eb]" : "text-[#4a4a54]"}>
                                                                                    {llmModel || (
                                                                                        llmProvider === "lmstudio" ? "Uses loaded model" :
                                                                                            llmProvider === "ollama" ? "llama3.2" :
                                                                                                llmProvider === "openai" ? "gpt-4o-mini" :
                                                                                                    "model-name"
                                                                                    )}
                                                                                </span>
                                                                                <ChevronDown
                                                                                    size={14}
                                                                                    className={`text-[#6b6b76] transition-transform duration-200 ${modelDropdownOpen ? "rotate-180" : ""}`}
                                                                                />
                                                                            </button>
                                                                            <AnimatePresence>
                                                                                {modelDropdownOpen && (
                                                                                    <motion.div
                                                                                        initial={{ opacity: 0, y: -4 }}
                                                                                        animate={{ opacity: 1, y: 0 }}
                                                                                        exit={{ opacity: 0, y: -4 }}
                                                                                        transition={{ duration: 0.15 }}
                                                                                        className="absolute left-0 right-0 top-full mt-1 z-[9999] rounded-lg border border-[#2a2a30] bg-[#141416] shadow-xl shadow-black/40 overflow-hidden"
                                                                                        style={{ maxHeight: "280px" }}
                                                                                    >
                                                                                        <div className="overflow-y-auto" style={{ maxHeight: "220px" }}>
                                                                                            {modelsLoading ? (
                                                                                                <div className="flex items-center justify-center gap-2 py-4 text-[11px] text-[#6b6b76]">
                                                                                                    <Loader2 size={12} className="animate-spin" />
                                                                                                    <span>Loading models...</span>
                                                                                                </div>
                                                                                            ) : availableModels.length > 0 ? (
                                                                                                availableModels.map((model) => (
                                                                                                    <button
                                                                                                        key={model}
                                                                                                        type="button"
                                                                                                        onClick={() => {
                                                                                                            setLlmModel(model);
                                                                                                            setModelDropdownOpen(false);
                                                                                                        }}
                                                                                                        className={`w-full text-left px-3 py-2 text-[12px] transition-colors ${llmModel === model
                                                                                                            ? "bg-amber-400/10 text-amber-400"
                                                                                                            : "text-[#a0a0ab] hover:bg-[#1a1a1e] hover:text-[#e8e8eb]"
                                                                                                            }`}
                                                                                                    >
                                                                                                        {model}
                                                                                                    </button>
                                                                                                ))
                                                                                            ) : (
                                                                                                <div className="px-3 py-4 text-[11px] text-[#6b6b76] text-center">
                                                                                                    No models found. Check endpoint.
                                                                                                </div>
                                                                                            )}
                                                                                        </div>
                                                                                        <div className="border-t border-[#2a2a30] p-2">
                                                                                            <input
                                                                                                type="text"
                                                                                                value={llmModel}
                                                                                                onChange={(e) => setLlmModel(e.target.value)}
                                                                                                placeholder="Or type custom model name..."
                                                                                                className="w-full rounded-md bg-[#1a1a1e] border border-[#2a2a30] py-1.5 px-2.5 text-[11px] text-[#e8e8eb] placeholder-[#4a4a54] focus:border-[#4a4a54] focus:outline-none transition-colors"
                                                                                                onClick={(e) => e.stopPropagation()}
                                                                                            />
                                                                                        </div>
                                                                                    </motion.div>
                                                                                )}
                                                                            </AnimatePresence>
                                                                        </div>
                                                                    </div>

                                                                    <div className="flex items-start gap-2 rounded-lg border border-[#2a2a30] bg-[#1a1a1e] px-3 py-2">
                                                                        <Info size={12} className="text-[#6b6b76] shrink-0 mt-0.5" />
                                                                        <p className="text-[10px] text-[#6b6b76]">
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
                                                <div className="flex items-center gap-2 mb-3">
                                                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#1a1a1e] border border-[#2a2a30]">
                                                        <Cpu size={12} className="text-[#6b6b76]" />
                                                    </div>
                                                    <h3 className="text-[12px] font-medium text-[#a0a0ab]">Transcription Engines</h3>
                                                </div>
                                                <div className="space-y-2">
                                                    {modelCatalog.map((model, index) => {
                                                        const modelStat = modelStatus[model.key];
                                                        const progress = downloadState[model.key];
                                                        const installed = modelStat?.installed;
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
                                                                            {model.tags.map(tag => {
                                                                                const isRecommended = tag.toLowerCase() === "recommended";
                                                                                return (
                                                                                    <span
                                                                                        key={tag}
                                                                                        className={
                                                                                            isRecommended
                                                                                                ? "px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border bg-[#A5B4FD26] text-[#A5B4FD] border-[#A5B4FD66]"
                                                                                                : "px-1.5 py-0.5 rounded text-[9px] font-medium bg-[#1a1a1e] text-[#6b6b76] border border-[#2a2a30]"
                                                                                        }
                                                                                    >
                                                                                        {tag}
                                                                                    </span>
                                                                                );
                                                                            })}
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
                                                                {(isDownloading || !installed) && (
                                                                    <div className="mt-3">
                                                                        <ModelProgress percent={percent} status={progress?.status ?? "idle"} />
                                                                        {isDownloading && (
                                                                            <p className="mt-1.5 text-[10px] text-[#6b6b76] tabular-nums truncate">
                                                                                {progress?.percent?.toFixed(0)}% · {(progress as Extract<DownloadEvent, { status: "downloading" }>).file}
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
                                            className="space-y-5"
                                        >
                                            <header>
                                                <h1 className="text-lg font-medium text-[#e8e8eb]">Advanced</h1>
                                                <p className="mt-1 text-[12px] text-[#6b6b76]">System permissions and troubleshooting.</p>
                                            </header>

                                            <div className="space-y-3">
                                                <p className="text-[10px] font-medium uppercase tracking-wider text-[#4a4a54] px-1">Permissions</p>

                                                {/* Microphone Permission */}
                                                <div className="rounded-xl border border-[#1e1e22] bg-[#111113] p-4">
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex items-center gap-3">
                                                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1a1a1e] border border-[#2a2a30]">
                                                                <Mic size={16} className="text-[#6b6b76]" />
                                                            </div>
                                                            <div>
                                                                <p className="text-[13px] font-medium text-[#e8e8eb]">Microphone Access</p>
                                                                <p className="text-[11px] text-[#6b6b76]">Required for voice transcription</p>
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-3">
                                                            {micPermission === null ? (
                                                                <span className="text-[11px] text-[#6b6b76] flex items-center gap-1.5">
                                                                    <Loader2 size={11} className="animate-spin" />
                                                                    Checking...
                                                                </span>
                                                            ) : micPermission ? (
                                                                <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                                                                    <Check size={12} />
                                                                    Enabled
                                                                </span>
                                                            ) : (
                                                                <span className="text-[11px] text-amber-400">Not enabled</span>
                                                            )}
                                                            <motion.button
                                                                onClick={() => invoke("open_microphone_settings")}
                                                                className="rounded-lg bg-[#1a1a1e] border border-[#2a2a30] px-3 py-1.5 text-[11px] font-medium text-[#a0a0ab] hover:bg-[#232328] hover:text-[#e8e8eb] transition-colors"
                                                                whileTap={{ scale: 0.97 }}
                                                            >
                                                                Open Settings
                                                            </motion.button>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Accessibility Permission */}
                                                <div className="rounded-xl border border-[#1e1e22] bg-[#111113] p-4">
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex items-center gap-3">
                                                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1a1a1e] border border-[#2a2a30]">
                                                                <Accessibility size={16} className="text-[#6b6b76]" />
                                                            </div>
                                                            <div>
                                                                <p className="text-[13px] font-medium text-[#e8e8eb]">Accessibility Access</p>
                                                                <p className="text-[11px] text-[#6b6b76]">Required for automatic text paste</p>
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-3">
                                                            {accessibilityPermission === null ? (
                                                                <span className="text-[11px] text-[#6b6b76] flex items-center gap-1.5">
                                                                    <Loader2 size={11} className="animate-spin" />
                                                                    Checking...
                                                                </span>
                                                            ) : accessibilityPermission ? (
                                                                <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                                                                    <Check size={12} />
                                                                    Enabled
                                                                </span>
                                                            ) : (
                                                                <span className="text-[11px] text-amber-400">Not enabled</span>
                                                            )}
                                                            <motion.button
                                                                onClick={async () => {
                                                                    try {
                                                                        const granted = await requestAccessibilityPermission();
                                                                        if (!granted) await invoke("open_accessibility_settings");
                                                                    } catch {
                                                                        await invoke("open_accessibility_settings");
                                                                    }
                                                                }}
                                                                className="rounded-lg bg-[#1a1a1e] border border-[#2a2a30] px-3 py-1.5 text-[11px] font-medium text-[#a0a0ab] hover:bg-[#232328] hover:text-[#e8e8eb] transition-colors"
                                                                whileTap={{ scale: 0.97 }}
                                                            >
                                                                Open Settings
                                                            </motion.button>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2 rounded-lg border border-[#2a2a30] bg-[#1a1a1e] px-2 py-2 mt-4">
                                                    <Info size={12} className="text-[#6b6b76] shrink-0" />
                                                    <p className="text-[10px] text-[#6b6b76]">
                                                        After enabling permissions in System Settings, you may need to restart Glimpse for changes to take effect.
                                                    </p>
                                                </div>
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
                                            className="space-y-5"
                                        >
                                            <header>
                                                <h1 className="text-lg font-medium text-[#e8e8eb]">About</h1>
                                                <p className="mt-1 text-[12px] text-[#6b6b76]">App info and setup options.</p>
                                            </header>

                                            <div className="rounded-xl border border-[#1e1e22] bg-[#111113] p-4">
                                                <div className="grid grid-cols-2 gap-4">
                                                    <div>
                                                        <p className="text-[10px] font-medium uppercase tracking-wider text-[#4a4a54] mb-1">Version</p>
                                                        <p className="text-[13px] text-[#e8e8eb]">{appInfo?.version ?? "-"}</p>
                                                    </div>
                                                    <div>
                                                        <p className="text-[10px] font-medium uppercase tracking-wider text-[#4a4a54] mb-1">Storage Used</p>
                                                        <p className="text-[13px] text-[#e8e8eb]">{appInfo ? formatBytes(appInfo.data_dir_size_bytes) : "-"}</p>
                                                    </div>
                                                </div>

                                                <div className="mt-4 pt-3 border-t border-[#1e1e22]">
                                                    <p className="text-[10px] font-medium uppercase tracking-wider text-[#4a4a54] mb-1.5">Data Location</p>
                                                    <button
                                                        type="button"
                                                        onClick={handleOpenDataDir}
                                                        disabled={!appInfo?.data_dir_path}
                                                        className="flex w-full items-center gap-2 px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2a2a30] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                    >
                                                        <FolderOpen size={12} className="text-[#4a4a54] shrink-0" />
                                                        <span className="text-[11px] text-[#6b6b76] font-mono truncate border-b border-dotted border-[#6b6b76] pb-[1px] leading-[1.2]">
                                                            {appInfo?.data_dir_path ?? "-"}
                                                        </span>
                                                    </button>
                                                </div>

                                                <div className="mt-4 pt-3 border-t border-[#1e1e22]">
                                                    <p className="text-[10px] font-medium uppercase tracking-wider text-[#4a4a54] mb-2">Updates</p>
                                                    <UpdateChecker />
                                                </div>
                                            </div>
                                            <div className="space-y-2">
                                                <p className="text-[10px] font-medium uppercase tracking-wider text-[#4a4a54] px-1">Setup</p>
                                                <button
                                                    onClick={async () => {
                                                        try {
                                                            await invoke("reset_onboarding");
                                                            window.location.reload();
                                                        } catch (err) {
                                                            console.error("Failed to restart onboarding:", err);
                                                        }
                                                    }}
                                                    className="w-full flex items-center gap-3 rounded-lg border border-[#1e1e22] bg-[#111113] p-3 text-left hover:bg-[#161618] hover:border-[#2a2a30] transition-colors"
                                                >
                                                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1a1a1e] border border-[#2a2a30]">
                                                        <RotateCcw size={14} className="text-[#6b6b76]" />
                                                    </div>
                                                    <div>
                                                        <p className="text-[12px] font-medium text-[#e8e8eb]">Restart Onboarding</p>
                                                        <p className="text-[10px] text-[#4a4a54]">Re-run the initial setup wizard</p>
                                                    </div>
                                                </button>

                                                <button
                                                    onClick={() => setShowFAQModal(true)}
                                                    className="w-full flex items-center gap-3 rounded-lg border border-[#1e1e22] bg-[#111113] p-3 text-left hover:bg-[#161618] hover:border-[#2a2a30] transition-colors"
                                                >
                                                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1a1a1e] border border-[#2a2a30]">
                                                        <HelpCircle size={14} className="text-[#6b6b76]" />
                                                    </div>
                                                    <div>
                                                        <p className="text-[12px] font-medium text-[#e8e8eb]">FAQ & Help</p>
                                                        <p className="text-[10px] text-[#4a4a54]">Common questions about Glimpse</p>
                                                    </div>
                                                </button>
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
        className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] font-medium transition-all ${active ? "bg-[#1a1a1e] text-[#e8e8eb]" : "text-[#6b6b76] hover:bg-[#1a1a1e] hover:text-[#a0a0ab]"
            }`}
        whileTap={{ scale: 0.98 }}
    >
        <div className={active ? "text-amber-400/80" : "text-[#4a4a54]"}>{icon}</div>
        {label}
    </motion.button>
);

const ModeButton = ({ icon, label, description, active, onClick, variant = "cloud", loading = false }: {
    icon: React.ReactNode; label: string; description: string; active: boolean; onClick: () => void; variant?: "cloud" | "local"; loading?: boolean;
}) => {
    const colors = variant === "cloud"
        ? { border: "border-amber-400/40", bg: "bg-amber-400/10", icon: "text-amber-400", desc: "text-amber-400/60" }
        : { border: "border-[#A5B3FE]/40", bg: "bg-[#A5B3FE]/10", icon: "text-[#A5B3FE]", desc: "text-[#A5B3FE]/60" };

    const isActive = !loading && active;

    return (
        <motion.button
            onClick={onClick}
            className={`rounded-xl border p-3 text-left transition-all ${isActive
                ? `${colors.border} ${colors.bg}`
                : "border-[#2a2a30] bg-[#1a1a1e] hover:border-[#3a3a42]"
                }`}
            whileTap={{ scale: 0.98 }}
        >
            <div className={`mb-1.5 ${isActive ? colors.icon : "text-[#6b6b76]"}`}>{icon}</div>
            <div className={`text-[12px] font-medium ${isActive ? "text-[#e8e8eb]" : "text-[#a0a0ab]"}`}>{label}</div>
            <div className={`text-[10px] ${isActive ? colors.desc : "text-[#4a4a54]"}`}>{description}</div>
        </motion.button>
    );
};

const LlmProviderButton = ({ label, active, onClick }: {
    label: string; active: boolean; onClick: () => void;
}) => (
    <motion.button
        onClick={onClick}
        className={`rounded-lg border py-2 px-3 text-[11px] font-medium transition-all ${active
            ? "border-amber-400/40 bg-amber-400/10 text-amber-400"
            : "border-[#2a2a30] bg-[#1a1a1e] text-[#a0a0ab] hover:border-[#3a3a42] hover:text-[#e8e8eb]"
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
};

export default SettingsModal;
