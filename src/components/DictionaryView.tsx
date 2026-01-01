import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, ArrowRight, BookOpen, Edit3, Loader2, Plus, Replace, Trash2 } from "lucide-react";
import DotMatrix from "./DotMatrix";

type TranscriptionMode = "cloud" | "local";

type StoredSettings = {
    transcription_mode: TranscriptionMode;
    local_model: string;
    dictionary?: string[];
    replacements?: Replacement[];
};

type ModelInfo = {
    key: string;
    label: string;
    engine: string;
    variant: string;
};

type Replacement = {
    from: string;
    to: string;
};

type ActivePage = "dictionary" | "replacements";

const normalizeEntry = (value: string) => value.trim();

const PageSwitcher = ({
    activePage,
    onPageChange,
}: {
    activePage: ActivePage;
    onPageChange: (page: ActivePage) => void;
}) => {
    const pages: { key: ActivePage; label: string }[] = [
        { key: "dictionary", label: "Dictionary" },
        { key: "replacements", label: "Replacements" },
    ];

    return (
        <div className="flex items-center justify-center gap-2 mb-6">
            {pages.map((page) => (
                <button
                    key={page.key}
                    onClick={() => onPageChange(page.key)}
                    className="flex items-center gap-2 group"
                >
                    <motion.div
                        className="h-2 rounded-full bg-amber-400"
                        animate={{
                            width: activePage === page.key ? 24 : 8,
                            opacity: activePage === page.key ? 1 : 0.35,
                        }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                    />
                    <motion.span
                        className="text-[12px] font-medium"
                        animate={{
                            color: activePage === page.key ? "var(--color-text-primary)" : "var(--color-content-muted)",
                        }}
                        transition={{ duration: 0.2 }}
                    >
                        {page.label}
                    </motion.span>
                </button>
            ))}
        </div>
    );
};

const DictionaryView = () => {
    const [activePage, setActivePage] = useState<ActivePage>("dictionary");

    const [entries, setEntries] = useState<string[]>([]);
    const [newEntry, setNewEntry] = useState("");
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [editingValue, setEditingValue] = useState("");

    const [replacements, setReplacements] = useState<Replacement[]>([]);
    const [newFrom, setNewFrom] = useState("");
    const [newTo, setNewTo] = useState("");
    const [editingReplacementIndex, setEditingReplacementIndex] = useState<number | null>(null);
    const [editingFrom, setEditingFrom] = useState("");
    const [editingTo, setEditingTo] = useState("");

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [settings, setSettings] = useState<StoredSettings | null>(null);
    const [models, setModels] = useState<ModelInfo[]>([]);

    const searchQuery = newEntry.trim().toLowerCase();
    const filteredEntries = searchQuery
        ? entries.filter((entry) => entry.toLowerCase().includes(searchQuery))
        : entries;
    const isSearching = searchQuery.length > 0;

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [settingsResp, modelsResp, replacementsResp] = await Promise.all([
                invoke<StoredSettings>("get_settings"),
                invoke<ModelInfo[]>("list_models"),
                invoke<Replacement[]>("get_replacements"),
            ]);
            setSettings(settingsResp);
            setEntries(settingsResp.dictionary ?? []);
            setModels(modelsResp ?? []);
            setReplacements(replacementsResp ?? []);
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

    useEffect(() => {
        let unlistenSettings: UnlistenFn | null = null;

        listen<StoredSettings>("settings:changed", (event) => {
            const nextSettings = event.payload;
            if (!nextSettings) return;
            setSettings(nextSettings);
            setEntries(nextSettings.dictionary ?? []);
            setReplacements(nextSettings.replacements ?? []);
        }).then((fn) => {
            unlistenSettings = fn;
        });

        return () => {
            if (unlistenSettings) {
                unlistenSettings();
            }
        };
    }, []);

    const persistEntries = useCallback(async (next: string[]) => {
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
    }, []);

    const persistReplacements = useCallback(async (next: Replacement[]) => {
        setSaving(true);
        setError(null);
        try {
            const cleaned = await invoke<Replacement[]>("set_replacements", { replacements: next });
            setReplacements(cleaned);
            setEditingReplacementIndex(null);
            setEditingFrom("");
            setEditingTo("");
            setNewFrom("");
            setNewTo("");
        } catch (err) {
            console.error(err);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }, []);

    const handleAdd = async () => {
        const value = normalizeEntry(newEntry);
        if (!value) return;
        await persistEntries([...entries, value]);
    };

    const handleEditCommit = async () => {
        if (editingIndex === null) return;
        const value = normalizeEntry(editingValue);
        if (!value) {
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

    const handleAddReplacement = async () => {
        const from = normalizeEntry(newFrom);
        const to = normalizeEntry(newTo);
        if (!from) return;
        const exists = replacements.some((r) => r.from.toLowerCase() === from.toLowerCase());
        if (exists) return;
        await persistReplacements([...replacements, { from, to }]);
    };

    const handleEditReplacementCommit = async () => {
        if (editingReplacementIndex === null) return;
        const from = normalizeEntry(editingFrom);
        const to = normalizeEntry(editingTo);
        if (!from) {
            const next = replacements.filter((_, idx) => idx !== editingReplacementIndex);
            await persistReplacements(next);
            return;
        }
        const next = replacements.map((r, idx) =>
            idx === editingReplacementIndex ? { from, to } : r
        );
        await persistReplacements(next);
    };

    const handleDeleteReplacement = async (idx: number) => {
        const next = replacements.filter((_, i) => i !== idx);
        await persistReplacements(next);
    };

    const startEditingReplacement = (idx: number) => {
        setEditingReplacementIndex(idx);
        setEditingFrom(replacements[idx].from);
        setEditingTo(replacements[idx].to);
    };

    const currentModel = models.find((m) => m.key === settings?.local_model);
    const isLocal = settings?.transcription_mode === "local";
    const isWhisper =
        currentModel?.engine.toLowerCase().includes("whisper") ||
        currentModel?.variant.toLowerCase().includes("whisper");
    const showWarning = Boolean(isLocal && currentModel && !isWhisper);

    return (
        <div className="w-full text-left">
            <PageSwitcher activePage={activePage} onPageChange={setActivePage} />

            <AnimatePresence mode="wait">
                {activePage === "dictionary" && (
                    <motion.div
                        key="dictionary"
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -16 }}
                        transition={{ duration: 0.2 }}
                    >
                        <div className="flex items-start gap-3 mb-6">
                            <DotMatrix
                                rows={2}
                                cols={3}
                                activeDots={[0, 1, 2, 3]}
                                dotSize={3}
                                gap={3}
                                color="var(--color-cloud)"
                            />
                            <div>
                                <p className="text-3xl font-medium text-content-primary tracking-tight">
                                    Word Dictionary
                                </p>
                                <p className="text-[14px] text-content-secondary mt-1">
                                    Add custom words or phrases that arent in the default dictionary.
                                </p>
                            </div>
                        </div>

                        {showWarning && (
                            <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-100">
                                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                                <div className="text-[13px] leading-relaxed">
                                    Dictionary only locally works with Whisper models. Current model{" "}
                                    <span className="font-semibold">{currentModel?.label ?? settings?.local_model}</span>{" "}
                                    will ignore these entries until you switch to a Whisper option.
                                </div>
                            </div>
                        )}

                        <div className="rounded-xl border border-border-primary bg-surface-secondary">
                            <div className="flex items-center gap-2 border-b border-border-primary px-4 py-3">
                                <BookOpen size={16} className="text-content-primary" />
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
                                    className="flex-1 bg-transparent text-[14px] text-content-primary placeholder-content-disabled outline-none"
                                />
                                {isSearching && entries.length > 0 && (
                                    <span className="text-[12px] text-content-muted whitespace-nowrap">
                                        {filteredEntries.length} of {entries.length}
                                    </span>
                                )}
                                <button
                                    onClick={handleAdd}
                                    disabled={!newEntry.trim() || saving || entries.includes(newEntry.trim())}
                                    className="flex items-center gap-1 rounded-lg bg-surface-elevated px-3 py-1.5 text-[13px] text-content-primary hover:bg-surface-elevated-hover disabled:opacity-40 transition-colors"
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
                                            color="var(--color-content-muted)"
                                            animated
                                            className="opacity-60"
                                        />
                                    </div>
                                ) : filteredEntries.length === 0 ? (
                                    <div className="flex flex-col items-start gap-2 px-4 py-6 text-content-muted">
                                        {isSearching ? (
                                            <>
                                                <p className="text-[14px] font-medium">No matches found</p>
                                                <p className="text-[12px] text-content-muted">
                                                    Press Enter to add "{newEntry.trim()}" as a new entry.
                                                </p>
                                            </>
                                        ) : (
                                            <>
                                                <p className="text-[14px] font-medium">No entries yet</p>
                                                <p className="text-[12px] text-content-muted">
                                                    Add words, phrases or names that arent in the default dictionary.
                                                </p>
                                            </>
                                        )}
                                    </div>
                                ) : (
                                    <AnimatePresence mode="popLayout">
                                        {filteredEntries.map((entry) => {
                                            const originalIndex = entries.indexOf(entry);
                                            return (
                                                <motion.div
                                                    key={entry + originalIndex}
                                                    layout="position"
                                                    initial={{ opacity: 0 }}
                                                    animate={{ opacity: 1 }}
                                                    exit={{ opacity: 0 }}
                                                    transition={{ duration: 0.18, ease: "easeOut" }}
                                                    className="group flex items-center gap-3 border-b border-border-primary px-4 py-3 last:border-none"
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
                                                            onBlur={() => handleEditCommit()}
                                                            className="flex-1 rounded-md border border-border-primary bg-surface-tertiary px-2.5 py-1.5 text-[14px] text-content-primary outline-none focus:border-border-secondary"
                                                        />
                                                    ) : (
                                                        <button
                                                            onClick={() => startEditing(originalIndex)}
                                                            className="flex-1 text-left"
                                                        >
                                                            <p className="text-[14px] text-content-primary">{entry}</p>
                                                            <p className="text-[11px] text-content-muted opacity-0 transition-opacity group-hover:opacity-100">
                                                                Click to edit
                                                            </p>
                                                        </button>
                                                    )}

                                                    <div className="flex items-center gap-2">
                                                        {editingIndex === originalIndex ? (
                                                            <div className="text-[11px] text-content-muted">
                                                                Press Enter to save
                                                            </div>
                                                        ) : (
                                                            <button
                                                                onClick={() => startEditing(originalIndex)}
                                                                className="rounded-md bg-surface-overlay p-1.5 text-content-secondary opacity-0 transition-all group-hover:opacity-100 hover:bg-surface-elevated"
                                                                title="Edit"
                                                            >
                                                                <Edit3 size={14} />
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={() => handleDelete(originalIndex)}
                                                            className="rounded-md bg-surface-overlay p-1.5 text-error opacity-0 transition-all group-hover:opacity-100 hover:bg-surface-elevated"
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
                                <div className="border-t border-border-primary px-4 py-2 text-[12px] text-red-300">
                                    {error}
                                </div>
                            )}
                        </div>

                        <p className="mt-3 text-[11px] uppercase tracking-[0.14em] text-content-disabled">
                            {entries.length} {entries.length === 1 ? "entry" : "entries"}
                            {saving ? " · Saving..." : ""}
                        </p>
                    </motion.div>
                )}

                {activePage === "replacements" && (
                    <motion.div
                        key="replacements"
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -16 }}
                        transition={{ duration: 0.2 }}
                    >
                        <div className="flex items-start gap-3 mb-6">
                            <DotMatrix
                                rows={2}
                                cols={3}
                                activeDots={[1, 2, 4, 5]}
                                dotSize={3}
                                gap={3}
                                color="var(--color-accent)"
                            />
                            <div>
                                <p className="text-3xl font-medium text-content-primary tracking-tight">
                                    Direct Replacements
                                </p>
                                <p className="text-[14px] text-content-secondary mt-1">
                                    Automatically replace words in your transcriptions.
                                </p>
                            </div>
                        </div>

                        <div className="rounded-xl border border-border-primary bg-surface-secondary">
                            <div className="flex items-center gap-2 border-b border-border-primary px-4 py-3">
                                <Replace size={16} className="shrink-0" style={{ color: 'var(--color-accent)' }} />
                                <input
                                    value={newFrom}
                                    onChange={(e) => setNewFrom(e.target.value)}
                                    placeholder="Find word..."
                                    className="flex-1 min-w-0 bg-transparent text-[14px] text-content-primary placeholder-content-disabled outline-none"
                                />
                                <ArrowRight size={14} className="text-content-disabled shrink-0" />
                                <input
                                    value={newTo}
                                    onChange={(e) => setNewTo(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            handleAddReplacement();
                                        }
                                    }}
                                    placeholder="Replace with..."
                                    className="flex-1 min-w-0 bg-transparent text-[14px] text-content-primary placeholder-content-disabled outline-none"
                                />
                                <button
                                    onClick={handleAddReplacement}
                                    disabled={
                                        !newFrom.trim() ||
                                        saving ||
                                        replacements.some((r) => r.from.toLowerCase() === newFrom.trim().toLowerCase())
                                    }
                                    className="flex items-center gap-1 rounded-lg bg-surface-elevated px-3 py-1.5 text-[13px] text-content-primary hover:bg-surface-elevated-hover disabled:opacity-40 transition-colors shrink-0"
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
                                            color="var(--color-content-muted)"
                                            animated
                                            className="opacity-60"
                                        />
                                    </div>
                                ) : replacements.length === 0 ? (
                                    <div className="flex flex-col items-start gap-2 px-4 py-6 text-content-muted">
                                        <p className="text-[14px] font-medium">No replacements yet</p>
                                        <p className="text-[12px] text-content-muted">
                                            Add word pairs to automatically swap in transcriptions. Matches are case-insensitive.
                                        </p>
                                    </div>
                                ) : (
                                    <AnimatePresence mode="popLayout">
                                        {replacements.map((replacement, idx) => (
                                            <motion.div
                                                key={`${replacement.from}-${idx}`}
                                                layout="position"
                                                initial={{ opacity: 0 }}
                                                animate={{ opacity: 1 }}
                                                exit={{ opacity: 0 }}
                                                transition={{ duration: 0.18, ease: "easeOut" }}
                                                className="group flex items-center gap-3 border-b border-border-primary px-4 py-3 last:border-none"
                                            >
                                                {editingReplacementIndex === idx ? (
                                                    <div className="flex flex-1 items-center gap-2" data-replacement-edit>
                                                        <input
                                                            value={editingFrom}
                                                            onChange={(e) => setEditingFrom(e.target.value)}
                                                            autoFocus
                                                            onKeyDown={(e) => {
                                                                if (e.key === "Enter") {
                                                                    e.preventDefault();
                                                                    handleEditReplacementCommit();
                                                                }
                                                                if (e.key === "Escape") {
                                                                    setEditingReplacementIndex(null);
                                                                    setEditingFrom("");
                                                                    setEditingTo("");
                                                                }
                                                            }}
                                                            onBlur={(e) => {
                                                                const container = e.currentTarget.closest('[data-replacement-edit]');
                                                                if (!container?.contains(e.relatedTarget as Node)) {
                                                                    handleEditReplacementCommit();
                                                                }
                                                            }}
                                                            className="flex-1 min-w-0 rounded-md border border-border-primary bg-surface-tertiary px-2.5 py-1.5 text-[14px] text-content-primary outline-none focus:border-border-secondary"
                                                        />
                                                        <ArrowRight size={14} className="text-content-disabled shrink-0" />
                                                        <input
                                                            value={editingTo}
                                                            onChange={(e) => setEditingTo(e.target.value)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === "Enter") {
                                                                    e.preventDefault();
                                                                    handleEditReplacementCommit();
                                                                }
                                                                if (e.key === "Escape") {
                                                                    setEditingReplacementIndex(null);
                                                                    setEditingFrom("");
                                                                    setEditingTo("");
                                                                }
                                                            }}
                                                            onBlur={(e) => {
                                                                const container = e.currentTarget.closest('[data-replacement-edit]');
                                                                if (!container?.contains(e.relatedTarget as Node)) {
                                                                    handleEditReplacementCommit();
                                                                }
                                                            }}
                                                            className="flex-1 min-w-0 rounded-md border border-border-primary bg-surface-tertiary px-2.5 py-1.5 text-[14px] text-content-primary outline-none focus:border-border-secondary"
                                                        />
                                                    </div>
                                                ) : (
                                                    <button
                                                        onClick={() => startEditingReplacement(idx)}
                                                        className="flex flex-1 items-center gap-2 text-left"
                                                    >
                                                        <span className="text-[14px] text-content-primary">{replacement.from}</span>
                                                        <ArrowRight size={14} className="text-content-muted shrink-0" />
                                                        <span className="text-[14px]" style={{ color: 'var(--color-accent)' }}>
                                                            {replacement.to || <span className="text-content-muted italic">remove</span>}
                                                        </span>
                                                    </button>
                                                )}

                                                <div className="flex items-center gap-2">
                                                    {editingReplacementIndex === idx ? (
                                                        <div className="text-[11px] text-content-muted">
                                                            Press Enter to save
                                                        </div>
                                                    ) : (
                                                        <button
                                                            onClick={() => startEditingReplacement(idx)}
                                                            className="rounded-md bg-surface-overlay p-1.5 text-content-secondary opacity-0 transition-all group-hover:opacity-100 hover:bg-surface-elevated"
                                                            title="Edit"
                                                        >
                                                            <Edit3 size={14} />
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() => handleDeleteReplacement(idx)}
                                                        className="rounded-md bg-surface-overlay p-1.5 text-error opacity-0 transition-all group-hover:opacity-100 hover:bg-surface-elevated"
                                                        title="Delete"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            </motion.div>
                                        ))}
                                    </AnimatePresence>
                                )}
                            </div>

                            {error && (
                                <div className="border-t border-border-primary px-4 py-2 text-[12px] text-red-300">
                                    {error}
                                </div>
                            )}
                        </div>

                        <p className="mt-3 text-[11px] uppercase tracking-[0.14em] text-content-disabled">
                            {replacements.length} {replacements.length === 1 ? "replacement" : "replacements"}
                            {saving ? " · Saving..." : ""}
                        </p>
                    </motion.div>
                )}
            </AnimatePresence>

            <style>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 6px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: transparent;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: var(--color-scrollbar-thumb);
                    border-radius: 3px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: var(--color-scrollbar-thumb-hover);
                }
            `}</style>
        </div>
    );
};

export default DictionaryView;
