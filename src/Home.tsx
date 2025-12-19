import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, ChevronLeft, Home as HomeIcon, Book, Brain, User, Info, HelpCircle, Github, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import SettingsModal from "./components/SettingsModal";
import FAQModal from "./components/FAQModal";
import DotMatrix from "./components/DotMatrix";
import TranscriptionList from "./components/TranscriptionList";
import DictionaryView from "./components/DictionaryView";
import { getCurrentUser, type User as AppwriteUser } from "./lib/auth";

type TranscriptionMode = "cloud" | "local";

type StoredSettings = {
    transcription_mode: TranscriptionMode;
};

const SidebarItem = ({
    icon,
    label,
    active = false,
    collapsed,
    onClick
}: {
    icon: React.ReactNode;
    label: string;
    active?: boolean;
    collapsed: boolean;
    onClick?: () => void;
}) => (
    <button
        onClick={onClick}
        className={`group flex w-full items-center rounded-lg h-9 pl-[17px] pr-3 ${collapsed ? "gap-0" : "gap-3"
            } ${active
                ? "bg-[#1a1a1e] text-[#e8e8eb]"
                : "text-[#6b6b76] hover:bg-[#151517] hover:text-[#a0a0ab]"
            }`}
    >
        <div className={`flex items-center justify-center w-[18px] shrink-0 ${active ? "text-[#e8e8eb]" : "group-hover:text-[#a0a0ab]"}`}>
            {icon}
        </div>
        <span
            style={{ width: collapsed ? 0 : 'auto', opacity: collapsed ? 0 : 1 }}
            className="text-[13px] font-medium whitespace-nowrap overflow-hidden transition-[width,opacity] duration-200 ease-out"
        >
            {label}
        </span>
    </button>
);

const Home = () => {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [settingsTab, setSettingsTab] = useState<"general" | "account" | "models" | "about">("general");
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
    const [activeView, setActiveView] = useState<"home" | "dictionary" | "brain">("home");
    const [transcriptionMode, setTranscriptionMode] = useState<TranscriptionMode>("cloud");
    const [currentUser, setCurrentUser] = useState<AppwriteUser | null>(null);
    const [showSupportPopup, setShowSupportPopup] = useState(false);
    const [showFAQ, setShowFAQ] = useState(false);
    const [appVersion, setAppVersion] = useState("-");
    const popupRef = useRef<HTMLDivElement>(null);

    const [llmCleanupEnabled, setLlmCleanupEnabled] = useState(false);

    const sidebarWidth = isSidebarCollapsed ? 68 : 200;

    const loadUser = useCallback(async () => {
        try {
            const user = await getCurrentUser();
            setCurrentUser(user);
        } catch (err) {
            console.error("Failed to load user:", err);
            setCurrentUser(null);
        }
    }, []);

    useEffect(() => {
        let unlistenSettings: UnlistenFn | null = null;
        let unlistenNavigate: UnlistenFn | null = null;

        const loadSettings = async () => {
            try {
                const settings = await invoke<StoredSettings & { llm_cleanup_enabled: boolean }>("get_settings");
                setTranscriptionMode(settings.transcription_mode);
                setLlmCleanupEnabled(settings.llm_cleanup_enabled);
            } catch (err) {
                console.error("Failed to load settings:", err);
            }
        };

        loadSettings();
        loadUser();

        invoke<{ version: string }>("get_app_info")
            .then((info) => setAppVersion(info.version))
            .catch((err) => console.error("Failed to load app version:", err));

        listen<StoredSettings & { llm_cleanup_enabled: boolean }>("settings:changed", (event) => {
            setTranscriptionMode(event.payload.transcription_mode);
            setLlmCleanupEnabled(event.payload.llm_cleanup_enabled);
        }).then((fn) => {
            unlistenSettings = fn;
        });

        listen("navigate:about", async () => {
            setSettingsTab("about");
            setIsSettingsOpen(true);
            setTimeout(async () => {
                const { emit } = await import("@tauri-apps/api/event");
                emit("updater:check");
            }, 100);
        }).then((fn) => {
            unlistenNavigate = fn;
        });

        return () => {
            unlistenSettings?.();
            unlistenNavigate?.();
        };
    }, [loadUser]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
                setShowSupportPopup(false);
            }
        };

        if (showSupportPopup) {
            document.addEventListener("mousedown", handleClickOutside);
            return () => document.removeEventListener("mousedown", handleClickOutside);
        }
    }, [showSupportPopup]);

    const isCloudMode = transcriptionMode === "cloud";
    const logoColor = isCloudMode ? "var(--color-cloud)" : "var(--color-local)";
    const logoActiveDots = isCloudMode ? [0, 3] : [1, 2];

    const showLlmButtons = isCloudMode || llmCleanupEnabled;

    const getGreeting = () => {
        const hour = new Date().getHours();
        if (hour < 12) return "Good morning";
        if (hour < 17) return "Good afternoon";
        return "Good evening";
    };

    return (
        <div className="flex h-screen w-screen overflow-hidden bg-[#0e0e10] font-sans text-white select-none">
            <div
                data-tauri-drag-region
                className="fixed top-0 left-0 right-0 h-8 z-50"
            />

            <motion.aside
                initial={false}
                animate={{ width: sidebarWidth }}
                transition={{
                    type: "tween",
                    duration: 0.2,
                    ease: [0.25, 0.1, 0.25, 1]
                }}
                className="relative flex flex-col border-r border-[#1a1a1e] bg-[#0a0a0c] shrink-0"
            >
                <div data-tauri-drag-region className="h-8 w-full shrink-0" />

                <div className="pl-6 pb-6 pt-1">
                    <div className="flex items-center gap-3 h-6">
                        <div className="shrink-0">
                            <DotMatrix
                                rows={2}
                                cols={2}
                                activeDots={logoActiveDots}
                                dotSize={4}
                                gap={3}
                                color={logoColor}
                            />
                        </div>
                        <span
                            style={{ width: isSidebarCollapsed ? 0 : 'auto', opacity: isSidebarCollapsed ? 0 : 1 }}
                            className="text-[14px] font-bold tracking-wide text-[#e8e8eb] whitespace-nowrap overflow-hidden transition-[width,opacity] duration-200 ease-out"
                        >
                            Glimpse
                        </span>
                    </div>
                </div>

                <nav className="flex-1 px-2 space-y-1">
                    <SidebarItem
                        icon={<HomeIcon size={18} />}
                        label="Home"
                        active={activeView === "home"}
                        collapsed={isSidebarCollapsed}
                        onClick={() => setActiveView("home")}
                    />
                    <SidebarItem
                        icon={<Book size={18} />}
                        label="Dictionary"
                        active={activeView === "dictionary"}
                        collapsed={isSidebarCollapsed}
                        onClick={() => setActiveView("dictionary")}
                    />
                    <SidebarItem
                        icon={<Brain size={18} />}
                        label="Personalization"
                        active={activeView === "brain"}
                        collapsed={isSidebarCollapsed}
                        onClick={() => setActiveView("brain")}
                    />
                </nav>

                <div className="p-2 space-y-1 border-t border-[#1a1a1e]/50">
                    <button
                        onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                        className="flex w-full items-center rounded-lg h-9 pl-[17px] text-[#4a4a54] hover:text-[#6b6b76]"
                    >
                        <div className="flex items-center justify-center w-[18px]">
                            <motion.div
                                animate={{ rotate: isSidebarCollapsed ? 180 : 0 }}
                                transition={{ type: "tween", duration: 0.2 }}
                            >
                                <ChevronLeft size={16} />
                            </motion.div>
                        </div>
                    </button>

                    <div className="relative">
                        <button
                            onClick={() => setShowSupportPopup(!showSupportPopup)}
                            className={`group flex w-full items-center rounded-lg h-9 pl-[17px] pr-3 text-[#6b6b76] hover:bg-[#151517] hover:text-[#a0a0ab] ${isSidebarCollapsed ? "gap-0" : "gap-3"
                                }`}
                        >
                            <div className="flex items-center justify-center w-[18px] shrink-0 group-hover:text-[#a0a0ab]">
                                <Info size={18} />
                            </div>
                            <span
                                style={{ width: isSidebarCollapsed ? 0 : 'auto', opacity: isSidebarCollapsed ? 0 : 1 }}
                                className="text-[13px] font-medium whitespace-nowrap overflow-hidden transition-[width,opacity] duration-200 ease-out"
                            >
                                Support
                            </span>
                        </button>

                        <AnimatePresence>
                            {showSupportPopup && (
                                <motion.div
                                    ref={popupRef}
                                    initial={{ opacity: 0, y: 8, scale: 0.95 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    exit={{ opacity: 0, y: 8, scale: 0.95 }}
                                    transition={{ duration: 0.15, ease: "easeOut" }}
                                    className="absolute bottom-full left-2 mb-2 w-56 bg-[#111113] border border-[#2a2a30] rounded-xl shadow-xl overflow-hidden z-50"
                                >
                                    <div className="p-3 border-b border-[#1e1e22]">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[12px] font-medium text-[#e8e8eb]">Get Support</span>
                                            <button
                                                onClick={() => setShowSupportPopup(false)}
                                                className="p-1 rounded-md hover:bg-[#1a1a1e] text-[#6b6b76] hover:text-[#a0a0ab] transition-colors"
                                            >
                                                <X size={14} />
                                            </button>
                                        </div>
                                    </div>
                                    <div className="p-2 space-y-1">
                                        <button
                                            onClick={() => {
                                                setShowSupportPopup(false);
                                                setShowFAQ(true);
                                            }}
                                            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[#1a1a1e] transition-colors group w-full text-left"
                                        >
                                            <HelpCircle size={16} className="text-amber-400" />
                                            <div>
                                                <div className="text-[12px] font-medium text-[#e8e8eb]">FAQ</div>
                                                <div className="text-[10px] text-[#6b6b76]">Common questions</div>
                                            </div>
                                        </button>
                                        <a
                                            href="https://github.com/LegendarySpy/Glimpse"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            onClick={() => setShowSupportPopup(false)}
                                            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[#1a1a1e] transition-colors group"
                                        >
                                            <Github size={16} className="text-[#a0a0ab]" />
                                            <div>
                                                <div className="text-[12px] font-medium text-[#e8e8eb]">GitHub Issues</div>
                                                <div className="text-[10px] text-[#6b6b76]">Report bugs & features</div>
                                            </div>
                                        </a>
                                        <button
                                            onClick={() => {
                                                setShowSupportPopup(false);
                                                setSettingsTab("about");
                                                setIsSettingsOpen(true);
                                            }}
                                            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[#1a1a1e] transition-colors group w-full text-left"
                                        >
                                            <Info size={16} className="text-[#5865F2]" />
                                            <div>
                                                <div className="text-[12px] font-medium text-[#e8e8eb]">About</div>
                                                <div className="text-[10px] text-[#6b6b76]">v{appVersion} • {isCloudMode ? "Cloud" : "Local"}</div>
                                            </div>
                                        </button>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    <SidebarItem
                        icon={<Settings size={18} />}
                        label="Settings"
                        collapsed={isSidebarCollapsed}
                        onClick={() => setIsSettingsOpen(true)}
                    />
                </div>
            </motion.aside>

            <main className="flex flex-1 flex-col bg-[#0e0e10] overflow-hidden relative">
                <div data-tauri-drag-region className="h-8 w-full shrink-0" />

                {currentUser && (
                    <button
                        onClick={() => {
                            setSettingsTab("account");
                            setIsSettingsOpen(true);
                        }}
                        className="fixed top-10 right-6 flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#1e1e22] bg-[#111113] hover:bg-[#161618] hover:border-[#2a2a30] transition-colors z-10"
                    >
                        <div className="w-6 h-6 rounded-full bg-[#1a1a1e] border border-[#2a2a30] flex items-center justify-center overflow-hidden">
                            {(currentUser.prefs as Record<string, string>)?.avatar ? (
                                <img
                                    src={(currentUser.prefs as Record<string, string>).avatar}
                                    alt=""
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <User size={14} className="text-[#6b6b76]" />
                            )}
                        </div>
                        <span className="text-[12px] text-[#a0a0ab] max-w-[100px] truncate">
                            {currentUser.name || currentUser.email?.split("@")[0] || "Account"}
                        </span>
                    </button>
                )}

                <div className="flex-1 flex flex-col px-12 pb-16">
                    <AnimatePresence mode="wait">
                        {activeView === "home" && (
                            <motion.div
                                key="home"
                                className="w-full max-w-2xl mx-auto pt-8"
                                initial={{ opacity: 0, y: 12 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: 12 }}
                                transition={{ duration: 0.25, ease: "easeOut" }}
                            >
                                <div className="mb-8">
                                    <h1 className="text-3xl font-medium text-[#e8e8eb] tracking-tight">
                                        {getGreeting()}
                                    </h1>
                                    <p className="mt-2 text-[15px] text-[#5a5a64]">
                                        Ready when you are
                                    </p>
                                </div>

                                <TranscriptionList showLlmButtons={showLlmButtons} />
                            </motion.div>
                        )}

                        {activeView === "dictionary" && (
                            <motion.div
                                key="dictionary"
                                className="w-full max-w-3xl mx-auto pt-8"
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: 8 }}
                                transition={{ duration: 0.25, ease: "easeOut" }}
                            >
                                <DictionaryView />
                            </motion.div>
                        )}

                        {activeView === "brain" && (
                            <motion.div
                                key="brain"
                                className="flex flex-col items-center justify-start pt-12 text-[#4a4a54]"
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: 8 }}
                                transition={{ duration: 0.25, ease: "easeOut" }}
                            >
                                <Brain size={48} strokeWidth={1} className="mb-4 opacity-50" />
                                <p className="mb-2">Personalization</p>
                                <span className="px-2 py-0.5 rounded-md bg-amber-400/10 border border-amber-400/20 text-amber-400 text-[10px] font-medium">
                                    Work in Progress
                                </span>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </main>

            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => {
                    setIsSettingsOpen(false);
                    setSettingsTab("general");
                }}
                initialTab={settingsTab}
                currentUser={currentUser}
                onUpdateUser={loadUser}
                transcriptionMode={transcriptionMode}
            />

            <FAQModal
                isOpen={showFAQ}
                onClose={() => setShowFAQ(false)}
            />
        </div>
    );
};

export default Home;
