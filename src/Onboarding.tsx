import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
    checkAccessibilityPermission,
    requestAccessibilityPermission,
    checkMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import {
    Mic,
    Accessibility,
    Sparkles,
    Download,
    Trash2,
    ChevronLeft,
    Server,
    Key,
    Cpu,
    ChevronRight,
    Check,
    ExternalLink,
    Loader2,
    Square,
    Wand2,
    AlertTriangle,
    Mail,
    Lock,
    Eye,
    EyeOff,
    AlertCircle,
    CloudCog,
    HelpCircle,
    User,
    Copy,
} from "lucide-react";
import DotMatrix from "./components/DotMatrix";
import FAQModal from "./components/FAQModal";
import { OAuthProvider } from "appwrite";
import { createAccount, login, createOAuth2Session, updateName, updatePreferences } from "./lib/auth";


type ModelInfo = {
    key: string;
    label: string;
    description: string;
    size_mb: number;
    engine: string;
    variant: string;
    tags: string[];
};

type StoredSettings = {
    local_model?: string;
};

type TranscriptionMode = "cloud" | "local";

type OnboardingStep = "welcome" | "cloud-signin" | "cloud-profile" | "cloud-sync" | "local-model" | "cleanup" | "local-signin" | "microphone" | "accessibility" | "ready";

type LocalDownloadStatus = {
    status: "idle" | "downloading" | "complete" | "error" | "cancelled";
    percent: number;
    file?: string;
    message?: string;
};

type ModelStatus = {
    key: string;
    installed: boolean;
    bytes_on_disk: number;
    missing_files: string[];
    directory: string;
};

interface OnboardingProps {
    onComplete: () => void;
}

const PARAKEET_KEY = "parakeet_tdt_int8";
const WHISPER_KEY = "whisper_large_v3_turbo_q8";

const GlimpseLogo = ({ size = "md" }: { size?: "sm" | "md" | "lg" }) => {
    const [pattern, setPattern] = useState(0);
    const intervalRef = useRef<number | null>(null);

    const sizes = {
        sm: { dot: 5, gap: 4 },
        md: { dot: 10, gap: 7 },
        lg: { dot: 14, gap: 10 },
    }[size];

    const patterns = [
        [true, false, false, true],
        [false, true, true, false],
        [true, true, true, true],
    ];

    const dotColors = ["var(--color-cloud)", "var(--color-local)", "var(--color-local)", "var(--color-cloud)"];

    useEffect(() => {
        intervalRef.current = window.setInterval(() => {
            setPattern(p => (p + 1) % patterns.length);
        }, 700);
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, []);

    const currentPattern = patterns[pattern];
    const gridSize = sizes.dot * 2 + sizes.gap;

    return (
        <div
            className="relative"
            style={{ width: gridSize, height: gridSize }}
        >
            {[0, 1, 2, 3].map((i) => {
                const row = Math.floor(i / 2);
                const col = i % 2;
                const isActive = currentPattern[i];

                return (
                    <motion.div
                        key={i}
                        className="absolute rounded-full"
                        style={{
                            width: sizes.dot,
                            height: sizes.dot,
                            left: col * (sizes.dot + sizes.gap),
                            top: row * (sizes.dot + sizes.gap),
                            backgroundColor: dotColors[i],
                        }}
                        animate={{
                            opacity: isActive ? 1 : 0.15,
                            scale: isActive ? 1 : 0.85,
                        }}
                        transition={{
                            duration: 0.3,
                            ease: "easeOut",
                        }}
                    />
                );
            })}
        </div>
    );
};

const StepIndicator = ({ currentStep, total }: { currentStep: number; total: number }) => (
    <div className="flex items-center gap-1.5">
        {Array.from({ length: total }).map((_, i) => (
            <motion.div
                key={i}
                className="h-1.5 rounded-full bg-amber-400"
                animate={{
                    width: i === currentStep ? 20 : 6,
                    opacity: i <= currentStep ? 1 : 0.25,
                }}
                transition={{ duration: 0.25 }}
            />
        ))}
    </div>
);

const StatusBadge = ({ granted, checking }: { granted: boolean; checking?: boolean }) => {
    if (checking) {
        return (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-content-muted">
                <Loader2 size={11} className="animate-spin" />
                Checking...
            </span>
        );
    }

    if (granted) {
        return (
            <motion.span
                className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
            >
                <Check size={12} />
                Enabled
            </motion.span>
        );
    }

    return (
        <span className="text-[11px] text-content-muted">
            Not enabled
        </span>
    );
};

const modifierOrder = ["Control", "Shift", "Alt", "Command"];

const normalizeModifier = (event: KeyboardEvent): string | null => {
    switch (event.key) {
        case "Control": return "Control";
        case "Shift": return "Shift";
        case "Alt": return "Alt";
        case "Meta": return "Command";
        default: return null;
    }
};

const formatKey = (code: string): string | null => {
    if (code.startsWith("Key")) return code.replace("Key", "");
    if (code.startsWith("Digit")) return code.replace("Digit", "");
    const specialKeys: Record<string, string> = {
        Space: "Space", Backspace: "Backspace", Enter: "Enter", Tab: "Tab",
        ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
        Escape: "Escape", Delete: "Delete", Insert: "Insert", Home: "Home", End: "End",
        PageUp: "PageUp", PageDown: "PageDown", Backquote: "`", Minus: "-", Equal: "=",
        BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";",
        Quote: "'", Comma: ",", Period: ".", Slash: "/",
    };
    if (specialKeys[code]) return specialKeys[code];
    if (code.startsWith("F") && !isNaN(Number(code.slice(1)))) return code;
    return null;
};

const formatShortcutForDisplay = (shortcut: string): string => {
    return shortcut
        .replace(/Control/g, "Ctrl")
        .replace(/Command/g, "⌘")
        .replace(/\+/g, " + ");
};

const Onboarding = ({ onComplete }: OnboardingProps) => {
    const [step, setStep] = useState<OnboardingStep>("welcome");
    // Track where we skipped from for proper back navigation
    const skippedFrom = useRef<OnboardingStep | null>(null);
    const [micPermission, setMicPermission] = useState(false);
    const [accessibilityPermission, setAccessibilityPermission] = useState(false);
    const [isCheckingMic, setIsCheckingMic] = useState(true);
    const [isCheckingAccessibility, setIsCheckingAccessibility] = useState(true);
    const [selectedMode, setSelectedMode] = useState<TranscriptionMode>("cloud");
    const [localModelChoice, setLocalModelChoice] = useState<typeof PARAKEET_KEY | typeof WHISPER_KEY>(WHISPER_KEY);
    const [localDownload, setLocalDownload] = useState<Record<string, LocalDownloadStatus>>({
        [PARAKEET_KEY]: { status: "idle", percent: 0 },
        [WHISPER_KEY]: { status: "idle", percent: 0 },
    });
    const [modelStatus, setModelStatus] = useState<Record<string, ModelStatus>>({});
    const [modelInfo, setModelInfo] = useState<Record<string, ModelInfo>>({});
    const [llmCleanupEnabled, setLlmCleanupEnabled] = useState(false);
    const [llmProvider, setLlmProvider] = useState<"lmstudio" | "ollama" | "openai" | "custom" | "none">("none");
    const [llmEndpoint, setLlmEndpoint] = useState("");
    const [llmApiKey, setLlmApiKey] = useState("");
    const [llmModel, setLlmModel] = useState("");
    const [showLocalConfirm, setShowLocalConfirm] = useState(false);

    const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
    const [authEmail, setAuthEmail] = useState("");
    const [authPassword, setAuthPassword] = useState("");
    const [authName, setAuthName] = useState("");
    const [authShowPassword, setAuthShowPassword] = useState(false);
    const [authLoading, setAuthLoading] = useState(false);
    const [authError, setAuthError] = useState<string | null>(null);
    const [authErrorCopied, setAuthErrorCopied] = useState(false);

    const [cloudSyncEnabled, setCloudSyncEnabled] = useState(false);
    const [showFAQModal, setShowFAQModal] = useState(false);

    const [smartShortcut, setSmartShortcut] = useState("Control+Space");
    const [captureActive, setCaptureActive] = useState(false);
    const pressedModifiers = useRef<Set<string>>(new Set());
    const primaryKey = useRef<string | null>(null);

    const steps: OnboardingStep[] = selectedMode === "cloud"
        ? ["welcome", "cloud-signin", "cloud-profile", "cloud-sync", "microphone", "accessibility", "ready"]
        : ["welcome", "local-model", "cleanup", "microphone", "accessibility", "ready"];
    const currentStepIndex = steps.indexOf(step);

    useEffect(() => {
        if (showLocalConfirm) setShowLocalConfirm(false);
    }, [step]);

    const checkMicPermission = useCallback(async () => {
        try {
            // First try the native plugin
            const nativeGranted = await checkMicrophonePermission();
            if (nativeGranted) {
                setMicPermission(true);
                return;
            }

            try {
                const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
                if (result.state === 'granted') {
                    setMicPermission(true);
                    return;
                }
            } catch {
                // Permissions API not supported or failed
            }

            setMicPermission(false);
        } catch (err) {
            console.error("Failed to check microphone permission:", err);
            setMicPermission(false);
        } finally {
            setIsCheckingMic(false);
        }
    }, []);

    const checkAccessPermission = useCallback(async () => {
        try {
            const granted = await checkAccessibilityPermission();
            setAccessibilityPermission(granted);
        } catch (err) {
            console.error("Failed to check accessibility permission:", err);
        } finally {
            setIsCheckingAccessibility(false);
        }
    }, []);

    useEffect(() => {
        checkMicPermission();
        checkAccessPermission();
    }, [checkMicPermission, checkAccessPermission]);

    useEffect(() => {
        if (step === "microphone") {
            const interval = setInterval(checkMicPermission, 1500);
            return () => clearInterval(interval);
        }
    }, [step, checkMicPermission]);

    useEffect(() => {
        if (step === "accessibility") {
            const interval = setInterval(checkAccessPermission, 800);
            return () => clearInterval(interval);
        }
    }, [step, checkAccessPermission]);

    const handleRequestMicrophoneAccess = async () => {
        try {
            // Use getUserMedia to trigger the native permission dialog
            // This works cross-platform and is more reliable than the plugin
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // Immediately stop the stream - we just needed to trigger the permission
            stream.getTracks().forEach(track => track.stop());
            await checkMicPermission();
        } catch (err) {
            console.error("Failed to request microphone:", err);
            try {
                await invoke("open_microphone_settings");
            } catch (e) {
                console.error("Failed to open settings:", e);
            }
        }
    };

    const handleRequestAccessibilityAccess = async () => {
        try {
            await requestAccessibilityPermission();
            await checkAccessPermission();
        } catch (err) {
            console.error("Failed to request accessibility:", err);
            try {
                await invoke("open_accessibility_settings");
            } catch (e) {
                console.error("Failed to open settings:", e);
            }
        }
    };

    const handleComplete = async () => {
        try {
            localStorage.setItem("glimpse_cloud_sync_enabled", String(cloudSyncEnabled));

            await invoke("update_settings", {
                smartShortcut,
                smartEnabled: true,
                holdShortcut: "Control+Shift+Space",
                holdEnabled: false,
                toggleShortcut: "Control+Alt+Space",
                toggleEnabled: false,
                transcriptionMode: selectedMode,
                localModel: localModelChoice,
                microphoneDevice: null,
                language: "en",
                llmCleanupEnabled,
                llmProvider,
                llmEndpoint,
                llmApiKey,
                llmModel,
                userContext: "",
                editModeEnabled: false,
            });
            await invoke("complete_onboarding");
            onComplete();
        } catch (err) {
            console.error("Failed to save onboarding settings:", err);
            onComplete();
        }
    };

    const goToNextStep = () => {
        const nextIndex = currentStepIndex + 1;
        if (nextIndex < steps.length) {
            setStep(steps[nextIndex]);
        }
    };

    const goToPrevStep = () => {
        // If we skipped steps to get here, go back to where we skipped from
        if (skippedFrom.current) {
            setStep(skippedFrom.current);
            skippedFrom.current = null;
            return;
        }
        const prevIndex = currentStepIndex - 1;
        if (prevIndex >= 0) {
            setStep(steps[prevIndex]);
        }
    };

    const finalizeCapture = () => {
        setCaptureActive(false);
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
                setSmartShortcut(combo);
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

    const refreshModelStatus = useCallback((modelKey: string) => {
        invoke<ModelStatus>("check_model_status", { model: modelKey })
            .then((status) => {
                setModelStatus((prev) => ({ ...prev, [modelKey]: status }));
            })
            .catch((err) => console.error("Failed to check model status", err));
    }, []);

    useEffect(() => {
        let isMounted = true;
        const load = async () => {
            try {
                const [models, settings] = await Promise.all([
                    invoke<ModelInfo[]>("list_models"),
                    invoke<StoredSettings>("get_settings"),
                ]);
                if (!isMounted) return;
                const infoMap: Record<string, ModelInfo> = {};
                models.forEach((model) => {
                    infoMap[model.key] = model;
                    refreshModelStatus(model.key);
                });
                setModelInfo(infoMap);
                if (
                    settings?.local_model &&
                    (settings.local_model === PARAKEET_KEY || settings.local_model === WHISPER_KEY)
                ) {
                    setLocalModelChoice(settings.local_model as typeof PARAKEET_KEY | typeof WHISPER_KEY);
                }
            } catch (err) {
                console.error("Failed to preload model info", err);
                if (!isMounted) return;
                [PARAKEET_KEY, WHISPER_KEY].forEach((model) => refreshModelStatus(model));
            }
        };
        load();
        return () => {
            isMounted = false;
        };
    }, [refreshModelStatus]);

    useEffect(() => {
        let active = true;
        const disposers: UnlistenFn[] = [];

        const setup = async () => {
            try {
                const results = await Promise.allSettled([
                    listen<{ model: string; percent: number; downloaded: number; total: number; file: string }>(
                        "download:progress",
                        (event) => {
                            const payload = event.payload;
                            setLocalDownload((prev) => ({
                                ...prev,
                                [payload.model]: {
                                    status: "downloading",
                                    percent: Math.min(100, payload.percent),
                                    file: payload.file,
                                },
                            }));
                        }
                    ),
                    listen<{ model: string }>("download:complete", (event) => {
                        const model = event.payload.model;
                        setLocalDownload((prev) => ({
                            ...prev,
                            [model]: {
                                status: "complete",
                                percent: 100,
                                file: prev[model]?.file,
                                message: prev[model]?.message,
                            },
                        }));
                        refreshModelStatus(model as "parakeet_tdt_int8" | "whisper_small_q5");
                    }),
                    listen<{ model: string; error: string }>("download:error", (event) => {
                        const { model, error } = event.payload;
                        if (error.toLowerCase().includes("cancelled")) return;
                        setLocalDownload((prev) => ({
                            ...prev,
                            [model]: { status: "error", percent: prev[model]?.percent ?? 0, message: error },
                        }));
                    }),
                ]);

                results.forEach((res) => {
                    if (res.status === "fulfilled") {
                        if (!active) {
                            res.value();
                        } else {
                            disposers.push(res.value);
                        }
                    } else {
                        console.error("Failed to set up download listener", res.reason);
                    }
                });
            } catch (err) {
                console.error("Failed to set up download listeners", err);
            }
        };

        setup();

        return () => {
            active = false;
            disposers.forEach((fn) => fn());
        };
    }, [refreshModelStatus]);

    const handleLocalDownload = async (modelKey: typeof PARAKEET_KEY | typeof WHISPER_KEY) => {
        setLocalDownload((prev) => ({
            ...prev,
            [modelKey]: { status: "downloading", percent: 0, file: "starting..." },
        }));
        try {
            await invoke("download_model", { model: modelKey });
        } catch (err) {
            const errorMsg = String(err);
            if (errorMsg.toLowerCase().includes("cancelled")) {
                return;
            }
            console.error(err);
            setLocalDownload((prev) => ({
                ...prev,
                [modelKey]: { status: "error", percent: 0, message: "Download failed" },
            }));
        }
    };

    const handleLocalDelete = async (modelKey: typeof PARAKEET_KEY | typeof WHISPER_KEY) => {
        try {
            await invoke("delete_model", { model: modelKey });
            setLocalDownload((prev) => ({
                ...prev,
                [modelKey]: { status: "idle", percent: 0 },
            }));
            refreshModelStatus(modelKey);
        } catch (err) {
            console.error(err);
            setLocalDownload((prev) => ({
                ...prev,
                [modelKey]: { status: "error", percent: prev[modelKey]?.percent ?? 0, message: "Delete failed" },
            }));
        }
    };

    const handleCancelDownload = async (modelKey: typeof PARAKEET_KEY | typeof WHISPER_KEY) => {
        try {
            await invoke("cancel_download", { model: modelKey });
            setLocalDownload((prev) => ({
                ...prev,
                [modelKey]: { status: "cancelled", percent: 0 },
            }));
            // Auto-clear after brief display
            setTimeout(() => {
                setLocalDownload((prev) => {
                    if (prev[modelKey]?.status === "cancelled") {
                        return { ...prev, [modelKey]: { status: "idle", percent: 0 } };
                    }
                    return prev;
                });
            }, 1500);
        } catch (err) {
            console.error("Failed to cancel download:", err);
        }
    };

    const displayState = useMemo(() => {
        const buildState = (key: typeof PARAKEET_KEY | typeof WHISPER_KEY) => {
            const installed = modelStatus[key]?.installed;
            const base = localDownload[key];
            if (installed) {
                return {
                    status: "complete" as const,
                    percent: 100,
                    file: base?.file,
                    message: base?.message,
                };
            }
            return base ?? { status: "idle", percent: 0 };
        };
        return {
            parakeet: buildState(PARAKEET_KEY),
            whisper: buildState(WHISPER_KEY),
        };
    }, [localDownload, modelStatus]);

    const parakeetInstalled = modelStatus[PARAKEET_KEY]?.installed || displayState.parakeet.status === "complete";
    const whisperInstalled = modelStatus[WHISPER_KEY]?.installed || displayState.whisper.status === "complete";
    const isParakeetActive = localModelChoice === PARAKEET_KEY && parakeetInstalled;
    const isWhisperActive = localModelChoice === WHISPER_KEY && whisperInstalled;

    const selectedModelReady = useMemo(() => {
        const selectedKey = localModelChoice;
        const isParakeet = selectedKey === PARAKEET_KEY;
        const ready =
            (isParakeet
                ? modelStatus[PARAKEET_KEY]?.installed || displayState.parakeet.status === "complete"
                : modelStatus[WHISPER_KEY]?.installed || displayState.whisper.status === "complete");
        return !!ready;
    }, [localModelChoice, displayState.parakeet.status, displayState.whisper.status, modelStatus]);

    const handleLocalModelContinue = () => {
        if (!selectedModelReady) {
            setShowLocalConfirm(true);
            return;
        }
        goToNextStep();
    };

    return (
        <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface-secondary text-white select-none relative">
            <div data-tauri-drag-region className="h-7 w-full shrink-0" />

            <div className="flex justify-center pt-6 pb-6">
                <StepIndicator currentStep={currentStepIndex} total={steps.length} />
            </div>

            <div className="flex-1 flex items-center justify-center px-10 pb-10">
                <AnimatePresence mode="wait">
                    {step === "welcome" && (
                        <motion.div
                            key="welcome"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center w-full max-w-5xl"
                        >
                            <div className="mb-6">
                                <GlimpseLogo size="lg" />
                            </div>

                            <h1 className="text-2xl font-semibold text-content-primary mb-2">
                                Welcome to Glimpse
                            </h1>

                            <p className="text-sm text-content-muted mb-8">
                                Build at the speed of speech.
                            </p>

                            <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                                <button
                                    type="button"
                                    onClick={() => setSelectedMode("cloud")}
                                    className={`group relative w-full rounded-2xl border border-border-primary bg-surface-tertiary p-4 text-left space-y-3 shadow-[0_10px_24px_rgba(0,0,0,0.28)] overflow-hidden transition-all ${selectedMode === "cloud" ? "ring-1 ring-amber-400/50" : ""
                                        }`}
                                    aria-pressed={selectedMode === "cloud"}
                                >
                                    <div className="absolute inset-0 pointer-events-none">
                                        <div className="absolute inset-0 opacity-18">
                                            <DotMatrix rows={6} cols={18} activeDots={[1, 4, 7, 10, 12, 15, 18, 20, 23, 26, 29, 32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 65, 68]} dotSize={2} gap={4} color="var(--color-border-secondary)" />
                                        </div>
                                    </div>
                                    <div className="relative flex items-center gap-2">
                                        <DotMatrix rows={2} cols={2} activeDots={[0, 3]} dotSize={3} gap={2} color="var(--color-cloud)" />
                                        <span className="text-[10px] font-semibold text-amber-400">Glimpse Cloud</span>
                                    </div>
                                    <div className="relative flex flex-col gap-1.5 text-[11px] text-content-secondary font-medium">
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
                                            <span>Faster cleanup & delivery</span>
                                        </div>
                                    </div>
                                    <div className="relative flex items-center gap-3 rounded-xl border border-border-primary bg-surface-tertiary px-3 py-2 text-[10px] text-content-secondary leading-relaxed">
                                        <DotMatrix rows={3} cols={5} activeDots={[0, 2, 4, 6, 8, 10, 12, 14]} dotSize={2} gap={2} color="var(--color-border-secondary)" />
                                        <p className="flex-1">Get better models and faster cleanup & delivery ($5.99/mo) with cloud.</p>
                                    </div>
                                </button>

                                <button
                                    type="button"
                                    onClick={() => setSelectedMode("local")}
                                    className={`group relative w-full rounded-2xl border p-4 text-left space-y-3 shadow-[0_10px_24px_rgba(0,0,0,0.18)] overflow-hidden transition-colors ${selectedMode === "local"
                                        ? "border-local-50 bg-surface-tertiary ring-1 ring-local-30"
                                        : "border-border-primary bg-surface-tertiary"
                                        }`}
                                    aria-pressed={selectedMode === "local"}
                                >
                                    <div className="absolute inset-0 pointer-events-none">
                                        <div className="absolute inset-0 opacity-14">
                                            <DotMatrix rows={6} cols={18} activeDots={[0, 3, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 65, 68]} dotSize={2} gap={4} color="var(--color-border-primary)" />
                                        </div>
                                    </div>
                                    <div className="relative flex items-center gap-2">
                                        <DotMatrix rows={2} cols={2} activeDots={[1, 2]} dotSize={3} gap={2} color="var(--color-local)" />
                                        <span className="text-[10px] font-semibold text-local">Glimpse Local</span>
                                    </div>
                                    <div className="relative flex flex-col gap-1.5 text-[11px] text-content-secondary font-medium">
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-local-80" />
                                            <span>Everything stays on-device for privacy </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-local-80" />
                                            <span>Local models</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-local-80" />
                                            <span>free optional Cloud transcription sync</span>
                                        </div>
                                    </div>
                                    <div className="relative flex items-center gap-3 rounded-xl border border-border-primary bg-surface-tertiary px-3 py-2 text-[10px] text-content-muted leading-relaxed">
                                        <DotMatrix rows={3} cols={5} activeDots={[1, 4, 6, 9, 12, 15, 18, 21]} dotSize={2} gap={2} color="var(--color-local)" />
                                        <p className="flex-1">Best for privacy-first or offline sessions. Cloud remains optional if you want sync and faster responses.</p>
                                    </div>
                                </button>
                            </div>

                            <button
                                onClick={goToNextStep}
                                className="flex items-center justify-center gap-2 rounded-lg bg-content-primary px-5 py-2.5 text-sm font-mono font-semibold text-surface-secondary hover:bg-white transition-colors min-w-[150px] tracking-tight"
                            >
                                {selectedMode === "cloud" ? "> Cloud" : "> Local"}
                            </button>
                        </motion.div>
                    )}

                    {step === "cloud-signin" && (
                        <motion.div
                            key="cloud-signin"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center w-full max-w-sm"
                        >
                            <h2 className="text-xl font-semibold text-content-primary mb-1">
                                {authMode === "signin" ? "Sign in to Glimpse Cloud" : "Create your account"}
                            </h2>
                            <p className="text-sm text-content-muted mb-6">
                                {authMode === "signin"
                                    ? "Sync transcriptions across devices"
                                    : "Get started with Glimpse Cloud"}
                            </p>

                            {authError && (
                                <motion.div
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="w-full mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400"
                                >
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
                                </motion.div>
                            )}

                            <form
                                className="w-full space-y-3"
                                onSubmit={async (e) => {
                                    e.preventDefault();
                                    setAuthError(null);
                                    setAuthLoading(true);
                                    try {
                                        if (authMode === "signup") {
                                            await createAccount(authEmail, authPassword, authName || undefined);
                                        } else {
                                            await login(authEmail, authPassword);
                                        }
                                        goToNextStep();
                                    } catch (err) {
                                        setAuthError(err instanceof Error ? err.message : "Authentication failed");
                                    } finally {
                                        setAuthLoading(false);
                                    }
                                }}
                            >
                                {authMode === "signup" && (
                                    <div className="relative">
                                        <input
                                            type="text"
                                            placeholder="Name (optional)"
                                            value={authName}
                                            onChange={(e) => setAuthName(e.target.value)}
                                            className="w-full rounded-lg border border-border-primary bg-surface-surface px-4 py-3 pl-11 text-sm text-white placeholder-content-disabled outline-none transition-colors focus:border-border-hover focus:bg-surface-overlay"
                                        />
                                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-content-disabled">
                                            <Mail size={16} />
                                        </div>
                                    </div>
                                )}

                                <div className="relative">
                                    <input
                                        type="email"
                                        placeholder="Email"
                                        value={authEmail}
                                        onChange={(e) => setAuthEmail(e.target.value)}
                                        required
                                        className="w-full rounded-lg border border-border-primary bg-surface-surface px-4 py-3 pl-11 text-sm text-white placeholder-content-disabled outline-none transition-colors focus:border-border-hover focus:bg-surface-overlay"
                                    />
                                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-content-disabled">
                                        <Mail size={16} />
                                    </div>
                                </div>

                                <div className="relative">
                                    <input
                                        type={authShowPassword ? "text" : "password"}
                                        placeholder="Password"
                                        value={authPassword}
                                        onChange={(e) => setAuthPassword(e.target.value)}
                                        required
                                        minLength={8}
                                        className="w-full rounded-lg border border-border-primary bg-surface-surface px-4 py-3 pl-11 pr-11 text-sm text-white placeholder-content-disabled outline-none transition-colors focus:border-border-hover focus:bg-surface-overlay"
                                    />
                                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-content-disabled">
                                        <Lock size={16} />
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setAuthShowPassword(!authShowPassword)}
                                        className="absolute right-4 top-1/2 -translate-y-1/2 text-content-disabled hover:text-content-muted transition-colors"
                                    >
                                        {authShowPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                    </button>
                                </div>

                                <button
                                    type="submit"
                                    disabled={authLoading}
                                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-content-primary px-5 py-3 text-sm font-semibold text-surface-secondary hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {authLoading ? (
                                        <>
                                            <Loader2 size={16} className="animate-spin" />
                                            {authMode === "signin" ? "Signing in..." : "Creating account..."}
                                        </>
                                    ) : authMode === "signin" ? (
                                        "Sign In"
                                    ) : (
                                        "Create Account"
                                    )}
                                </button>
                            </form>

                            <div className="my-5 flex w-full items-center gap-3">
                                <div className="flex-1 h-px bg-border-primary" />
                                <span className="text-xs text-content-disabled">or continue with</span>
                                <div className="flex-1 h-px bg-border-primary" />
                            </div>

                            <div className="grid grid-cols-2 gap-3 w-full">
                                <button
                                    type="button"
                                    onClick={() => createOAuth2Session(OAuthProvider.Google)}
                                    className="flex items-center justify-center gap-2 rounded-lg border border-border-primary bg-surface-surface px-4 py-2.5 text-sm text-content-secondary hover:bg-surface-overlay hover:border-border-secondary transition-colors"
                                >
                                    <svg className="w-4 h-4" viewBox="0 0 24 24">
                                        <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                                        <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                                        <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                                        <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                                    </svg>
                                    Google
                                </button>

                                <button
                                    type="button"
                                    onClick={() => createOAuth2Session(OAuthProvider.Github)}
                                    className="flex items-center justify-center gap-2 rounded-lg border border-border-primary bg-surface-surface px-4 py-2.5 text-sm text-content-secondary hover:bg-surface-overlay hover:border-border-secondary transition-colors"
                                >
                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385c.6.105.825-.255.825-.57c0-.285-.015-1.23-.015-2.235c-3.015.555-3.795-.735-4.035-1.41c-.135-.345-.72-1.41-1.23-1.695c-.42-.225-1.02-.78-.015-.795c.945-.015 1.62.87 1.845 1.23c1.08 1.815 2.805 1.305 3.495.99c.105-.78.42-1.305.765-1.605c-2.67-.3-5.46-1.335-5.46-5.925c0-1.305.465-2.385 1.23-3.225c-.12-.3-.54-1.53.12-3.18c0 0 1.005-.315 3.3 1.23c.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23c.66 1.65.24 2.88.12 3.18c.765.84 1.23 1.905 1.23 3.225c0 4.605-2.805 5.625-5.475 5.925c.435.375.81 1.095.81 2.22c0 1.605-.015 2.895-.015 3.3c0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                                    </svg>
                                    GitHub
                                </button>
                            </div>

                            <p className="mt-5 text-sm text-content-muted">
                                {authMode === "signin" ? (
                                    <>
                                        Don't have an account?{" "}
                                        <button
                                            type="button"
                                            onClick={() => { setAuthMode("signup"); setAuthError(null); }}
                                            className="text-amber-400 hover:text-amber-300 transition-colors"
                                        >
                                            Sign up
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        Already have an account?{" "}
                                        <button
                                            type="button"
                                            onClick={() => { setAuthMode("signin"); setAuthError(null); }}
                                            className="text-amber-400 hover:text-amber-300 transition-colors"
                                        >
                                            Sign in
                                        </button>
                                    </>
                                )}
                            </p>
                        </motion.div>
                    )}

                    {step === "cloud-profile" && (
                        <motion.div
                            key="cloud-profile"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center w-full max-w-sm"
                        >
                            <h2 className="text-xl font-semibold text-content-primary mb-1">
                                Welcome to Glimpse!
                            </h2>
                            <p className="text-sm text-content-muted mb-6">
                                Let's personalize your experience
                            </p>

                            <form
                                className="w-full space-y-4"
                                onSubmit={async (e) => {
                                    e.preventDefault();
                                    setAuthLoading(true);
                                    try {
                                        if (authName.trim()) {
                                            await updateName(authName.trim());
                                        }
                                        goToNextStep();
                                    } catch (err) {
                                        console.error("Failed to update name:", err);
                                        goToNextStep();
                                    } finally {
                                        setAuthLoading(false);
                                    }
                                }}
                            >
                                <div className="relative">
                                    <input
                                        type="text"
                                        placeholder="What should we call you?"
                                        value={authName}
                                        onChange={(e) => setAuthName(e.target.value)}
                                        autoFocus
                                        className="w-full rounded-lg border border-border-primary bg-surface-surface px-4 py-3 text-sm text-white text-center placeholder-content-disabled outline-none transition-colors focus:border-border-hover focus:bg-surface-overlay"
                                    />
                                </div>

                                <button
                                    type="submit"
                                    disabled={authLoading}
                                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-content-primary px-5 py-3 text-sm font-semibold text-surface-secondary hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {authLoading ? (
                                        <>
                                            <Loader2 size={16} className="animate-spin" />
                                            Saving...
                                        </>
                                    ) : (
                                        "Continue"
                                    )}
                                </button>
                            </form>

                            <button
                                type="button"
                                onClick={goToNextStep}
                                className="mt-4 text-xs text-content-disabled hover:text-content-muted transition-colors"
                            >
                                Skip for now
                            </button>
                        </motion.div>
                    )}

                    {step === "cloud-sync" && (
                        <motion.div
                            key="cloud-sync"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center w-full max-w-sm"
                        >
                            <div className="mb-4 rounded-2xl bg-amber-400/10 p-4">
                                <CloudCog size={32} className="text-amber-400" />
                            </div>
                            <h2 className="text-xl font-semibold text-content-primary mb-2">
                                Sync your history?
                            </h2>
                            <p className="text-sm text-content-muted mb-8 leading-relaxed max-w-[280px]">
                                We can securely sync your transcription text (not audio) to the cloud so you can access it anywhere.
                            </p>

                            <div className="w-full space-y-4">
                                <div
                                    className="flex items-center justify-between rounded-xl border border-border-primary bg-surface-surface p-4 cursor-pointer hover:border-border-secondary transition-colors"
                                    onClick={() => setCloudSyncEnabled(!cloudSyncEnabled)}
                                >
                                    <div className="flex flex-col items-start gap-1">
                                        <span className="text-sm font-medium text-content-primary">History Sync</span>
                                        <span className="text-[11px] text-content-muted">Encrypted text-only backup</span>
                                    </div>
                                    <div className={`relative w-11 h-6 rounded-full transition-colors ${cloudSyncEnabled ? "bg-amber-400" : "bg-border-secondary"}`}>
                                        <div className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform ${cloudSyncEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
                                    </div>
                                </div>

                                <button
                                    onClick={goToNextStep}
                                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-content-primary px-5 py-3 text-sm font-semibold text-surface-secondary hover:bg-white transition-colors"
                                >
                                    Continue
                                </button>
                            </div>
                        </motion.div>
                    )}

                    {step === "local-model" && (
                        <motion.div
                            key="local-model"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center w-full max-w-2xl"
                        >

                            <h2 className="text-xl font-semibold text-content-primary mb-1">
                                Choose your local model
                            </h2>
                            <div className="mb-6 flex flex-col gap-1 text-sm text-content-muted">
                                <p>Pick a model, then download it. You can add more in Settings later.</p>
                                <p className="text-xs text-content-disabled">Both models work offline; choose one and get it ready.</p>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
                                <div
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => setLocalModelChoice(WHISPER_KEY)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            setLocalModelChoice(WHISPER_KEY);
                                        }
                                    }}
                                    className={`relative w-full rounded-2xl border p-4 text-left space-y-3 shadow-[0_10px_24px_rgba(0,0,0,0.16)] overflow-hidden transition-colors cursor-pointer ${isWhisperActive
                                        ? "border-border-primary bg-amber-400/5 ring-1 ring-amber-400/60"
                                        : localModelChoice === WHISPER_KEY
                                            ? "border-border-primary bg-surface-tertiary ring-1 ring-amber-400/30"
                                            : "border-border-primary bg-surface-tertiary hover:border-border-hover"
                                        }`}
                                >
                                    <div className="absolute inset-0 pointer-events-none">
                                        <div className="absolute inset-0 opacity-10">
                                            <DotMatrix rows={6} cols={18} activeDots={[1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65]} dotSize={2} gap={4} color="var(--color-border-primary)" />
                                        </div>
                                    </div>
                                    <div className="relative flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <DotMatrix rows={2} cols={2} activeDots={[1, 2]} dotSize={3} gap={2} color="var(--color-local)" />
                                            <span className="text-[11px] font-semibold text-content-primary">Whisper Large V3 Turbo (Q8)</span>
                                            {modelInfo[WHISPER_KEY]?.size_mb && (
                                                <span className="text-[9px] text-content-muted tabular-nums">{modelInfo[WHISPER_KEY].size_mb >= 1000 ? `${(modelInfo[WHISPER_KEY].size_mb / 1000).toFixed(1)} GB` : `${Math.round(modelInfo[WHISPER_KEY].size_mb)} MB`}</span>
                                            )}
                                        </div>
                                        <span
                                            className={`px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border ${isWhisperActive
                                                ? "bg-amber-400/20 text-amber-400 border-amber-400/40"
                                                : "opacity-0 border-transparent text-transparent pointer-events-none select-none"
                                                }`}
                                        >
                                            Active
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border bg-local-15 text-local border-local-40">
                                            Recommended
                                        </span>
                                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border ${whisperInstalled
                                            ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                            : "bg-surface-elevated text-content-tertiary border-border-secondary"
                                            }`}>
                                            {whisperInstalled ? "Ready" : "Download needed"}
                                        </span>
                                    </div>
                                    <div className="relative space-y-1.5 text-[11px] text-content-secondary font-medium">
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-content-tertiary" />
                                            <span>Good quality, balanced speed</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-content-tertiary" />
                                            <span>Supports custom words</span>
                                        </div>
                                    </div>
                                    <div className="relative rounded-lg border border-border-primary bg-surface-tertiary px-3 py-2 text-[10px] text-content-tertiary leading-relaxed space-y-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-semibold text-content-secondary">Download</span>
                                            <button
                                                aria-label={displayState.whisper.status === "downloading" ? "Stop download" : displayState.whisper.status === "complete" ? "Delete model" : "Download model"}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (displayState.whisper.status === "downloading") {
                                                        handleCancelDownload(WHISPER_KEY);
                                                    } else if (displayState.whisper.status === "complete") {
                                                        handleLocalDelete(WHISPER_KEY);
                                                    } else if (displayState.whisper.status !== "cancelled") {
                                                        handleLocalDownload(WHISPER_KEY);
                                                    }
                                                }}
                                                disabled={displayState.whisper.status === "cancelled"}
                                                className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${displayState.whisper.status === "downloading"
                                                    ? "border-error/30 text-error hover:bg-error/10"
                                                    : displayState.whisper.status === "complete"
                                                        ? "border-error/30 text-error hover:bg-error/10"
                                                        : displayState.whisper.status === "cancelled"
                                                            ? "border-border-secondary text-content-disabled cursor-default"
                                                            : "border-border-secondary text-content-primary hover:border-border-hover"
                                                    }`}
                                            >
                                                {displayState.whisper.status === "downloading" ? (
                                                    <Square size={10} className="fill-current" />
                                                ) : displayState.whisper.status === "complete" ? (
                                                    <Trash2 size={10} />
                                                ) : (
                                                    <Download size={10} className={displayState.whisper.status === "cancelled" ? "" : "text-cloud"} />
                                                )}
                                            </button>
                                        </div>
                                        <ModelProgress percent={displayState.whisper.percent} status={displayState.whisper.status} />
                                        <div className="h-4 flex items-center">
                                            {displayState.whisper.status === "downloading" && (
                                                <p className="text-[10px] leading-none text-content-muted tabular-nums truncate w-full">
                                                    {displayState.whisper.percent.toFixed(0)}% · {displayState.whisper.file ?? ""}
                                                </p>
                                            )}
                                            {displayState.whisper.status === "error" && (
                                                <p className="text-[10px] leading-none text-error truncate w-full">
                                                    {displayState.whisper.message ?? "Download failed"}
                                                </p>
                                            )}
                                            {displayState.whisper.status === "cancelled" && (
                                                <p className="text-[10px] leading-none text-content-muted">
                                                    Cancelled
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => setLocalModelChoice(PARAKEET_KEY)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            setLocalModelChoice(PARAKEET_KEY);
                                        }
                                    }}
                                    className={`relative w-full rounded-2xl border border-border-primary p-4 text-left space-y-3 shadow-[0_10px_24px_rgba(0,0,0,0.2)] overflow-hidden transition-colors cursor-pointer ${isParakeetActive
                                        ? "bg-amber-400/5 ring-1 ring-amber-400/60"
                                        : localModelChoice === PARAKEET_KEY
                                            ? "bg-surface-tertiary ring-1 ring-amber-400/30"
                                            : "bg-surface-tertiary hover:border-border-secondary"
                                        }`}
                                >
                                    <div className="absolute inset-0 pointer-events-none">
                                        <div className="absolute inset-0 opacity-12">
                                            <DotMatrix rows={6} cols={18} activeDots={[0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66]} dotSize={2} gap={4} color="var(--color-border-primary)" />
                                        </div>
                                    </div>
                                    <div className="relative flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <DotMatrix rows={2} cols={2} activeDots={[0]} dotSize={3} gap={2} color="var(--color-cloud)" />
                                            <span className="text-[11px] font-semibold text-content-primary">Parakeet (INT8)</span>
                                            {modelInfo[PARAKEET_KEY]?.size_mb && (
                                                <span className="text-[9px] text-content-muted tabular-nums">{modelInfo[PARAKEET_KEY].size_mb >= 1000 ? `${(modelInfo[PARAKEET_KEY].size_mb / 1000).toFixed(1)} GB` : `${Math.round(modelInfo[PARAKEET_KEY].size_mb)} MB`}</span>
                                            )}
                                        </div>
                                        <span
                                            className={`px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border ${isParakeetActive
                                                ? "bg-amber-400/20 text-amber-400 border-amber-400/40"
                                                : "opacity-0 border-transparent text-transparent pointer-events-none select-none"
                                                }`}
                                        >
                                            Active
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border ${parakeetInstalled
                                            ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                            : "bg-surface-elevated text-content-tertiary border-border-secondary"
                                            }`}>
                                            {parakeetInstalled ? "Ready" : "Download needed"}
                                        </span>
                                    </div>
                                    <div className="relative space-y-1.5 text-[11px] text-content-secondary font-medium">
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-content-tertiary" />
                                            <span>Good accuracy, fast</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-content-tertiary" />
                                            <span>Multilingual</span>
                                        </div>
                                    </div>
                                    <div className="relative rounded-lg border border-border-primary bg-surface-elevated px-3 py-2 text-[10px] text-content-tertiary leading-relaxed space-y-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-semibold text-content-secondary">Download</span>
                                            <button
                                                aria-label={displayState.parakeet.status === "downloading" ? "Stop download" : displayState.parakeet.status === "complete" ? "Delete model" : "Download model"}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (displayState.parakeet.status === "downloading") {
                                                        handleCancelDownload(PARAKEET_KEY);
                                                    } else if (displayState.parakeet.status === "complete") {
                                                        handleLocalDelete(PARAKEET_KEY);
                                                    } else if (displayState.parakeet.status !== "cancelled") {
                                                        handleLocalDownload(PARAKEET_KEY);
                                                    }
                                                }}
                                                disabled={displayState.parakeet.status === "cancelled"}
                                                className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${displayState.parakeet.status === "downloading"
                                                    ? "border-error/30 text-error hover:bg-error/10"
                                                    : displayState.parakeet.status === "complete"
                                                        ? "border-error/30 text-error hover:bg-error/10"
                                                        : displayState.parakeet.status === "cancelled"
                                                            ? "border-border-secondary text-content-disabled cursor-default"
                                                            : "border-border-secondary text-content-primary hover:border-border-hover"
                                                    }`}
                                            >
                                                {displayState.parakeet.status === "downloading" ? (
                                                    <Square size={10} className="fill-current" />
                                                ) : displayState.parakeet.status === "complete" ? (
                                                    <Trash2 size={10} />
                                                ) : (
                                                    <Download size={10} className={displayState.parakeet.status === "cancelled" ? "" : "text-cloud"} />
                                                )}
                                            </button>
                                        </div>
                                        <ModelProgress percent={displayState.parakeet.percent} status={displayState.parakeet.status} />
                                        <div className="h-4 flex items-center">
                                            {displayState.parakeet.status === "downloading" && (
                                                <p className="text-[10px] leading-none text-content-muted tabular-nums truncate w-full">
                                                    {displayState.parakeet.percent.toFixed(0)}% · {displayState.parakeet.file ?? ""}
                                                </p>
                                            )}
                                            {displayState.parakeet.status === "error" && (
                                                <p className="text-[10px] leading-none text-error truncate w-full">
                                                    {displayState.parakeet.message ?? "Download failed"}
                                                </p>
                                            )}
                                            {displayState.parakeet.status === "cancelled" && (
                                                <p className="text-[10px] leading-none text-content-muted">
                                                    Cancelled
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <p className="mt-4 text-[11px] text-content-muted">
                                More models available in Settings after setup.
                            </p>

                            <button
                                onClick={handleLocalModelContinue}
                                className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-content-primary px-5 py-2.5 text-sm font-mono font-semibold text-surface-secondary hover:bg-white transition-colors min-w-[150px] tracking-tight"
                            >
                                Continue
                            </button>
                        </motion.div>
                    )}

                    {step === "cleanup" && selectedMode === "local" && (
                        <motion.div
                            key="cleanup"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center w-full max-w-xl"
                        >

                            <h2 className="text-xl font-semibold text-content-primary mb-1">
                                AI Cleanup (optional)
                            </h2>
                            <p className="text-sm text-content-muted mb-6">
                                Let an LLM tidy transcriptions before delivery. You can adjust later in Settings.
                            </p>

                            <div className="w-full rounded-2xl border border-border-primary bg-surface-tertiary p-4 space-y-3 shadow-[0_10px_24px_rgba(0,0,0,0.25)] text-left">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-elevated border border-border-primary">
                                            <Wand2 size={14} className="text-content-primary" />
                                        </div>
                                        <div>
                                            <p className="text-[13px] font-medium text-content-primary">AI Cleanup</p>
                                            <p className="text-[11px] text-content-muted">Uses an LLM to polish text</p>
                                        </div>
                                    </div>
                                    <motion.button
                                        onClick={() => setLlmCleanupEnabled(!llmCleanupEnabled)}
                                        className={`relative w-11 h-6 rounded-full transition-colors ${llmCleanupEnabled ? "bg-amber-400" : "bg-border-secondary"}`}
                                        whileTap={{ scale: 0.95 }}
                                    >
                                        <motion.div
                                            className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm"
                                            animate={{ left: llmCleanupEnabled ? "calc(100% - 22px)" : "2px" }}
                                            transition={{ type: "spring", stiffness: 500, damping: 32 }}
                                        />
                                    </motion.button>
                                </div>

                                <div className="space-y-2">
                                    <div className="space-y-1.5">
                                        <label className="text-[11px] font-medium text-content-muted ml-1">Provider</label>
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                            {[
                                                { label: "LM Studio", key: "lmstudio" as const },
                                                { label: "Ollama", key: "ollama" as const },
                                                { label: "OpenAI", key: "openai" as const },
                                                { label: "Custom", key: "custom" as const },
                                            ].map((opt) => (
                                                <motion.button
                                                    key={opt.key}
                                                    onClick={() => setLlmProvider(opt.key)}
                                                    className={`rounded-lg border py-2 px-3 text-[11px] font-medium transition-all ${llmProvider === opt.key
                                                        ? "border-amber-400/40 bg-amber-400/10 text-amber-400"
                                                        : "border-border-secondary bg-surface-elevated text-content-secondary hover:border-border-hover hover:text-content-primary"
                                                        }`}
                                                    whileTap={{ scale: 0.97 }}
                                                >
                                                    {opt.label}
                                                </motion.button>
                                            ))}
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

                                    <div className="space-y-1.5">
                                        <label className="text-[11px] font-medium text-content-muted ml-1 flex items-center gap-1.5">
                                            <Cpu size={10} />
                                            Model <span className="text-content-disabled">(leave empty for default)</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={llmModel}
                                            onChange={(e) => setLlmModel(e.target.value)}
                                            placeholder={
                                                llmProvider === "lmstudio" ? "Uses loaded model" :
                                                    llmProvider === "ollama" ? "llama3.2" :
                                                        llmProvider === "openai" ? "gpt-4o-mini" :
                                                            "model-name"
                                            }
                                            className="w-full rounded-lg bg-surface-elevated border border-border-secondary py-2 px-3 text-[12px] text-content-primary placeholder-content-disabled focus:border-content-disabled focus:outline-none transition-colors"
                                        />
                                    </div>
                                </div>
                            </div>

                            <button
                                onClick={goToNextStep}
                                className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-content-primary px-5 py-2.5 text-sm font-mono font-semibold text-surface-secondary hover:bg-white transition-colors min-w-[150px] tracking-tight"
                            >
                                Continue
                            </button>
                        </motion.div>
                    )}

                    {step === "local-signin" && (
                        <motion.div
                            key="local-signin"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center w-full max-w-sm"
                        >
                            <h2 className="text-xl font-semibold text-content-primary mb-1">
                                Free Transcription Sync
                            </h2>
                            <p className="text-sm text-content-muted mb-6">
                                Sign in to sync your transcriptions across devices, it's free!
                            </p>

                            {authError && (
                                <motion.div
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="w-full mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400"
                                >
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
                                </motion.div>
                            )}

                            <form
                                className="w-full space-y-3"
                                onSubmit={async (e) => {
                                    e.preventDefault();
                                    setAuthError(null);
                                    setAuthLoading(true);
                                    try {
                                        // Try login first, fallback to signup if account doesn't exist
                                        try {
                                            await login(authEmail, authPassword);
                                        } catch (loginErr) {
                                            // Check if error indicates user doesn't exist - if so, create account
                                            const errorMsg = loginErr instanceof Error ? loginErr.message : "";
                                            if (errorMsg.includes("Invalid credentials") || errorMsg.includes("user") || errorMsg.includes("not found")) {
                                                // Create account with name if provided
                                                await createAccount(authEmail, authPassword, authName.trim() || undefined);
                                                // Save name to preferences for cross-device sync
                                                if (authName.trim()) {
                                                    await updatePreferences({ displayName: authName.trim() });
                                                }
                                            } else {
                                                throw loginErr;
                                            }
                                        }
                                        // Both new and existing accounts go directly to microphone
                                        // (profile step removed since name is collected here)
                                        skippedFrom.current = "local-signin";
                                        setStep("microphone");
                                    } catch (err) {
                                        setAuthError(err instanceof Error ? err.message : "Authentication failed");
                                    } finally {
                                        setAuthLoading(false);
                                    }
                                }}
                            >
                                {/* Name field - optional */}
                                <div className="relative">
                                    <input
                                        type="text"
                                        placeholder="Name (optional)"
                                        value={authName}
                                        onChange={(e) => setAuthName(e.target.value)}
                                        className="w-full rounded-lg border border-border-primary bg-surface-surface px-4 py-3 pl-11 text-sm text-white placeholder-content-disabled outline-none transition-colors focus:border-border-hover focus:bg-surface-overlay"
                                    />
                                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-content-disabled">
                                        <User size={16} />
                                    </div>
                                </div>

                                <div className="relative">
                                    <input
                                        type="email"
                                        placeholder="Email"
                                        value={authEmail}
                                        onChange={(e) => setAuthEmail(e.target.value)}
                                        required
                                        className="w-full rounded-lg border border-border-primary bg-surface-surface px-4 py-3 pl-11 text-sm text-white placeholder-content-disabled outline-none transition-colors focus:border-border-hover focus:bg-surface-overlay"
                                    />
                                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-content-disabled">
                                        <Mail size={16} />
                                    </div>
                                </div>

                                <div className="relative">
                                    <input
                                        type={authShowPassword ? "text" : "password"}
                                        placeholder="Password"
                                        value={authPassword}
                                        onChange={(e) => setAuthPassword(e.target.value)}
                                        required
                                        minLength={8}
                                        className="w-full rounded-lg border border-border-primary bg-surface-surface px-4 py-3 pl-11 pr-11 text-sm text-white placeholder-content-disabled outline-none transition-colors focus:border-border-hover focus:bg-surface-overlay"
                                    />
                                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-content-disabled">
                                        <Lock size={16} />
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setAuthShowPassword(!authShowPassword)}
                                        className="absolute right-4 top-1/2 -translate-y-1/2 text-content-disabled hover:text-content-muted transition-colors"
                                    >
                                        {authShowPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                    </button>
                                </div>

                                <button
                                    type="submit"
                                    disabled={authLoading}
                                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-local px-5 py-3 text-sm font-semibold text-surface-secondary hover:bg-local-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {authLoading ? (
                                        <>
                                            <Loader2 size={16} className="animate-spin" />
                                            Signing in...
                                        </>
                                    ) : (
                                        "Continue"
                                    )}
                                </button>
                            </form>

                            <div className="my-5 flex w-full items-center gap-3">
                                <div className="flex-1 h-px bg-border-primary" />
                                <span className="text-xs text-content-disabled">or continue with</span>
                                <div className="flex-1 h-px bg-border-primary" />
                            </div>

                            <div className="grid grid-cols-2 gap-3 w-full">
                                <button
                                    type="button"
                                    onClick={() => createOAuth2Session(OAuthProvider.Google)}
                                    className="flex items-center justify-center gap-2 rounded-lg border border-border-primary bg-surface-surface px-4 py-2.5 text-sm text-content-secondary hover:bg-surface-overlay hover:border-border-secondary transition-colors"
                                >
                                    <svg className="w-4 h-4" viewBox="0 0 24 24">
                                        <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                                        <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                                        <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                                        <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                                    </svg>
                                    Google
                                </button>

                                <button
                                    type="button"
                                    onClick={() => createOAuth2Session(OAuthProvider.Github)}
                                    className="flex items-center justify-center gap-2 rounded-lg border border-border-primary bg-surface-surface px-4 py-2.5 text-sm text-content-secondary hover:bg-surface-overlay hover:border-border-secondary transition-colors"
                                >
                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385c.6.105.825-.255.825-.57c0-.285-.015-1.23-.015-2.235c-3.015.555-3.795-.735-4.035-1.41c-.135-.345-.72-1.41-1.23-1.695c-.42-.225-1.02-.78-.015-.795c.945-.015 1.62.87 1.845 1.23c1.08 1.815 2.805 1.305 3.495.99c.105-.78.42-1.305.765-1.605c-2.67-.3-5.46-1.335-5.46-5.925c0-1.305.465-2.385 1.23-3.225c-.12-.3-.54-1.53.12-3.18c0 0 1.005-.315 3.3 1.23c.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23c.66 1.65.24 2.88.12 3.18c.765.84 1.23 1.905 1.23 3.225c0 4.605-2.805 5.625-5.475 5.925c.435.375.81 1.095.81 2.22c0 1.605-.015 2.895-.015 3.3c0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                                    </svg>
                                    GitHub
                                </button>
                            </div>


                            <button
                                type="button"
                                onClick={() => {
                                    skippedFrom.current = "local-signin";
                                    setStep("microphone");
                                }}
                                className="mt-4 text-xs text-content-disabled hover:text-content-muted transition-colors"
                            >
                                Skip for now
                            </button>

                            <button
                                type="button"
                                onClick={() => setShowFAQModal(true)}
                                className="mt-3 flex items-center gap-1.5 text-xs text-content-disabled hover:text-local transition-colors"
                            >
                                <HelpCircle size={12} />
                                How is this free?
                            </button>
                        </motion.div>
                    )}

                    {step === "microphone" && (

                        <motion.div
                            key="microphone"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center max-w-sm"
                        >
                            <div className="mb-5">
                                <Mic size={32} className="text-amber-400" />
                            </div>

                            <h2 className="text-xl font-semibold text-content-primary mb-1">
                                Microphone Access
                            </h2>

                            <div className="mb-3">
                                <StatusBadge granted={micPermission} checking={isCheckingMic} />
                            </div>

                            <p className="text-sm text-content-muted mb-6">
                                Required to capture your voice for transcription.
                            </p>

                            {!micPermission ? (
                                <button
                                    onClick={handleRequestMicrophoneAccess}
                                    disabled={isCheckingMic}
                                    className="flex items-center gap-2 rounded-lg bg-amber-400 px-5 py-2.5 text-sm font-medium text-black hover:bg-amber-300 transition-colors disabled:opacity-50"
                                >
                                    <Mic size={15} />
                                    Grant Access
                                </button>
                            ) : (
                                <button
                                    onClick={goToNextStep}
                                    className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-400 transition-colors"
                                >
                                    Continue
                                    <ChevronRight size={15} />
                                </button>
                            )}

                            <button
                                onClick={goToNextStep}
                                className="mt-3 text-xs text-content-muted hover:text-content-muted transition-colors"
                            >
                                Skip
                            </button>
                        </motion.div>
                    )}

                    {step === "accessibility" && (
                        <motion.div
                            key="accessibility"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center max-w-sm"
                        >
                            <div className="mb-5">
                                <Accessibility size={32} className="text-violet-400" />
                            </div>

                            <h2 className="text-xl font-semibold text-content-primary mb-1">
                                Accessibility
                            </h2>

                            <div className="mb-3">
                                <StatusBadge granted={accessibilityPermission} checking={isCheckingAccessibility} />
                            </div>

                            <p className="text-sm text-content-muted mb-5">
                                Enables auto-paste into any application.
                            </p>

                            {!accessibilityPermission && (
                                <p className="text-xs text-content-disabled mb-5">
                                    Click below to open System Settings, then toggle on <span className="text-content-muted">Glimpse</span>
                                </p>
                            )}

                            {!accessibilityPermission ? (
                                <button
                                    onClick={handleRequestAccessibilityAccess}
                                    className="flex items-center gap-2 rounded-lg bg-violet-500 px-5 py-2.5 text-sm font-medium text-white hover:bg-violet-400 transition-colors"
                                >
                                    <ExternalLink size={15} />
                                    Enable in Settings
                                </button>
                            ) : (
                                <button
                                    onClick={goToNextStep}
                                    className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-400 transition-colors"
                                >
                                    Continue
                                    <ChevronRight size={15} />
                                </button>
                            )}

                            {!accessibilityPermission && (
                                <button
                                    onClick={goToNextStep}
                                    className="mt-3 text-xs text-content-disabled hover:text-content-muted transition-colors"
                                >
                                    Skip
                                </button>
                            )}
                        </motion.div>
                    )}

                    {step === "ready" && (
                        <motion.div
                            key="ready"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center max-w-md"
                        >

                            <h2 className="text-xl font-semibold text-content-primary mb-1">
                                You're ready!
                            </h2>

                            <p className="text-sm text-content-muted mb-6">
                                Smart Mode is your default shortcut. Click to customize:
                            </p>

                            <motion.button
                                onClick={() => {
                                    if (!captureActive) {
                                        pressedModifiers.current.clear();
                                        primaryKey.current = null;
                                        setCaptureActive(true);
                                    }
                                }}
                                className={`w-full max-w-xs rounded-xl border p-4 text-left transition-all ${captureActive
                                    ? "border-amber-400 bg-amber-400/10"
                                    : "border-amber-400/30 bg-amber-400/5 hover:border-amber-400/50 hover:bg-amber-400/10"
                                    }`}
                                animate={captureActive ? {
                                    borderColor: ["rgba(251, 191, 36, 0.5)", "rgba(251, 191, 36, 1)", "rgba(251, 191, 36, 0.5)"]
                                } : {}}
                                transition={{ duration: 1.2, repeat: captureActive ? Infinity : 0 }}
                            >
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400/20">
                                        <Wand2 size={14} className="text-amber-400" />
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[12px] font-medium text-content-primary">Smart Mode</span>
                                            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-400">Default</span>
                                        </div>
                                        <p className="text-[10px] text-content-muted">Quick tap = hold, long press = toggle</p>
                                    </div>
                                </div>
                                <div className="flex items-center justify-between">
                                    <code className={`text-sm font-mono ${captureActive ? "text-amber-400" : "text-content-primary"}`}>
                                        {captureActive ? "Press new shortcut..." : formatShortcutForDisplay(smartShortcut)}
                                    </code>
                                    <span className="text-[10px] text-content-muted">
                                        {captureActive ? "Esc to cancel" : "Click to change"}
                                    </span>
                                </div>
                            </motion.button>

                            <p className="mt-4 text-[11px] text-content-disabled">
                                You can add more shortcuts in Settings later.
                            </p>

                            <button
                                onClick={handleComplete}
                                disabled={captureActive}
                                className="mt-6 flex items-center gap-2 rounded-lg bg-amber-400 px-6 py-2.5 text-sm font-semibold text-black hover:bg-amber-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Sparkles size={15} />
                                Get Started
                            </button>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <div className="flex justify-center pb-5">
                <div className="flex items-center gap-2 text-content-disabled">
                    <GlimpseLogo size="sm" />
                    <span className="text-[10px] font-medium">Glimpse</span>
                </div>
            </div>

            <AnimatePresence>
                {showLocalConfirm && (
                    <motion.div
                        key="local-confirm"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-6"
                        onClick={() => setShowLocalConfirm(false)}
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
                                <AlertTriangle size={20} className="text-amber-400 shrink-0" />
                                <div>
                                    <p className="text-[14px] font-semibold text-content-primary">Continue without a model?</p>
                                    <p className="text-[11px] text-content-disabled">You haven't downloaded a local model yet. Transcription will not run offline until you add one in Settings.</p>
                                </div>
                            </div>
                            <div className="flex justify-end gap-2">
                                <button
                                    onClick={() => setShowLocalConfirm(false)}
                                    className="rounded-lg border border-border-secondary px-4 py-2 text-[12px] font-medium text-content-secondary hover:border-border-hover transition-colors"
                                >
                                    Stay here
                                </button>
                                <button
                                    onClick={() => {
                                        setShowLocalConfirm(false);
                                        goToNextStep();
                                    }}
                                    className="rounded-lg bg-amber-400 px-4 py-2 text-[12px] font-semibold text-black hover:bg-amber-300 transition-colors"
                                >
                                    Continue anyway
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            <FAQModal isOpen={showFAQModal} onClose={() => setShowFAQModal(false)} />

            {currentStepIndex > 0 && (
                <button
                    onClick={goToPrevStep}
                    className="absolute left-6 bottom-6 flex items-center gap-1 text-xs text-content-muted hover:text-content-muted transition-colors"
                >
                    <ChevronLeft size={14} />
                    Back
                </button>
            )}
        </div>
    );
};

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

export default Onboarding;
