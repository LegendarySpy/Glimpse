import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
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
    ChevronRight,
    Check,
    ExternalLink,
    User,
    Loader2,
    Wand2,
} from "lucide-react";

type OnboardingStep = "welcome" | "microphone" | "accessibility" | "ready";

interface OnboardingProps {
    onComplete: () => void;
}

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
    
    // Smart mode shortcut state
    const [smartShortcut, setSmartShortcut] = useState("Control+Space");
    const [captureActive, setCaptureActive] = useState(false);
    const pressedModifiers = useRef<Set<string>>(new Set());
    const primaryKey = useRef<string | null>(null);

    const steps: OnboardingStep[] = ["welcome", "microphone", "accessibility", "ready"];
    const currentStepIndex = steps.indexOf(step);

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
                transcriptionMode: "cloud",
                localModel: "parakeet_tdt_int8",
                microphoneDevice: null,
                language: "en",
                llmCleanupEnabled: false,
                llmProvider: "none",
                llmEndpoint: "",
                llmApiKey: "",
                llmModel: "",
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

    return (
        <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0a0a0c] text-white select-none">
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
                            className="flex flex-col items-center text-center max-w-sm"
                        >
                            <div className="mb-6">
                                <GlimpseLogo size="lg" />
                            </div>

                            <h1 className="text-2xl font-semibold text-[#e8e8eb] mb-2">
                                Welcome to Glimpse
                            </h1>

                            <p className="text-sm text-[#6b6b76] mb-8">
                                Voice to text, instantly.
                            </p>

                            <button
                                className="flex items-center gap-2 rounded-lg bg-[#e8e8eb] px-5 py-2.5 text-sm font-medium text-[#0a0a0c] hover:bg-white transition-colors"
                            >
                                <User size={15} />
                                Sign In / Create Account
                            </button>

                            <button
                                onClick={goToNextStep}
                                className="mt-4 text-xs text-[#5a5a64] hover:text-[#8b8b96] transition-colors"
                            >
                                I'll do this later
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
        </div>
    );
};

export default Onboarding;
