import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
    checkAccessibilityPermission,
    requestAccessibilityPermission,
    checkMicrophonePermission,
    requestMicrophonePermission,
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
    Wand2,
    AlertTriangle,
} from "lucide-react";
import DotMatrix from "./components/DotMatrix";

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

type OnboardingStep = "welcome" | "cloud-signin" | "local-model" | "cleanup" | "microphone" | "accessibility" | "ready";

type LocalDownloadStatus = {
    status: "idle" | "downloading" | "complete" | "error";
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

// Clean animated logo - 4 dots in 2x2 grid with smooth transitions
const GlimpseLogo = ({ size = "md" }: { size?: "sm" | "md" | "lg" }) => {
    const [pattern, setPattern] = useState(0);
    const intervalRef = useRef<number | null>(null);

    const sizes = {
        sm: { dot: 5, gap: 4 },
        md: { dot: 10, gap: 7 },
        lg: { dot: 14, gap: 10 },
    }[size];

    // Pattern: 0=diagonal TL/BR, 1=diagonal TR/BL, 2=all, 3=none (breathe)
    const patterns = [
        [true, false, false, true],   // diagonal \
        [false, true, true, false],   // diagonal /
        [true, true, true, true],     // all on
        [true, false, false, true],   // diagonal \
    ];

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
                        className="absolute rounded-full bg-amber-400"
                        style={{
                            width: sizes.dot,
                            height: sizes.dot,
                            left: col * (sizes.dot + sizes.gap),
                            top: row * (sizes.dot + sizes.gap),
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

// Progress indicator
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

// Permission status indicator
const StatusBadge = ({ granted, checking }: { granted: boolean; checking?: boolean }) => {
    if (checking) {
        return (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-[#6b6b76]">
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
        <span className="text-[11px] text-[#5a5a64]">
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
    const [micPermission, setMicPermission] = useState(false);
    const [accessibilityPermission, setAccessibilityPermission] = useState(false);
    const [isCheckingMic, setIsCheckingMic] = useState(true);
    const [isCheckingAccessibility, setIsCheckingAccessibility] = useState(true);
    const [selectedMode, setSelectedMode] = useState<TranscriptionMode>("cloud");
    const [localModelChoice, setLocalModelChoice] = useState<typeof PARAKEET_KEY | typeof WHISPER_KEY>(PARAKEET_KEY);
    const [localDownload, setLocalDownload] = useState<Record<string, LocalDownloadStatus>>({
        [PARAKEET_KEY]: { status: "idle", percent: 0 },
        [WHISPER_KEY]: { status: "idle", percent: 0 },
    });
    const [modelStatus, setModelStatus] = useState<Record<string, ModelStatus>>({});
    const [llmCleanupEnabled, setLlmCleanupEnabled] = useState(false);
    const [llmProvider, setLlmProvider] = useState<"lmstudio" | "ollama" | "openai" | "custom" | "none">("none");
    const [llmEndpoint, setLlmEndpoint] = useState("");
    const [llmApiKey, setLlmApiKey] = useState("");
    const [llmModel, setLlmModel] = useState("");
    const [showLocalConfirm, setShowLocalConfirm] = useState(false);
    
    // Smart mode shortcut state
    const [smartShortcut, setSmartShortcut] = useState("Control+Space");
    const [captureActive, setCaptureActive] = useState(false);
    const pressedModifiers = useRef<Set<string>>(new Set());
    const primaryKey = useRef<string | null>(null);

    const steps: OnboardingStep[] = selectedMode === "cloud"
        ? ["welcome", "cloud-signin", "microphone", "accessibility", "ready"]
        : ["welcome", "local-model", "cleanup", "microphone", "accessibility", "ready"];
    const currentStepIndex = steps.indexOf(step);

    // Auto-close confirm modal if the step changes (e.g., Back navigation)
    useEffect(() => {
        if (showLocalConfirm) setShowLocalConfirm(false);
    }, [step]);

    const checkMicPermission = useCallback(async () => {
        try {
            const granted = await checkMicrophonePermission();
            console.log("Microphone permission:", granted);
            setMicPermission(granted);
        } catch (err) {
            console.error("Failed to check microphone permission:", err);
        } finally {
            setIsCheckingMic(false);
        }
    }, []);

    const checkAccessPermission = useCallback(async () => {
        try {
            const granted = await checkAccessibilityPermission();
            console.log("Accessibility permission:", granted);
            setAccessibilityPermission(granted);
        } catch (err) {
            console.error("Failed to check accessibility permission:", err);
        } finally {
            setIsCheckingAccessibility(false);
        }
    }, []);

    // Initial checks
    useEffect(() => {
        checkMicPermission();
        checkAccessPermission();
    }, [checkMicPermission, checkAccessPermission]);

    // Poll when on relevant steps
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
            // Use the macOS permissions plugin to request microphone access
            // This properly triggers the system permission dialog
            await requestMicrophonePermission();
            await checkMicPermission();
        } catch (err) {
            console.error("Failed to request microphone:", err);
            // Fallback: try opening system settings
            try {
                await invoke("open_microphone_settings");
            } catch (e) {
                console.error("Failed to open settings:", e);
            }
        }
    };

    const handleRequestAccessibilityAccess = async () => {
        try {
            // Use the macOS permissions plugin to request accessibility access
            // This shows a system dialog prompting user to enable in System Settings
            await requestAccessibilityPermission();
            await checkAccessPermission();
        } catch (err) {
            console.error("Failed to request accessibility:", err);
            // Fallback: try opening system settings
            try {
                await invoke("open_accessibility_settings");
            } catch (e) {
                console.error("Failed to open settings:", e);
            }
        }
    };

    const handleComplete = async () => {
        try {
            // Save the smart shortcut setting before completing onboarding
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
            });
            await invoke("complete_onboarding");
            onComplete();
        } catch {
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

    // Handle keyboard capture for shortcut editing
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
                models.forEach((model) => refreshModelStatus(model.key));
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

    // Listen for model download events to mirror Settings behavior
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
        <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0a0a0c] text-white select-none relative">
            {/* Title bar */}
            <div data-tauri-drag-region className="h-7 w-full shrink-0" />

            {/* Progress */}
            <div className="flex justify-center pt-6 pb-6">
                <StepIndicator currentStep={currentStepIndex} total={steps.length} />
            </div>

            {/* Content */}
            <div className="flex-1 flex items-center justify-center px-10 pb-10">
                <AnimatePresence mode="wait">
                    {/* Welcome */}
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

                            <h1 className="text-2xl font-semibold text-[#e8e8eb] mb-2">
                                Welcome to Glimpse
                            </h1>

                            <p className="text-sm text-[#6b6b76] mb-8">
                                Build at the speed of speech.
                            </p>

                            <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                                <button
                                    type="button"
                                    onClick={() => setSelectedMode("cloud")}
                                    className={`group relative w-full rounded-2xl border border-[#1f1f28] bg-[#0d0d10] p-4 text-left space-y-3 shadow-[0_10px_24px_rgba(0,0,0,0.28)] overflow-hidden transition-all ${
                                        selectedMode === "cloud" ? "ring-1 ring-amber-400/50" : ""
                                    }`}
                                    aria-pressed={selectedMode === "cloud"}
                                >
                                    <div className="absolute inset-0 pointer-events-none">
                                        <div className="absolute inset-0 opacity-18">
                                            <DotMatrix rows={6} cols={18} activeDots={[1,4,7,10,12,15,18,20,23,26,29,32,35,38,41,44,47,50,53,56,59,62,65,68]} dotSize={2} gap={4} color="#2e2e37" />
                                        </div>
                                    </div>
                                    <div className="relative flex items-center gap-2">
                                        <DotMatrix rows={2} cols={2} activeDots={[0, 3]} dotSize={3} gap={2} color="#fbbf24" />
                                        <span className="text-[10px] font-semibold text-amber-400">Glimpse Cloud</span>
                                    </div>
                                    <div className="relative flex flex-col gap-1.5 text-[11px] text-[#f0f0f5] font-medium">
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
                                    <div className="relative flex items-center gap-3 rounded-xl border border-[#1a1a22] bg-[#0d0d12]/90 px-3 py-2 text-[10px] text-[#d0d0da] leading-relaxed">
                                        <DotMatrix rows={3} cols={5} activeDots={[0, 2, 4, 6, 8, 10, 12, 14]} dotSize={2} gap={2} color="#2a2a34" />
                                        <p className="flex-1">Cloud is optional ($5.99/mo) if you want these perks. Cloud provides better models and faster cleanup & delivery.</p>
                                    </div>
                                </button>

                                <button
                                    type="button"
                                    onClick={() => setSelectedMode("local")}
                                    className={`group relative w-full rounded-2xl border p-4 text-left space-y-3 shadow-[0_10px_24px_rgba(0,0,0,0.18)] overflow-hidden transition-colors ${
                                        selectedMode === "local"
                                            ? "border-[#3a3a45] bg-[#0c0c10]"
                                            : "border-[#15151c] bg-[#0b0b0f]"
                                    }`}
                                    aria-pressed={selectedMode === "local"}
                                >
                                    <div className="absolute inset-0 pointer-events-none">
                                        <div className="absolute inset-0 opacity-14">
                                            <DotMatrix rows={6} cols={18} activeDots={[0,3,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59,62,65,68]} dotSize={2} gap={4} color="#1f1f28" />
                                        </div>
                                    </div>
                                    <div className="relative flex items-center gap-2">
                                        <DotMatrix rows={2} cols={2} activeDots={[1]} dotSize={3} gap={2} color="#9ca3af" />
                                        <span className="text-[10px] font-semibold text-[#d1d5db]">Glimpse Local</span>
                                    </div>
                                    <div className="relative flex flex-col gap-1.5 text-[11px] text-[#dcdce3] font-medium">
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-[#6b7280]" />
                                            <span>Everything stays on-device for privacy</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-[#6b7280]" />
                                            <span>Runs with local models—no uploads</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-[#6b7280]" />
                                            <span>Offline-friendly when you're traveling</span>
                                        </div>
                                    </div>
                                    <div className="relative flex items-center gap-3 rounded-xl border border-[#16161f] bg-[#0c0c12]/90 px-3 py-2 text-[10px] text-[#a1a1ad] leading-relaxed">
                                        <DotMatrix rows={3} cols={5} activeDots={[1, 4, 6, 9, 12, 15, 18, 21]} dotSize={2} gap={2} color="#1d1d26" />
                                        <p className="flex-1">Best for privacy-first or offline sessions. Cloud remains optional if you want sync and faster responses.</p>
                                    </div>
                                </button>
                            </div>

                            <button
                                onClick={goToNextStep}
                                className="flex items-center justify-center gap-2 rounded-lg bg-[#e8e8eb] px-5 py-2.5 text-sm font-mono font-semibold text-[#0a0a0c] hover:bg-white transition-colors min-w-[150px] tracking-tight"
                            >
                                {selectedMode === "cloud" ? "> Cloud" : "> Local"}
                            </button>
                        </motion.div>
                    )}

                    {/* Cloud Sign-In (WIP) */}
                    {step === "cloud-signin" && (
                        <motion.div
                            key="cloud-signin"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center max-w-sm"
                        >

                            <h2 className="text-xl font-semibold text-[#e8e8eb] mb-1">
                                Cloud Sign-In
                            </h2>
                            <p className="text-sm text-[#6b6b76] mb-6">
                                Account sync is work-in-progress. We’ll add sign-in soon.
                            </p>

                            <div className="w-full rounded-xl border border-[#1e1e22] bg-[#111113] p-6 text-left">
                                <p className="text-[11px] font-mono text-[#d0d0da] mb-3">
                                    Coming soon: Sync history across devices, use bigger & better models, support this project!
                                </p>
                                <div className="rounded-lg border border-[#2a2a30] bg-[#16161a] px-3 py-2 text-[10px] text-[#8b8b96] leading-relaxed">
                                    Cloud mode is 100% optional. Local mode will always be free and available.
                                </div>
                            </div>

                            <button
                                onClick={goToNextStep}
                                className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-[#e8e8eb] px-5 py-2.5 text-sm font-mono font-semibold text-[#0a0a0c] hover:bg-white transition-colors min-w-[150px] tracking-tight"
                            >
                                Continue
                            </button>
                        </motion.div>
                    )}

                    {/* Local model selection */}
                    {step === "local-model" && (
                        <motion.div
                            key="local-model"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center w-full max-w-2xl"
                        >

                            <h2 className="text-xl font-semibold text-[#e8e8eb] mb-1">
                                Choose your local model
                            </h2>
                            <div className="mb-6 flex flex-col gap-1 text-sm text-[#6b6b76]">
                                <p>Pick a model, then download it. You can add more in Settings later.</p>
                                <p className="text-xs text-[#4a4a54]">Both models work offline; choose one and get it ready.</p>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
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
                                    className={`relative w-full rounded-2xl border border-[#1b1b22] p-4 text-left space-y-3 shadow-[0_10px_24px_rgba(0,0,0,0.2)] overflow-hidden transition-colors cursor-pointer ${
                                        isParakeetActive
                                            ? "bg-amber-400/5 ring-1 ring-amber-400/60"
                                            : localModelChoice === PARAKEET_KEY
                                                ? "bg-[#0f0f14] ring-1 ring-amber-400/30"
                                                : "bg-[#0c0c12] hover:border-[#2a2a32]"
                                    }`}
                                >
                                    <div className="absolute inset-0 pointer-events-none">
                                        <div className="absolute inset-0 opacity-12">
                                            <DotMatrix rows={6} cols={18} activeDots={[0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57,60,63,66]} dotSize={2} gap={4} color="#1f1f28" />
                                        </div>
                                    </div>
                                    <div className="relative flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <DotMatrix rows={2} cols={2} activeDots={[0]} dotSize={3} gap={2} color="#fbbf24" />
                                            <span className="text-[11px] font-semibold text-[#e5e7eb]">Parakeet (INT8)</span>
                                        </div>
                                        <span
                                            className={`px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border ${
                                                isParakeetActive
                                                    ? "bg-amber-400/20 text-amber-400 border-amber-400/40"
                                                    : "opacity-0 border-transparent text-transparent pointer-events-none select-none"
                                            }`}
                                        >
                                            Active
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 text-[10px] text-[#8b8b96]">
                                        <span className="font-mono">Fast, small</span>
                                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border ${
                                            parakeetInstalled
                                                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                                : "bg-[#16161d] text-[#9ca3af] border-[#2a2a30]"
                                        }`}>
                                            {parakeetInstalled ? "Ready" : "Download needed"}
                                        </span>
                                    </div>
                                    <div className="relative space-y-1.5 text-[11px] text-[#d0d0da] font-medium">
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-[#6b7280]" />
                                            <span>Good accuracy, fast</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-[#6b7280]" />
                                            <span>Multilingual</span>
                                        </div>
                                    </div>
                                    <div className="relative rounded-lg border border-[#20202a] bg-[#121218] px-3 py-2 text-[10px] text-[#9ca3af] leading-relaxed space-y-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-semibold text-[#d0d0da]">Download</span>
                                            <button
                                                aria-label={displayState.parakeet.status === "complete" ? "Delete model" : "Download model"}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (displayState.parakeet.status === "complete") {
                                                        handleLocalDelete(PARAKEET_KEY);
                                                    } else {
                                                        handleLocalDownload(PARAKEET_KEY);
                                                    }
                                                }}
                                                disabled={displayState.parakeet.status === "downloading"}
                                                className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                                                    displayState.parakeet.status === "downloading"
                                                        ? "border-[#2a2a30] text-[#6b6b76] cursor-wait"
                                                        : displayState.parakeet.status === "complete"
                                                            ? "border-red-500/30 text-red-400 hover:bg-red-500/10"
                                                            : "border-[#2a2a30] text-[#e8e8eb] hover:border-[#3a3a42]"
                                                }`}
                                            >
                                                {displayState.parakeet.status === "downloading" ? (
                                                    <Loader2 size={10} className="animate-spin" />
                                                ) : displayState.parakeet.status === "complete" ? (
                                                    <Trash2 size={10} />
                                                ) : (
                                                    <Download size={10} className="text-amber-400" />
                                                )}
                                            </button>
                                        </div>
                                        <ModelProgress percent={displayState.parakeet.percent} status={displayState.parakeet.status} />
                                        <div className="h-[14px]">
                                            {displayState.parakeet.status === "downloading" && (
                                                <p className="text-[10px] text-[#6b6b76] tabular-nums">
                                                    {displayState.parakeet.percent.toFixed(0)}% · {displayState.parakeet.file ?? ""}
                                                </p>
                                            )}
                                            {displayState.parakeet.status === "error" && (
                                                <p className="text-[10px] text-red-400">
                                                    {displayState.parakeet.message ?? "Download failed"}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>

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
                                    className={`relative w-full rounded-2xl border p-4 text-left space-y-3 shadow-[0_10px_24px_rgba(0,0,0,0.16)] overflow-hidden transition-colors cursor-pointer ${
                                        isWhisperActive
                                            ? "border-[#181820] bg-amber-400/5 ring-1 ring-amber-400/60"
                                            : localModelChoice === WHISPER_KEY
                                                ? "border-[#181820] bg-[#0e0e13] ring-1 ring-amber-400/30"
                                                : "border-[#181820] bg-[#0b0b0f] hover:border-[#262631]"
                                    }`}
                                >
                                    <div className="absolute inset-0 pointer-events-none">
                                        <div className="absolute inset-0 opacity-10">
                                            <DotMatrix rows={6} cols={18} activeDots={[1,5,9,13,17,21,25,29,33,37,41,45,49,53,57,61,65]} dotSize={2} gap={4} color="#1c1c25" />
                                        </div>
                                    </div>
                                    <div className="relative flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <DotMatrix rows={2} cols={2} activeDots={[1]} dotSize={3} gap={2} color="#a5b4fc" />
                                            <span className="text-[11px] font-semibold text-[#e5e7eb]">Whisper Large V3 Turbo (Q8)</span>
                                        </div>
                                        <span
                                            className={`px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border ${
                                                isWhisperActive
                                                    ? "bg-amber-400/20 text-amber-400 border-amber-400/40"
                                                    : "opacity-0 border-transparent text-transparent pointer-events-none select-none"
                                            }`}
                                        >
                                            Active
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 text-[10px] text-[#8b8b96]">
                                        <span className="font-mono">Multilingual, balanced</span>
                                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border ${
                                            whisperInstalled
                                                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                                : "bg-[#16161d] text-[#9ca3af] border-[#2a2a30]"
                                        }`}>
                                            {whisperInstalled ? "Ready" : "Download needed"}
                                        </span>
                                    </div>
                                    <div className="relative space-y-1.5 text-[11px] text-[#d0d0da] font-medium">
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-[#6b7280]" />
                                                <span>Good quality, balanced speed</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="h-1 w-3 rounded-full bg-[#6b7280]" />
                                            <span>Supports custom words</span>
                                        </div>
                                    </div>
                                    <div className="relative rounded-lg border border-[#20202a] bg-[#0f0f15] px-3 py-2 text-[10px] text-[#9ca3af] leading-relaxed space-y-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-semibold text-[#d0d0da]">Download</span>
                                            <button
                                                aria-label={displayState.whisper.status === "complete" ? "Delete model" : "Download model"}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (displayState.whisper.status === "complete") {
                                                        handleLocalDelete(WHISPER_KEY);
                                                    } else {
                                                        handleLocalDownload(WHISPER_KEY);
                                                    }
                                                }}
                                                disabled={displayState.whisper.status === "downloading"}
                                                className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                                                    displayState.whisper.status === "downloading"
                                                        ? "border-[#2a2a30] text-[#6b6b76] cursor-wait"
                                                        : displayState.whisper.status === "complete"
                                                            ? "border-red-500/30 text-red-400 hover:bg-red-500/10"
                                                            : "border-[#2a2a30] text-[#e8e8eb] hover:border-[#3a3a42]"
                                                }`}
                                            >
                                                {displayState.whisper.status === "downloading" ? (
                                                    <Loader2 size={10} className="animate-spin" />
                                                ) : displayState.whisper.status === "complete" ? (
                                                    <Trash2 size={10} />
                                                ) : (
                                                    <Download size={10} className="text-amber-400" />
                                                )}
                                            </button>
                                        </div>
                                        <ModelProgress percent={displayState.whisper.percent} status={displayState.whisper.status} />
                                        <div className="h-[14px]">
                                            {displayState.whisper.status === "downloading" && (
                                                <p className="text-[10px] text-[#6b6b76] tabular-nums">
                                                    {displayState.whisper.percent.toFixed(0)}% · {displayState.whisper.file ?? ""}
                                                </p>
                                            )}
                                            {displayState.whisper.status === "error" && (
                                                <p className="text-[10px] text-red-400">
                                                    {displayState.whisper.message ?? "Download failed"}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <p className="mt-4 text-[11px] text-[#5a5a64]">
                                More models available in Settings after setup.
                            </p>

                            <button
                                onClick={handleLocalModelContinue}
                                className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-[#e8e8eb] px-5 py-2.5 text-sm font-mono font-semibold text-[#0a0a0c] hover:bg-white transition-colors min-w-[150px] tracking-tight"
                            >
                                Continue
                            </button>
                        </motion.div>
                    )}

                    {/* AI Cleanup */}
                    {step === "cleanup" && selectedMode === "local" && (
                        <motion.div
                            key="cleanup"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center w-full max-w-xl"
                        >

                            <h2 className="text-xl font-semibold text-[#e8e8eb] mb-1">
                                AI Cleanup (optional)
                            </h2>
                            <p className="text-sm text-[#6b6b76] mb-6">
                                Let an LLM tidy transcriptions before delivery. You can adjust later in Settings.
                            </p>

                            <div className="w-full rounded-2xl border border-[#1f1f28] bg-[#0f0f13] p-4 space-y-3 shadow-[0_10px_24px_rgba(0,0,0,0.25)] text-left">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#16161b] border border-[#25252f]">
                                            <Wand2 size={14} className="text-[#e8e8eb]" />
                                        </div>
                                        <div>
                                            <p className="text-[13px] font-medium text-[#e8e8eb]">AI Cleanup</p>
                                            <p className="text-[11px] text-[#6b6b76]">Uses an LLM to polish text</p>
                                        </div>
                                    </div>
                                    <motion.button
                                        onClick={() => setLlmCleanupEnabled(!llmCleanupEnabled)}
                                        className={`relative w-11 h-6 rounded-full transition-colors ${llmCleanupEnabled ? "bg-amber-400" : "bg-[#2a2a30]"}`}
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
                                        <label className="text-[11px] font-medium text-[#6b6b76] ml-1">Provider</label>
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
                                                    className={`rounded-lg border py-2 px-3 text-[11px] font-medium transition-all ${
                                                        llmProvider === opt.key
                                                            ? "border-amber-400/40 bg-amber-400/10 text-amber-400"
                                                            : "border-[#2a2a30] bg-[#1a1a1e] text-[#a0a0ab] hover:border-[#3a3a42] hover:text-[#e8e8eb]"
                                                    }`}
                                                    whileTap={{ scale: 0.97 }}
                                                >
                                                    {opt.label}
                                                </motion.button>
                                            ))}
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

                                    <div className="space-y-1.5">
                                        <label className="text-[11px] font-medium text-[#6b6b76] ml-1 flex items-center gap-1.5">
                                            <Cpu size={10} />
                                            Model <span className="text-[#4a4a54]">(leave empty for default)</span>
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
                                            className="w-full rounded-lg bg-[#1a1a1e] border border-[#2a2a30] py-2 px-3 text-[12px] text-[#e8e8eb] placeholder-[#4a4a54] focus:border-[#4a4a54] focus:outline-none transition-colors"
                                        />
                                    </div>
                                </div>
                            </div>

                            <button
                                onClick={goToNextStep}
                                className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-[#e8e8eb] px-5 py-2.5 text-sm font-mono font-semibold text-[#0a0a0c] hover:bg-white transition-colors min-w-[150px] tracking-tight"
                            >
                                Continue
                            </button>
                        </motion.div>
                    )}

                    {/* Microphone */}
                    {step === "microphone" && (
                        <motion.div
                            key="microphone"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center max-w-sm"
                        >
                            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-amber-400/10 border border-amber-400/20">
                                <Mic size={24} className="text-amber-400" />
                            </div>

                            <h2 className="text-xl font-semibold text-[#e8e8eb] mb-1">
                                Microphone Access
                            </h2>

                            <div className="mb-3">
                                <StatusBadge granted={micPermission} checking={isCheckingMic} />
                            </div>

                            <p className="text-sm text-[#6b6b76] mb-6">
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
                                className="mt-3 text-xs text-[#5a5a64] hover:text-[#8b8b96] transition-colors"
                            >
                                Skip
                            </button>
                        </motion.div>
                    )}

                    {/* Accessibility */}
                    {step === "accessibility" && (
                        <motion.div
                            key="accessibility"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center max-w-sm"
                        >
                            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-violet-400/10 border border-violet-400/20">
                                <Accessibility size={24} className="text-violet-400" />
                            </div>

                            <h2 className="text-xl font-semibold text-[#e8e8eb] mb-1">
                                Accessibility
                            </h2>

                            <div className="mb-3">
                                <StatusBadge granted={accessibilityPermission} checking={isCheckingAccessibility} />
                            </div>

                            <p className="text-sm text-[#6b6b76] mb-5">
                                Enables auto-paste into any application.
                            </p>

                            {!accessibilityPermission && (
                                <p className="text-xs text-[#4a4a54] mb-5">
                                    Click below to open System Settings, then toggle on <span className="text-[#8b8b96]">Glimpse</span>
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
                                    className="mt-3 text-xs text-[#4a4a54] hover:text-[#6b6b76] transition-colors"
                                >
                                    Skip
                                </button>
                            )}
                        </motion.div>
                    )}

                    {/* Ready */}
                    {step === "ready" && (
                        <motion.div
                            key="ready"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -16 }}
                            transition={{ duration: 0.3 }}
                            className="flex flex-col items-center text-center max-w-md"
                        >
                            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-emerald-400/10 border border-emerald-400/20">
                                <Sparkles size={24} className="text-emerald-400" />
                            </div>

                            <h2 className="text-xl font-semibold text-[#e8e8eb] mb-1">
                                You're ready!
                            </h2>

                            <p className="text-sm text-[#6b6b76] mb-6">
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
                                className={`w-full max-w-xs rounded-xl border p-4 text-left transition-all ${
                                    captureActive 
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
                                            <span className="text-[12px] font-medium text-[#e8e8eb]">Smart Mode</span>
                                            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-400">Default</span>
                                        </div>
                                        <p className="text-[10px] text-[#6b6b76]">Quick tap = hold, long press = toggle</p>
                                    </div>
                                </div>
                                <div className="flex items-center justify-between">
                                    <code className={`text-sm font-mono ${captureActive ? "text-amber-400" : "text-[#e8e8eb]"}`}>
                                        {captureActive ? "Press new shortcut..." : formatShortcutForDisplay(smartShortcut)}
                                    </code>
                                    <span className="text-[10px] text-[#6b6b76]">
                                        {captureActive ? "Esc to cancel" : "Click to change"}
                                    </span>
                                </div>
                            </motion.button>

                            <p className="mt-4 text-[11px] text-[#4a4a54]">
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

            {/* Footer */}
            <div className="flex justify-center pb-5">
                <div className="flex items-center gap-2 text-[#3a3a42]">
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
                            className="w-full max-w-sm rounded-2xl border border-[#1f1f28] bg-[#0d0d12] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="flex items-center gap-3 mb-3">
                                <AlertTriangle size={20} className="text-amber-400 shrink-0" />
                                <div>
                                    <p className="text-[14px] font-semibold text-[#e8e8eb]">Continue without a model?</p>
                                    <p className="text-[11px] text-[#7a7a84]">You haven't downloaded a local model yet. Transcription will not run offline until you add one in Settings.</p>
                                </div>
                            </div>
                            <div className="flex justify-end gap-2">
                                <button
                                    onClick={() => setShowLocalConfirm(false)}
                                    className="rounded-lg border border-[#2a2a30] px-4 py-2 text-[12px] font-medium text-[#d0d0da] hover:border-[#3a3a42] transition-colors"
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

            {currentStepIndex > 0 && (
                <button
                    onClick={goToPrevStep}
                    className="absolute left-6 bottom-6 flex items-center gap-1 text-xs text-[#5a5a64] hover:text-[#8b8b96] transition-colors"
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

export default Onboarding;
