import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranscriptions } from "../hooks/useTranscriptions";
import TranscriptionItem from "./TranscriptionItem";
import DotMatrix from "./DotMatrix";

const TranscriptionList: React.FC = () => {
    const { transcriptions, isLoading, deleteTranscription, retryTranscription } = useTranscriptions();

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
            {/* Header */}
            <div className="flex items-center gap-2 px-4 pb-3 mb-2">
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

            {/* List Container */}
            <div className="bg-[#0a0a0c] rounded-xl border border-[#1a1a1e] overflow-hidden">
                <div className="max-h-[460px] overflow-y-auto custom-scrollbar">
                    <AnimatePresence mode="popLayout">
                        {transcriptions.map((record) => (
                            <TranscriptionItem
                                key={record.id}
                                record={record}
                                onDelete={deleteTranscription}
                                onRetry={retryTranscription}
                            />
                        ))}
                    </AnimatePresence>
                </div>
            </div>

            {/* Footer with count */}
            <div className="flex items-center justify-between px-4 pt-2">
                <span className="text-[9px] text-[#3a3a42] uppercase tracking-wider">
                    {transcriptions.length} {transcriptions.length === 1 ? 'transcription' : 'transcriptions'}
                </span>
            </div>

            <style>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 6px;
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
            `}</style>
        </motion.div>
    );
};

export default React.memo(TranscriptionList);
