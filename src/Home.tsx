import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, ChevronLeft, Home as HomeIcon, Book, Brain } from "lucide-react";
import SettingsModal from "./components/SettingsModal";
import DotMatrix from "./components/DotMatrix";
import TranscriptionList from "./components/TranscriptionList";

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
    <motion.button
        onClick={onClick}
        className={`group flex w-full items-center gap-3 rounded-lg h-9 transition-colors pl-[13px] ${active
            ? "bg-[#1a1a1e] text-[#e8e8eb]"
            : "text-[#6b6b76] hover:bg-[#151517] hover:text-[#a0a0ab]"
            }`}
        whileTap={{ scale: 0.97 }}
    >
        <div className={`shrink-0 ${active ? "text-[#e8e8eb]" : "group-hover:text-[#a0a0ab]"}`}>
            {icon}
        </div>
        <AnimatePresence mode="wait" initial={false}>
            {!collapsed && (
                <motion.span
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={{ duration: 0.2 }}
                    className="text-[13px] font-medium whitespace-nowrap overflow-hidden"
                >
                    {label}
                </motion.span>
            )}
        </AnimatePresence>
    </motion.button>
);

const Home = () => {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
    const [activeView, setActiveView] = useState<"home" | "dictionary" | "brain">("home");

    const sidebarWidth = isSidebarCollapsed ? 60 : 200;

    // Get greeting based on time of day
    const getGreeting = () => {
        const hour = new Date().getHours();
        if (hour < 12) return "Good morning";
        if (hour < 17) return "Good afternoon";
        return "Good evening";
    };

    return (
        <div className="flex h-screen w-screen overflow-hidden bg-[#0e0e10] font-sans text-white select-none">
            {/* Top titlebar - invisible drag region */}
            <div 
                data-tauri-drag-region 
                className="fixed top-0 left-0 right-0 h-8 z-50"
            />

            {/* Tactile Sidebar */}
            <motion.aside
                initial={false}
                animate={{ width: sidebarWidth }}
                transition={{
                    type: "spring",
                    stiffness: 400,
                    damping: 30,
                    mass: 0.8
                }}
                className="relative flex flex-col border-r border-[#1a1a1e] bg-[#0a0a0c]"
            >
                <div data-tauri-drag-region className="h-8 w-full shrink-0" />

                {/* Logo */}
                <div className="pl-6 pb-6 pt-1">
                    <motion.div className="flex items-center gap-3 h-6" layout>
                        <div className="shrink-0">
                            <DotMatrix
                                rows={2}
                                cols={2}
                                activeDots={[0, 3]}
                                dotSize={4}
                                gap={3}
                                color="#fbbf24"
                            />
                        </div>
                        <AnimatePresence mode="wait" initial={false}>
                            {!isSidebarCollapsed && (
                                <motion.span
                                    initial={{ opacity: 0, x: -10 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -10 }}
                                    transition={{ duration: 0.2 }}
                                    className="text-[14px] font-bold tracking-wide text-[#e8e8eb]"
                                >
                                    Glimpse
                                </motion.span>
                            )}
                        </AnimatePresence>
                    </motion.div>
                </div>

                {/* Navigation */}
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
                        label="Brain"
                        active={activeView === "brain"}
                        collapsed={isSidebarCollapsed}
                        onClick={() => setActiveView("brain")}
                    />
                </nav>

                {/* Bottom controls */}
                <div className="p-2 space-y-1 border-t border-[#1a1a1e]/50">
                    <motion.button
                        onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                        className="flex w-full items-center gap-2 rounded-lg h-9 text-[#4a4a54] hover:text-[#6b6b76] transition-colors pl-3.5"
                        whileTap={{ scale: 0.97 }}
                    >
                        <motion.div
                            animate={{ rotate: isSidebarCollapsed ? 180 : 0 }}
                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                        >
                            <ChevronLeft size={16} />
                        </motion.div>
                    </motion.button>

                    <SidebarItem
                        icon={<Settings size={18} />}
                        label="Settings"
                        collapsed={isSidebarCollapsed}
                        onClick={() => setIsSettingsOpen(true)}
                    />
                </div>
            </motion.aside>

            {/* Main Content - Clean, flowing layout */}
            <main className="flex flex-1 flex-col bg-[#0e0e10] overflow-hidden">
                <div data-tauri-drag-region className="h-8 w-full shrink-0" />

                <div className="flex-1 flex flex-col items-center justify-center px-12 pb-16">
                    <AnimatePresence mode="wait">
                        {activeView === "home" && (
                            <motion.div
                                key="home"
                                className="w-full max-w-2xl"
                                initial={{ opacity: 0, y: 16 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -16 }}
                                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                            >
                                {/* Greeting - large and personal */}
                                <motion.div
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.1, duration: 0.4 }}
                                    className="mb-8"
                                >
                                    <h1 className="text-3xl font-medium text-[#e8e8eb] tracking-tight">
                                        {getGreeting()}
                                    </h1>
                                    <p className="mt-2 text-[15px] text-[#5a5a64]">
                                        Ready when you are
                                    </p>
                                </motion.div>

                                {/* Transcription List */}
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ delay: 0.2, duration: 0.5 }}
                                >
                                    <TranscriptionList />
                                </motion.div>
                            </motion.div>
                        )}

                        {activeView === "dictionary" && (
                            <motion.div
                                key="dictionary"
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                                className="flex flex-col items-center justify-center text-[#4a4a54]"
                            >
                                <Book size={48} strokeWidth={1} className="mb-4 opacity-50" />
                                <p>Dictionary</p>
                            </motion.div>
                        )}

                        {activeView === "brain" && (
                            <motion.div
                                key="brain"
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                                className="flex flex-col items-center justify-center text-[#4a4a54]"
                            >
                                <Brain size={48} strokeWidth={1} className="mb-4 opacity-50" />
                                <p>Brain</p>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </main>

            <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
        </div>
    );
};

export default Home;
