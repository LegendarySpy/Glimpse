import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, ChevronLeft } from "lucide-react";
import SettingsModal from "./components/SettingsModal";
import DotMatrix from "./components/DotMatrix";

const Home = () => {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
    const [pulsePhase, setPulsePhase] = useState(0);

    const sidebarWidth = isSidebarCollapsed ? 56 : 180;

    // Subtle animation for dot matrix
    useEffect(() => {
        const interval = setInterval(() => {
            setPulsePhase((prev) => (prev + 1) % 100);
        }, 120);
        return () => clearInterval(interval);
    }, []);

    // Get greeting based on time of day
    const getGreeting = () => {
        const hour = new Date().getHours();
        if (hour < 12) return "Good morning";
        if (hour < 17) return "Good afternoon";
        return "Good evening";
    };

    // Animated wave pattern for the main visual
    const waveActiveDots = useMemo(() => {
        const dots: number[] = [];
        const cols = 16;
        const rows = 8;
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const index = row * cols + col;
                const wave = Math.sin((col * 0.4 + pulsePhase * 0.08)) * 0.5 + 0.5;
                const threshold = 1 - (row / rows) * 0.8;
                if (wave > threshold) {
                    dots.push(index);
                }
            }
        }
        return dots;
    }, [pulsePhase]);

    return (
        <div className="flex h-screen w-screen overflow-hidden bg-[#0e0e10] font-sans text-white select-none">
            {/* Minimal Sidebar */}
            <motion.aside
                initial={false}
                animate={{ width: sidebarWidth }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="relative flex flex-col border-r border-[#1a1a1e] bg-[#0a0a0c]"
            >
                <div data-tauri-drag-region className="h-7 w-full shrink-0" />

                {/* Logo */}
                <div className={`px-3 pb-4 ${isSidebarCollapsed ? "flex justify-center" : ""}`}>
                    <motion.div className="flex items-center gap-2" layout>
                        <DotMatrix
                            rows={2}
                            cols={2}
                            activeDots={[0, 3]}
                            dotSize={3}
                            gap={2}
                            color="#fbbf24"
                        />
                        <AnimatePresence mode="wait">
                            {!isSidebarCollapsed && (
                                <motion.span
                                    initial={{ opacity: 0, x: -6 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -6 }}
                                    transition={{ duration: 0.12 }}
                                    className="text-[12px] font-semibold tracking-wide text-[#e8e8eb]"
                                >
                                    Glimpse
                                </motion.span>
                            )}
                        </AnimatePresence>
                    </motion.div>
                </div>

                <div className="flex-1" />

                {/* Bottom controls */}
                <div className="p-2 space-y-1">
                    <motion.button
                        onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                        className="flex w-full items-center justify-center gap-2 rounded-lg p-2 text-[#4a4a54] hover:text-[#6b6b76] transition-colors"
                        whileTap={{ scale: 0.97 }}
                    >
                        <motion.div
                            animate={{ rotate: isSidebarCollapsed ? 180 : 0 }}
                            transition={{ type: "spring", stiffness: 300, damping: 25 }}
                        >
                            <ChevronLeft size={14} />
                        </motion.div>
                    </motion.button>

                    <motion.button
                        onClick={() => setIsSettingsOpen(true)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[#6b6b76] hover:bg-[#151517] hover:text-[#a0a0ab] transition-colors ${isSidebarCollapsed ? "justify-center" : ""}`}
                        whileTap={{ scale: 0.97 }}
                    >
                        <Settings size={15} />
                        <AnimatePresence mode="wait">
                            {!isSidebarCollapsed && (
                                <motion.span
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="text-[11px] font-medium"
                                >
                                    Settings
                                </motion.span>
                            )}
                        </AnimatePresence>
                    </motion.button>
                </div>
            </motion.aside>

            {/* Main Content - Clean, flowing layout */}
            <main className="flex flex-1 flex-col bg-[#0e0e10] overflow-hidden">
                <div data-tauri-drag-region className="h-7 w-full shrink-0" />
                
                <div className="flex-1 flex flex-col justify-center px-12 pb-16">
                    <motion.div 
                        className="max-w-lg"
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                    >
                        {/* Greeting - large and personal */}
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1, duration: 0.4 }}
                        >
                            <h1 className="text-3xl font-medium text-[#e8e8eb] tracking-tight">
                                {getGreeting()}
                            </h1>
                            <p className="mt-2 text-[15px] text-[#5a5a64]">
                                Ready when you are
                            </p>
                        </motion.div>

                        {/* Main visual - dot matrix wave */}
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: 0.25, duration: 0.6 }}
                            className="mt-12 mb-12"
                        >
                            <DotMatrix
                                rows={8}
                                cols={16}
                                activeDots={waveActiveDots}
                                dotSize={6}
                                gap={6}
                                color="#fbbf24"
                                className="opacity-80"
                            />
                        </motion.div>

                        {/* Instructions - clean text, no box */}
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.35, duration: 0.4 }}
                            className="space-y-4"
                        >
                            <p className="text-[14px] text-[#6b6b76] leading-relaxed">
                                Hold your shortcut anywhere to start recording.
                                <br />
                                Release to transcribe and paste instantly.
                            </p>

                            {/* Shortcut display - subtle, inline */}
                            <div className="flex items-center gap-3">
                                <div className="inline-flex items-center gap-1.5">
                                    <kbd className="px-2 py-1 rounded-md bg-[#18181b] text-[11px] font-medium text-[#8a8a96] border border-[#252528]">⌃</kbd>
                                    <span className="text-[#3a3a42]">+</span>
                                    <kbd className="px-2 py-1 rounded-md bg-[#18181b] text-[11px] font-medium text-[#8a8a96] border border-[#252528]">Space</kbd>
                                </div>
                            </div>
                        </motion.div>

                        {/* Subtle footer info */}
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: 0.5, duration: 0.4 }}
                            className="mt-16 flex items-center gap-4"
                        >
                            <DotMatrix
                                rows={1}
                                cols={8}
                                activeDots={[0, 1, 2, 3, 4, 5, 6, 7]}
                                dotSize={3}
                                gap={3}
                                color="#4ade80"
                                className="opacity-50"
                            />
                            <span className="text-[10px] text-[#3a3a42] uppercase tracking-wider">Ready</span>
                        </motion.div>
                    </motion.div>
                </div>
            </main>

            <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
        </div>
    );
};

export default Home;
