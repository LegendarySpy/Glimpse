import React, { useState } from "react";
import { motion } from "framer-motion";
import { Copy, Trash2, RotateCw, Check, ChevronDown, ChevronUp } from "lucide-react";
import { TranscriptionRecord } from "../hooks/useTranscriptions";
import DotMatrix from "./DotMatrix";

interface TranscriptionItemProps {
    record: TranscriptionRecord;
    onDelete: (id: string) => Promise<void>;
    onRetry: (id: string) => Promise<void>;
}

const TranscriptionItem: React.FC<TranscriptionItemProps> = ({ record, onDelete, onRetry }) => {
    const [copied, setCopied] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isRetrying, setIsRetrying] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(record.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    };

    const handleDelete = async () => {
        if (isDeleting) return;
        setIsDeleting(true);
        try {
            await onDelete(record.id);
        } catch (err) {
            console.error("Failed to delete:", err);
            setIsDeleting(false);
        }
    };

    const handleRetry = async () => {
        if (isRetrying) return;
        setIsRetrying(true);
        try {
            await onRetry(record.id);
            // Keep showing retrying state - it will be removed when new transcription comes in
        } catch (err) {
            console.error("Failed to retry:", err);
            setIsRetrying(false);
        }
    };

    const timestamp = new Date(record.timestamp);
    const timeStr = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = timestamp.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const isError = record.status === "error";
    const displayText = record.text || record.error_message || "Transcription failed";

    // Only truncate if text is very long (>300 chars)
    const shouldTruncate = displayText.length > 300;
    const truncatedText = shouldTruncate && !isExpanded
        ? displayText.slice(0, 300) + "..."
        : displayText;

    return (
        <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
            className="group relative"
        >
            <div className="flex items-start gap-3 py-3 px-4 rounded-lg hover:bg-[#131316] transition-colors">
                {/* Status Indicator */}
                <div className="mt-1.5 shrink-0">
                    {isRetrying ? (
                        <DotMatrix
                            rows={1}
                            cols={3}
                            activeDots={[0, 1, 2]}
                            dotSize={4}
                            gap={2}
                            color="#fbbf24"
                            animated
                            className="opacity-70"
                        />
                    ) : (
                        <DotMatrix
                            rows={1}
                            cols={1}
                            activeDots={[0]}
                            dotSize={4}
                            gap={1}
                            color={isError ? "#ef4444" : "#4ade80"}
                            className="opacity-70"
                        />
                    )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] text-[#5a5a64] uppercase tracking-wider font-medium">
                            {dateStr}
                        </span>
                        <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={2} gap={1} color="#3a3a42" />
                        <span className="text-[10px] text-[#4a4a54] font-mono">
                            {timeStr}
                        </span>
                        {isRetrying && (
                            <>
                                <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={2} gap={1} color="#3a3a42" />
                                <span className="text-[10px] text-[#fbbf24] uppercase tracking-wider font-medium">
                                    Retrying...
                                </span>
                            </>
                        )}
                    </div>

                    <p className={`text-[13px] leading-relaxed whitespace-pre-wrap ${isError ? "text-[#8a8a96] italic" : "text-[#c8c8d2]"}`}>
                        {truncatedText}
                    </p>

                    <div className="flex items-center gap-3 mt-1">
                        {record.confidence && (
                            <span className="text-[9px] text-[#4a4a54]">
                                {Math.round(record.confidence * 100)}% confidence
                            </span>
                        )}

                        {shouldTruncate && (
                            <button
                                onClick={() => setIsExpanded(!isExpanded)}
                                className="flex items-center gap-1 text-[9px] text-[#6b6b76] hover:text-[#8a8a96] transition-colors"
                            >
                                {isExpanded ? (
                                    <>
                                        <ChevronUp size={12} />
                                        <span>Show less</span>
                                    </>
                                ) : (
                                    <>
                                        <ChevronDown size={12} />
                                        <span>Show more</span>
                                    </>
                                )}
                            </button>
                        )}
                    </div>
                </div>

                {/* Actions */}
                {!isRetrying && (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {!isError && (
                            <motion.button
                                onClick={handleCopy}
                                whileTap={{ scale: 0.95 }}
                                className="p-1.5 rounded-md hover:bg-[#1a1a1e] transition-colors"
                                title="Copy to clipboard"
                            >
                                {copied ? (
                                    <Check size={14} className="text-[#4ade80]" />
                                ) : (
                                    <Copy size={14} className="text-[#6b6b76]" />
                                )}
                            </motion.button>
                        )}

                        {isError && (
                            <motion.button
                                onClick={handleRetry}
                                whileTap={{ scale: 0.95 }}
                                className="p-1.5 rounded-md hover:bg-[#1a1a1e] transition-colors disabled:opacity-50"
                                disabled={isRetrying}
                                title="Retry transcription"
                            >
                                <RotateCw
                                    size={14}
                                    className="text-[#fbbf24]"
                                />
                            </motion.button>
                        )}

                        <motion.button
                            onClick={handleDelete}
                            whileTap={{ scale: 0.95 }}
                            className="p-1.5 rounded-md hover:bg-[#1a1a1e] transition-colors disabled:opacity-50"
                            disabled={isDeleting}
                            title="Delete"
                        >
                            <Trash2
                                size={14}
                                className={`text-[#8a8a96] ${isDeleting ? "opacity-50" : ""}`}
                            />
                        </motion.button>
                    </div>
                )}
            </div>

            {/* Subtle divider */}
            <div className="h-px bg-gradient-to-r from-transparent via-[#1a1a1e] to-transparent mx-4" />
        </motion.div>
    );
};

export default TranscriptionItem;
