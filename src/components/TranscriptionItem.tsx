import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, Trash2, RotateCw, Check, ChevronDown, ChevronUp, MoreVertical, Wand2, AlertTriangle, Undo2, Cloud } from "lucide-react";
import { TranscriptionRecord } from "../hooks/useTranscriptions";
import DotMatrix from "./DotMatrix";

interface TranscriptionItemProps {
    record: TranscriptionRecord;
    onDelete: (id: string) => Promise<void>;
    onRetry: (id: string) => Promise<void>;
    onRetryLlm?: (id: string) => Promise<void>;
    onUndoLlm?: (id: string) => Promise<void>;
    showLlmButtons?: boolean;
    searchQuery?: string;
    skipAnimation?: boolean;
    shiftHeld?: boolean;
}

const TranscriptionItem: React.FC<TranscriptionItemProps> = ({ record, onDelete, onRetry, onRetryLlm, onUndoLlm, showLlmButtons = false, searchQuery = "", skipAnimation = false, shiftHeld = false }) => {
    const [copied, setCopied] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isRetrying, setIsRetrying] = useState(false);
    const [retryError, setRetryError] = useState<string | null>(null);
    const [isRetryingLlm, setIsRetryingLlm] = useState(false);
    const [isUndoingLlm, setIsUndoingLlm] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setMenuOpen(false);
            }
        };

        if (menuOpen) {
            document.addEventListener("mousedown", handleClickOutside);
        }
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [menuOpen]);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(record.text);
            setCopied(true);
            setMenuOpen(false);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    };

    const handleDelete = () => {
        if (isDeleting) return;
        setIsDeleting(true);
        setMenuOpen(false);
        onDelete(record.id).catch(err => {
            console.error("Failed to delete:", err);
            setIsDeleting(false);
        });
    };

    const handleRetry = async () => {
        if (isRetrying) return;
        setIsRetrying(true);
        setRetryError(null);
        setMenuOpen(false);
        try {
            await onRetry(record.id);
        } catch (err) {
            console.error("Failed to retry:", err);
            setIsRetrying(false);
            setRetryError(typeof err === "string" ? err : "Retry failed");
        }
    };

    const handleRetryLlm = async () => {
        if (isRetryingLlm || !onRetryLlm) return;
        setIsRetryingLlm(true);
        setMenuOpen(false);
        try {
            await onRetryLlm(record.id);
        } catch (err) {
            console.error("Failed to retry LLM cleanup:", err);
        } finally {
            setIsRetryingLlm(false);
        }
    };

    const handleUndoLlm = async () => {
        if (isUndoingLlm || !onUndoLlm) return;
        setIsUndoingLlm(true);
        setMenuOpen(false);
        try {
            await onUndoLlm(record.id);
        } catch (err) {
            console.error("Failed to undo LLM cleanup:", err);
        } finally {
            setIsUndoingLlm(false);
        }
    };

    const timestamp = new Date(record.timestamp);
    const timeStr = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = timestamp.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const isError = record.status === "error";
    const errorMessage = record.error_message || "Transcription failed";
    const displayText = isError ? null : record.text;
    const speechModelLabel = record.speech_model?.trim() 
        ? (record.speech_model.startsWith("cloud-") ? record.speech_model.slice(6) : record.speech_model)
        : "Unknown model";
    const isCloudModel = record.speech_model?.startsWith("cloud-") ?? false;
    const llmModelLabel = record.llm_model?.trim() || null;
    const wordCountLabel = `${record.word_count || 0} ${record.word_count === 1 ? "word" : "words"}`;
    const formatDuration = (seconds: number) => {
        if (!Number.isFinite(seconds) || seconds <= 0) return "0s audio";
        if (seconds < 60) {
            return `${seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0)}s audio`;
        }
        const minutes = Math.floor(seconds / 60);
        const remaining = Math.round(seconds % 60);
        return remaining === 0 ? `${minutes}m audio` : `${minutes}m ${remaining}s audio`;
    };

    // Only truncate if text is very long (>300 chars)
    const shouldTruncate = displayText && displayText.length > 300;
    const truncatedText = shouldTruncate && !isExpanded
        ? displayText.slice(0, 300) + "..."
        : displayText;

    const highlightText = (text: string | null, query: string) => {
        if (!text || !query.trim()) return text;
        const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        const parts = text.split(regex);
        return parts.map((part, i) =>
            regex.test(part) ? (
                <mark key={i} className="bg-amber-400/30 text-amber-200 rounded-sm px-0.5">{part}</mark>
            ) : part
        );
    };

    return (
        <motion.div
            initial={skipAnimation ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.2 }}
            className="group relative snap-start"
        >
            <div className={`flex items-start gap-3 py-3 px-4 rounded-lg transition-colors ${isError ? "bg-red-500/[0.03]" : "hover:bg-surface-surface"}`}>
                {/* Status Indicator */}
                <div className="mt-1.5 shrink-0">
                    {isRetrying ? (
                        <DotMatrix
                            rows={1}
                            cols={1}
                            activeDots={[0]}
                            dotSize={4}
                            gap={1}
                            color="var(--color-warning)"
                            className="opacity-70"
                        />
                    ) : isError ? (
                        <AlertTriangle size={14} className="text-red-400/70" />
                    ) : (
                        <DotMatrix
                            rows={1}
                            cols={1}
                            activeDots={[0]}
                            dotSize={4}
                            gap={1}
                            color="var(--color-success)"
                            className="opacity-70"
                        />
                    )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] text-content-muted uppercase tracking-wider font-medium">
                            {dateStr}
                        </span>
                        <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={2} gap={1} color="var(--color-border-hover)" />
                        <span className="text-[10px] text-content-disabled font-mono">
                            {timeStr}
                        </span>
                        {isError && (
                            <>
                                <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={2} gap={1} color="var(--color-border-hover)" />
                                <span className="text-[9px] text-red-400 font-medium uppercase tracking-wider">
                                    Failed
                                </span>
                            </>
                        )}
                        {isCloudModel && !isError && (
                            <>
                                <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={2} gap={1} color="var(--color-border-hover)" />
                                <span className="flex items-center gap-1 text-[9px] text-cloud">
                                    <Cloud size={9} />
                                    Cloud
                                </span>
                            </>
                        )}
                        {record.llm_cleaned && !isError && !isCloudModel && (
                            <>
                                <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={2} gap={1} color="var(--color-border-hover)" />
                                <span className="flex items-center gap-1 text-[9px] text-local">
                                    <Wand2 size={9} />
                                    Cleaned
                                </span>
                            </>
                        )}
                        {isRetrying && (
                            <>
                                <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={2} gap={1} color="var(--color-border-hover)" />
                                <span className="text-[10px] text-cloud uppercase tracking-wider font-medium">
                                    Retrying...
                                </span>
                            </>
                        )}
                    </div>

                    {isError ? (
                        <div className="flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/[0.06] px-2.5 py-2">
                            <p className="text-[12px] text-red-300/80">
                                {retryError || errorMessage}
                            </p>
                        </div>
                    ) : (
                        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-content-secondary select-text cursor-text">
                            {highlightText(truncatedText, searchQuery)}
                        </p>
                    )}

                    <div className="flex flex-wrap items-center gap-3 mt-1 text-[9px] text-content-disabled">
                        {!isError && (
                            <>
                                <span>{wordCountLabel}</span>
                                <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={2} gap={1} color="var(--color-border-hover)" />
                                <span>{formatDuration(record.audio_duration_seconds ?? 0)}</span>
                                <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={2} gap={1} color="var(--color-border-hover)" />
                                <span>Speech: {speechModelLabel}</span>
                                {llmModelLabel && (
                                    <>
                                        <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={2} gap={1} color="var(--color-border-hover)" />
                                        <span>LLM: {llmModelLabel}</span>
                                    </>
                                )}
                            </>
                        )}

                        {shouldTruncate && (
                            <button
                                onClick={() => setIsExpanded(!isExpanded)}
                                className="flex items-center gap-1 text-[9px] text-content-muted hover:text-content-secondary transition-colors"
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

                {/* Actions - Copy and menu buttons */}
                {!isRetrying && !isRetryingLlm && !isUndoingLlm && (
                    <div className="relative shrink-0 flex items-center gap-1" ref={menuRef}>
                        {!isError && (
                            <motion.button
                                onClick={handleCopy}
                                whileTap={{ scale: 0.95 }}
                                className={`p-1.5 rounded-md transition-colors opacity-0 group-hover:opacity-100 hover:bg-surface-elevated ${copied ? "bg-surface-elevated" : ""
                                    }`}
                                title={copied ? "Copied" : "Copy transcription"}
                            >
                                {copied ? (
                                    <Check size={14} className="text-success" />
                                ) : (
                                    <Copy size={14} className="text-content-secondary" />
                                )}
                            </motion.button>
                        )}

                        <motion.button
                            onClick={() => {
                                if (shiftHeld) {
                                    handleDelete();
                                } else {
                                    setMenuOpen(!menuOpen);
                                }
                            }}
                            whileTap={{ scale: 0.95 }}
                            className={`p-1.5 rounded-md transition-colors opacity-0 group-hover:opacity-100 ${shiftHeld ? "hover:bg-red-500/10" : "hover:bg-surface-elevated"
                                }`}
                            title={shiftHeld ? "Delete" : "More options"}
                        >
                            {shiftHeld ? (
                                <Trash2 size={14} className="text-red-400" />
                            ) : (
                                <MoreVertical size={14} className="text-content-muted" />
                            )}
                        </motion.button>

                        <AnimatePresence>
                            {menuOpen && (
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.95, y: -4 }}
                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                    exit={{ opacity: 0, scale: 0.95, y: -4 }}
                                    transition={{ duration: 0.12 }}
                                    className="fixed z-[100] min-w-[160px] rounded-lg border border-border-secondary bg-surface-overlay shadow-xl shadow-black/50"
                                    style={{
                                        top: menuRef.current ? menuRef.current.getBoundingClientRect().bottom + 4 : 0,
                                        right: menuRef.current ? window.innerWidth - menuRef.current.getBoundingClientRect().right : 0,
                                    }}
                                >
                                    <button
                                        onClick={handleRetry}
                                        disabled={isRetrying}
                                        className="flex w-full items-center gap-2.5 px-3 py-2 text-[11px] text-content-secondary hover:bg-surface-elevated transition-colors disabled:opacity-50"
                                    >
                                        <RotateCw size={12} className="text-cloud" />
                                        <span>Retry</span>
                                    </button>

                                    {!isError && onRetryLlm && showLlmButtons && !isCloudModel && (
                                        <button
                                            onClick={handleRetryLlm}
                                            disabled={isRetryingLlm}
                                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[11px] text-content-secondary hover:bg-surface-elevated transition-colors disabled:opacity-50"
                                        >
                                            <RotateCw size={12} className="text-local" />
                                            <span>{record.llm_cleaned ? "Retry AI cleanup" : "Run AI cleanup"}</span>
                                        </button>
                                    )}

                                    {!isError && record.llm_cleaned && record.raw_text && onUndoLlm && showLlmButtons && !isCloudModel && (
                                        <button
                                            onClick={handleUndoLlm}
                                            disabled={isUndoingLlm}
                                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[11px] text-content-secondary hover:bg-surface-elevated transition-colors disabled:opacity-50"
                                        >
                                            <Undo2 size={12} className="text-warning" />
                                            <span>Undo AI cleanup</span>
                                        </button>
                                    )}

                                    <div className="h-px bg-border-secondary mx-2" />

                                    <button
                                        onClick={handleDelete}
                                        disabled={isDeleting}
                                        className="flex w-full items-center gap-2.5 px-3 py-2 text-[11px] text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                    >
                                        <Trash2 size={12} />
                                        <span>Delete</span>
                                    </button>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                )}

                {/* Loading state indicators */}
                {isRetryingLlm && (
                    <div className="flex items-center gap-1.5 text-[10px] text-local">
                        <RotateCw size={12} className="animate-spin" />
                        <span>Cleaning...</span>
                    </div>
                )}
                {isUndoingLlm && (
                    <div className="flex items-center gap-1.5 text-[10px] text-warning">
                        <Undo2 size={12} className="animate-pulse" />
                        <span>Reverting...</span>
                    </div>
                )}
            </div>

            {/* Subtle divider */}
            <div className="h-px bg-gradient-to-r from-transparent via-[#1a1a1e] to-transparent mx-4" />
        </motion.div>
    );
};

export default React.memo(TranscriptionItem);
