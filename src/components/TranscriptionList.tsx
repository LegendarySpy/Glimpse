import React, { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Search, X } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import { useTranscriptions } from "../hooks/useTranscriptions";
import TranscriptionItem from "./TranscriptionItem";
import DotMatrix from "./DotMatrix";

interface TranscriptionListProps {
    showLlmButtons?: boolean;
}

const TranscriptionList: React.FC<TranscriptionListProps> = ({ showLlmButtons = false }) => {
    const {
        transcriptions,
        totalCount,
        isLoading,
        deleteTranscription,
        retryTranscription,
        retryLlmCleanup,
        undoLlmCleanup,
        clearAllTranscriptions,
        searchTranscriptions,
        loadMore
    } = useTranscriptions();

    const [searchQuery, setSearchQuery] = useState("");
    const [debouncedQuery, setDebouncedQuery] = useState("");
    const [isClearing, setIsClearing] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
    const [shiftHeld, setShiftHeld] = useState(false);
    const hasLoadedOnce = useRef(false);
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Shift") setShiftHeld(true);
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === "Shift") setShiftHeld(false);
        };
        document.addEventListener("keydown", handleKeyDown);
        document.addEventListener("keyup", handleKeyUp);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            document.removeEventListener("keyup", handleKeyUp);
        };
    }, []);

    useEffect(() => {
        if (transcriptions.length > 0 && !hasLoadedOnce.current) {
            hasLoadedOnce.current = true;
        }
    }, [transcriptions.length]);

    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedQuery(searchQuery);
        }, 300);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    // Trigger search when debounced query changes
    useEffect(() => {
        searchTranscriptions(debouncedQuery);
    }, [debouncedQuery, searchTranscriptions]);

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

    if (isLoading && transcriptions.length === 0 && !debouncedQuery && !hasLoadedOnce.current) {
        return (
            <div className="flex items-center justify-center py-12">
                <DotMatrix
                    rows={2}
                    cols={8}
                    activeDots={[0, 1, 2, 3, 4, 5, 6, 7]}
                    dotSize={3}
                    gap={3}
                    color="var(--color-text-muted)"
                    animated
                    className="opacity-50"
                />
            </div>
        );
    }

    const showEmptyState = totalCount === 0 && !debouncedQuery && !isLoading;

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
                        color="var(--color-cloud)"
                        className="opacity-60"
                    />
                    <h2 className="text-[11px] text-content-muted uppercase tracking-wider font-semibold">
                        Recent Transcriptions
                    </h2>
                </div>

                <div className="relative">
                    <div className="flex items-center gap-2 bg-surface-secondary border border-border-primary rounded-lg px-2.5 py-1.5 focus-within:border-border-secondary transition-colors">
                        <Search size={12} className="text-content-disabled shrink-0" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search..."
                            className="bg-transparent text-[11px] text-content-secondary placeholder-content-disabled outline-none w-28 focus:w-36 transition-all"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery("")}
                                className="text-content-disabled hover:text-content-muted transition-colors"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="bg-surface-secondary rounded-xl border border-border-primary overflow-hidden relative" style={{ height: 460 }}>

                {showEmptyState ? (
                    <div className="h-full flex flex-col items-center justify-center">
                        <DotMatrix
                            rows={4}
                            cols={4}
                            activeDots={[0, 3, 5, 6, 9, 10, 12, 15]}
                            dotSize={4}
                            gap={4}
                            color="var(--color-text-disabled)"
                            className="opacity-40 mb-4"
                        />
                        <p className="text-[13px] text-content-muted text-center max-w-xs">
                            Your recent transcriptions will appear here
                        </p>
                    </div>
                ) : transcriptions.length > 0 || isLoading ? (
                    <Virtuoso
                        style={{ height: '100%' }}
                        totalCount={totalCount}
                        rangeChanged={({ startIndex, endIndex }) => {
                            const PAGE_SIZE = 50;
                            const startPage = Math.floor(startIndex / PAGE_SIZE) * PAGE_SIZE;
                            const endPage = Math.floor(endIndex / PAGE_SIZE) * PAGE_SIZE;

                            for (let offset = startPage; offset <= endPage; offset += PAGE_SIZE) {
                                loadMore(offset);
                            }
                        }}
                        overscan={200}
                        components={{
                            Header: () => <div className="h-1" />,
                        }}
                        itemContent={(index) => {
                            const record = transcriptions[index];
                            if (!record) {
                                return (
                                    <div className="pb-1 pl-1 pr-2">
                                        <div className="h-[100px] w-full rounded-lg bg-surface-surface border border-border-primary flex items-center justify-center">
                                            <DotMatrix
                                                rows={1}
                                                cols={3}
                                                activeDots={[0, 1, 2]}
                                                dotSize={3}
                                                gap={2}
                                                color="var(--color-border-secondary)"
                                                animated
                                            />
                                        </div>
                                    </div>
                                );
                            }

                            return (
                                <div className="pb-1 pl-1">
                                    <TranscriptionItem
                                        key={record.id}
                                        record={record}
                                        onDelete={deleteTranscription}
                                        onRetry={retryTranscription}
                                        onRetryLlm={retryLlmCleanup}
                                        onUndoLlm={undoLlmCleanup}
                                        showLlmButtons={showLlmButtons}
                                        searchQuery={debouncedQuery}
                                        skipAnimation={!!debouncedQuery}
                                        shiftHeld={shiftHeld}
                                    />
                                </div>
                            );
                        }}
                        className="custom-scrollbar scrollbar-balanced"
                    />
                ) : (
                    <div className="h-full flex flex-col items-center justify-center">
                        <div className="flex flex-col items-center justify-center py-8 px-4">
                            <Search size={20} className="text-border-hover mb-2" />
                            <p className="text-[12px] text-content-disabled text-center">
                                No results for "{searchQuery}"
                            </p>
                        </div>
                    </div>
                )}
            </div>

            <div className="flex items-center justify-between px-4 pt-2">
                <span className="text-[9px] text-border-hover uppercase tracking-wider">
                    {searchQuery ? (
                        `${transcriptions.length} result${transcriptions.length === 1 ? '' : 's'}`
                    ) : (
                        `${totalCount} ${totalCount === 1 ? 'transcription' : 'transcriptions'}`
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
                                className="text-[9px] text-content-muted uppercase tracking-wider hover:text-content-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Cancel
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => setShowConfirm(true)}
                            className="text-[9px] text-content-muted uppercase tracking-wider hover:text-red-400 transition-colors"
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
