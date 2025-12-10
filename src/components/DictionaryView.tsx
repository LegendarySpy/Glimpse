import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, BookOpen, Edit3, Loader2, Plus, Trash2 } from "lucide-react";
import DotMatrix from "./DotMatrix";

type TranscriptionMode = "cloud" | "local";

type StoredSettings = {
    transcription_mode: TranscriptionMode;
    local_model: string;
    dictionary?: string[];
};

type ModelInfo = {
    key: string;
    label: string;
    engine: string;
    variant: string;
};

const normalizeEntry = (value: string) => value.trim();

const DictionaryView = () => {
    const [entries, setEntries] = useState<string[]>([]);
    const [newEntry, setNewEntry] = useState("");
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [editingValue, setEditingValue] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [settings, setSettings] = useState<StoredSettings | null>(null);
    const [models, setModels] = useState<ModelInfo[]>([]);

    // Derive filtered entries based on search query
    const searchQuery = newEntry.trim().toLowerCase();
    const filteredEntries = searchQuery
        ? entries.filter((entry) => entry.toLowerCase().includes(searchQuery))
        : entries;
    const isSearching = searchQuery.length > 0;

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [settingsResp, modelsResp] = await Promise.all([
                invoke<StoredSettings>("get_settings"),
                invoke<ModelInfo[]>("list_models"),
            ]);
            setSettings(settingsResp);
            setEntries(settingsResp.dictionary ?? []);
            setModels(modelsResp ?? []);
        } catch (err) {
            console.error(err);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const persistEntries = useCallback(
        async (next: string[]) => {
            setSaving(true);
            setError(null);
            try {
                const cleaned = await invoke<string[]>("set_dictionary", { entries: next });
                setEntries(cleaned);
                setEditingIndex(null);
                setEditingValue("");
                setNewEntry("");
            } catch (err) {
                console.error(err);
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setSaving(false);
            }
        },
        []
    );

    const handleAdd = async () => {
        const value = normalizeEntry(newEntry);
        if (!value) return;
        await persistEntries([...entries, value]);
    };

    const handleEditCommit = async () => {
        if (editingIndex === null) return;
        const value = normalizeEntry(editingValue);
        if (!value) {
            // treat empty edit as delete
            const next = entries.filter((_, idx) => idx !== editingIndex);
            await persistEntries(next);
            return;
        }
        const next = entries.map((entry, idx) => (idx === editingIndex ? value : entry));
        await persistEntries(next);
    };

    const handleDelete = async (idx: number) => {
        const next = entries.filter((_, i) => i !== idx);
        await persistEntries(next);
    };

    const startEditing = (idx: number) => {
        setEditingIndex(idx);
        setEditingValue(entries[idx]);
    };

    const currentModel = models.find((m) => m.key === settings?.local_model);
    const isLocal = settings?.transcription_mode === "local";
    const isWhisper =
        currentModel?.engine.toLowerCase().includes("whisper") ||
        currentModel?.variant.toLowerCase().includes("whisper");
    const showWarning = Boolean(isLocal && currentModel && !isWhisper);

    return (
        <div className="w-full max-w-2xl text-left">
            <div className="flex items-start gap-3 mb-6">
                <DotMatrix
                    rows={2}
                    cols={3}
                    activeDots={[0, 1, 2, 3]}
                    dotSize={3}
                    gap={3}
                    color="#fbbf24"
                />
                <div>
                    <p className="text-3xl font-medium text-[#e8e8eb] tracking-tight">
                        Word Dictionary
                    </p>
                    <p className="text-[14px] text-[#9a9aa3] mt-1">
                        Add custom words or phrases that arent in the default dictionary.
                    </p>
                </div>
            </div>

            {showWarning && (
                <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-100">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    <div className="text-[13px] leading-relaxed">
                        Dictionary only locally works with Whisper models. Current model {" "}
                        <span className="font-semibold">{currentModel?.label ?? settings?.local_model}</span> {" "}
                        will ignore these entries until you switch to a Whisper option.
                    </div>
                </div>
            )}

            <div className="rounded-xl border border-[#1a1a1e] bg-[#0a0a0c]">
                <div className="flex items-center gap-2 border-b border-[#121216] px-4 py-3">
                    <BookOpen size={16} className="text-[#e8e8eb]" />
                    <input
                        value={newEntry}
                        onChange={(e) => setNewEntry(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                handleAdd();
                            }
                        }}
                        placeholder="Search or add a word..."
                        className="flex-1 bg-transparent text-[14px] text-[#e8e8eb] placeholder-[#4a4a54] outline-none"
                    />
                    {isSearching && entries.length > 0 && (
                        <span className="text-[12px] text-[#8a8a94] whitespace-nowrap">
                            {filteredEntries.length} of {entries.length}
                        </span>
                    )}
                    <button
                        onClick={handleAdd}
                        disabled={!newEntry.trim() || saving || entries.includes(newEntry.trim())}
                        className="flex items-center gap-1 rounded-lg bg-[#1a1a1e] px-3 py-1.5 text-[13px] text-[#e8e8eb] hover:bg-[#222228] disabled:opacity-40 transition-colors"
                    >
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                        Add
                    </button>
                </div>

                <div className="max-h-[400px] overflow-y-auto custom-scrollbar">
                    {loading ? (
                        <div className="flex items-center justify-center py-10">
                            <DotMatrix
                                rows={2}
                                cols={6}
                                activeDots={[0, 1, 2, 3, 4, 5]}
                                dotSize={3}
                                gap={3}
                                color="#6b6b76"
                                animated
                                className="opacity-60"
                            />
                        </div>
                    ) : filteredEntries.length === 0 ? (
                        <div className="flex flex-col items-start gap-2 px-4 py-6 text-[#6b6b76]">
                            {isSearching ? (
                                <>
                                    <p className="text-[14px] font-medium">No matches found</p>
                                    <p className="text-[12px] text-[#5a5a64]">
                                        Press Enter to add "{newEntry.trim()}" as a new entry.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <p className="text-[14px] font-medium">No entries yet</p>
                                    <p className="text-[12px] text-[#5a5a64]">
                                        Add words, phrases or names that arent in the default dictionary.
                                    </p>
                                </>
                            )}
                        </div>
                    ) : (
                        <AnimatePresence mode="popLayout">
                            {filteredEntries.map((entry) => {
                                // Find the original index in entries array for edit/delete operations
                                const originalIndex = entries.indexOf(entry);
                                return (
                                    <motion.div
                                        key={entry + originalIndex}
                                        layout="position"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.18, ease: "easeOut" }}
                                        className="group flex items-center gap-3 border-b border-[#121216] px-4 py-3 last:border-none"
                                    >
                                        {editingIndex === originalIndex ? (
                                            <input
                                                value={editingValue}
                                                onChange={(e) => setEditingValue(e.target.value)}
                                                autoFocus
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter") {
                                                        e.preventDefault();
                                                        handleEditCommit();
                                                    }
                                                    if (e.key === "Escape") {
                                                        setEditingIndex(null);
                                                        setEditingValue("");
                                                    }
                                                }}
                                                onBlur={() => {
                                                    // Commit on blur to keep UX simple
                                                    handleEditCommit();
                                                }}
                                                className="flex-1 rounded-md border border-[#1f1f24] bg-[#0f0f12] px-2.5 py-1.5 text-[14px] text-[#e8e8eb] outline-none focus:border-[#2a2a30]"
                                            />
                                        ) : (
                                            <button
                                                onClick={() => startEditing(originalIndex)}
                                                className="flex-1 text-left"
                                            >
                                                <p className="text-[14px] text-[#e8e8eb]">{entry}</p>
                                                <p className="text-[11px] text-[#5a5a64] opacity-0 transition-opacity group-hover:opacity-100">
                                                    Click to edit
                                                </p>
                                            </button>
                                        )}

                                        <div className="flex items-center gap-2">
                                            {editingIndex === originalIndex ? (
                                                <div className="text-[11px] text-[#6b6b76]">
                                                    Press Enter to save
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() => startEditing(originalIndex)}
                                                    className="rounded-md bg-[#141419] p-1.5 text-[#cfcfd6] opacity-0 transition-all group-hover:opacity-100 hover:bg-[#1d1d22]"
                                                    title="Edit"
                                                >
                                                    <Edit3 size={14} />
                                                </button>
                                            )}
                                            <button
                                                onClick={() => handleDelete(originalIndex)}
                                                className="rounded-md bg-[#141419] p-1.5 text-[#c96b6b] opacity-0 transition-all group-hover:opacity-100 hover:bg-[#1d1d22]"
                                                title="Delete"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </AnimatePresence>
                    )}
                </div>

                {error && (
                    <div className="border-t border-[#121216] px-4 py-2 text-[12px] text-red-300">
                        {error}
                    </div>
                )}
            </div>

            <p className="mt-3 text-[11px] uppercase tracking-[0.14em] text-[#3a3a42]">
                {entries.length} {entries.length === 1 ? "entry" : "entries"}
                {saving ? " · Saving..." : ""}
            </p>

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
        </div>
    );
};

export default DictionaryView;

