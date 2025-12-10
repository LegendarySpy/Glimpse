import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, X } from "lucide-react";
import { useTranscriptions } from "../hooks/useTranscriptions";
import TranscriptionItem from "./TranscriptionItem";
import DotMatrix from "./DotMatrix";

const TranscriptionList: React.FC = () => {
    const { transcriptions, isLoading, deleteTranscription, retryTranscription, retryLlmCleanup, undoLlmCleanup, clearAllTranscriptions } = useTranscriptions();
    const [searchQuery, setSearchQuery] = useState("");
    const [isClearing, setIsClearing] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    const confirmClearAll = async () => {
        setIsClearing(true);
        try {
            await clearAllTranscriptions();
            setShowConfirm(false);
        } catch (err) {
            console.error("Failed to clear all transcriptions:", err);
        } finally {
            setIsClearing(false);
        }
    };

    const filteredTranscriptions = useMemo(() => {
        if (!searchQuery.trim()) return transcriptions;
        const query = searchQuery.toLowerCase();
        return transcriptions.filter(record =>
            record.text.toLowerCase().includes(query) ||
            record.raw_text?.toLowerCase().includes(query)
        );
    }, [transcriptions, searchQuery]);

    if (isLoading && transcriptions.length === 0) {
        return (
            <div className="flex items-center justify-center py-12">
                <DotMatrix
                    rows={2}
                    cols={8}
                    activeDots={[0, 1, 2, 3, 4, 5, 6, 7]}
                    dotSize={3}
                    gap={3}
                    color="#6b6b76"
                    animated
                    className="opacity-50"
                />
            </div>
        );
    }

    if (transcriptions.length === 0) {
        return (
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center justify-center py-16 px-6"
            >
                <DotMatrix
                    rows={4}
                    cols={4}
                    activeDots={[0, 3, 5, 6, 9, 10, 12, 15]}
                    dotSize={4}
                    gap={4}
                    color="#4a4a54"
                    className="opacity-40 mb-4"
                />
                <p className="text-[13px] text-[#5a5a64] text-center max-w-xs">
                    Your recent transcriptions will appear here
                </p>
            </motion.div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="w-full max-w-2xl"
        >
            <div className="flex items-center justify-between px-4 pb-3 mb-2">
                <div className="flex items-center gap-2">
                    <DotMatrix
                        rows={1}
                        cols={3}
                        activeDots={[0, 1, 2]}
                        dotSize={3}
                        gap={2}
                        color="#fbbf24"
                        className="opacity-60"
                    />
                    <h2 className="text-[11px] text-[#6b6b76] uppercase tracking-wider font-semibold">
                        Recent Transcriptions
                    </h2>
                </div>

                <div className="relative">
                    <div className="flex items-center gap-2 bg-[#0a0a0c] border border-[#1a1a1e] rounded-lg px-2.5 py-1.5 focus-within:border-[#2a2a30] transition-colors">
                        <Search size={12} className="text-[#4a4a54] shrink-0" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search..."
                            className="bg-transparent text-[11px] text-[#c8c8d2] placeholder-[#4a4a54] outline-none w-28 focus:w-36 transition-all"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery("")}
                                className="text-[#4a4a54] hover:text-[#6b6b76] transition-colors"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="bg-[#0a0a0c] rounded-xl border border-[#1a1a1e] overflow-hidden relative">
                <div className="absolute top-0 left-0 right-2 h-[6px] bg-gradient-to-b from-[#0a0a0c] to-transparent z-10 pointer-events-none" />

                <div className="absolute bottom-0 left-0 right-2 h-[6px] bg-gradient-to-t from-[#0a0a0c] to-transparent z-10 pointer-events-none" />

                <div
                    className="max-h-[460px] overflow-y-auto custom-scrollbar scrollbar-balanced snap-y snap-proximity pt-[6px] scroll-pt-[6px]"
                >
                    <AnimatePresence mode="popLayout">
                        {filteredTranscriptions.length > 0 ? (
                            filteredTranscriptions.map((record) => (
                                <TranscriptionItem
                                    key={record.id}
                                    record={record}
                                    onDelete={deleteTranscription}
                                    onRetry={retryTranscription}
                                    onRetryLlm={retryLlmCleanup}
                                    onUndoLlm={undoLlmCleanup}
                                />
                            ))
                        ) : (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="flex flex-col items-center justify-center py-8 px-4"
                            >
                                <Search size={20} className="text-[#3a3a42] mb-2" />
                                <p className="text-[12px] text-[#4a4a54] text-center">
                                    No results for "{searchQuery}"
                                </p>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>

            <div className="flex items-center justify-between px-4 pt-2">
                <span className="text-[9px] text-[#3a3a42] uppercase tracking-wider">
                    {searchQuery ? (
                        `${filteredTranscriptions.length} of ${transcriptions.length} transcriptions`
                    ) : (
                        `${transcriptions.length} ${transcriptions.length === 1 ? 'transcription' : 'transcriptions'}`
                    )}
                </span>
                {transcriptions.length > 0 && (
                    showConfirm ? (
                        <div className="flex items-center gap-3">
                            <button
                                onClick={confirmClearAll}
                                disabled={isClearing}
                                className="text-[9px] text-red-300 uppercase tracking-wider hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isClearing ? 'Clearing...' : 'Confirm'}
                            </button>
                            <button
                                onClick={() => setShowConfirm(false)}
                                disabled={isClearing}
                                className="text-[9px] text-[#5a5a64] uppercase tracking-wider hover:text-[#8a8a94] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Cancel
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => setShowConfirm(true)}
                            className="text-[9px] text-[#5a5a64] uppercase tracking-wider hover:text-red-400 transition-colors"
                        >
                            Clear All
                        </button>
                    )
                )}
            </div>

            <style>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 4px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: transparent;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: #1a1a1e;
                    border-radius: 3px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: #252528;
                }
                .scrollbar-balanced {
                    scrollbar-gutter: stable both-edges;
                }
            `}</style>
        </motion.div>
    );
};

export default React.memo(TranscriptionList);
