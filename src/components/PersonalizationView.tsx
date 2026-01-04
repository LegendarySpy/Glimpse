import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import DotMatrix from "./DotMatrix";
import { Dropdown } from "./Dropdown";

const normalizeEntry = (value: string) => value.trim();

const normalizeWebsite = (value: string) => {
    let trimmed = value.trim().toLowerCase();
    if (!trimmed) return "";
    trimmed = trimmed.replace(/^https?:\/\//, "");
    trimmed = trimmed.replace(/^www\./, "");
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex !== -1) {
        trimmed = trimmed.slice(0, slashIndex);
    }
    return trimmed;
};

const formatWebsitePreview = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return value;
    const dotIndex = trimmed.indexOf(".");
    if (dotIndex === -1) return trimmed;
    return trimmed.slice(0, dotIndex);
};

const isValidDomain = (value: string) => {
    const domain = value.trim().toLowerCase();
    if (!domain || domain.length > 253) return false;
    const labels = domain.split(".");
    if (labels.length < 2) return false;
    return labels.every((label) => {
        if (!label || label.length > 63) return false;
        if (label.startsWith("-") || label.endsWith("-")) return false;
        return /^[a-z0-9-]+$/.test(label);
    });
};

const createId = () => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `mode-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const getInitials = (value: string) => {
    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
};

type Personality = {
    id: string;
    name: string;
    enabled: boolean;
    apps: string[];
    websites: string[];
    instructions: string[];
};

type InstalledApp = {
    name: string;
    path: string;
};

type PersonalityModalProps = {
    personality: Personality;
    installedApps: InstalledApp[];
    onClose: () => void;
    onUpdate: (patch: Partial<Personality>) => void;
    onUpdateList: (updater: (current: Personality) => Personality) => void;
    onDelete: () => void;
};

const PersonalityModal = ({ personality, installedApps, onClose, onUpdate, onUpdateList, onDelete }: PersonalityModalProps) => {
    const nameInputRef = useRef<HTMLInputElement>(null);
    const [isEditingName, setIsEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState(personality.name);
    const [selectedAppOption, setSelectedAppOption] = useState<string | null>(null);
    const [websiteInput, setWebsiteInput] = useState("");
    const [websiteError, setWebsiteError] = useState<string | null>(null);
    const [instructionsText, setInstructionsText] = useState("");

    useEffect(() => {
        setNameDraft(personality.name);
        setIsEditingName(false);
        setSelectedAppOption(null);
        setWebsiteInput("");
        setWebsiteError(null);
        setInstructionsText(personality.instructions.join("\n"));
    }, [personality.id]);

    const commitName = () => {
        const value = normalizeEntry(nameDraft);
        if (!value) {
            setNameDraft(personality.name);
            return;
        }
        if (value !== personality.name) {
            onUpdate({ name: value });
        }
    };

    const installedNameSet = useMemo(() => {
        return new Set(installedApps.map((app) => app.name.toLowerCase()));
    }, [installedApps]);

    const appOptions = useMemo(() => {
        const seen = new Set<string>();
        return installedApps.filter((app) => {
            const key = app.name.toLowerCase();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }, [installedApps]);

    const appDropdownOptions = useMemo(() => {
        return appOptions.map((app) => ({
            value: app.name,
            label: app.name,
        }));
    }, [appOptions]);

    const addApp = (name: string) => {
        if (!name) return;
        onUpdateList((current) => {
            const exists = current.apps.some((app) => app.toLowerCase() === name.toLowerCase());
            if (exists) {
                return current;
            }
            return { ...current, apps: [...current.apps, name] };
        });
        setSelectedAppOption(null);
    };

    const removeApp = (name: string) => {
        onUpdateList((current) => ({
            ...current,
            apps: current.apps.filter((app) => app.toLowerCase() !== name.toLowerCase()),
        }));
    };

    const addWebsite = () => {
        const value = normalizeWebsite(websiteInput);
        if (!value) {
            setWebsiteError(null);
            return;
        }
        if (!isValidDomain(value)) {
            setWebsiteError("Enter a valid domain like gmail.com");
            return;
        }
        const exists = personality.websites.some((site) => site.toLowerCase() === value.toLowerCase());
        if (exists) {
            setWebsiteError("That domain is already added");
            return;
        }
        setWebsiteError(null);
        onUpdate({ websites: [...personality.websites, value] });
        setWebsiteInput("");
    };

    const removeWebsite = (site: string) => {
        onUpdate({ websites: personality.websites.filter((entry) => entry !== site) });
    };

    const parseInstructions = (value: string) => {
        const seen = new Set<string>();
        const lines = value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .filter((line) => {
                const key = line.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        return lines.slice(0, 64);
    };

    const handleInstructionsChange = (value: string) => {
        setInstructionsText(value);
        onUpdate({ instructions: parseInstructions(value) });
    };

    const handleSaveName = () => {
        commitName();
        setIsEditingName(false);
    };

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm"
                onClick={onClose}
            >
                <motion.div
                    initial={{ opacity: 0, scale: 0.96, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96, y: 20 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="relative w-[520px] h-[620px] max-w-[92vw] max-h-[92vh] bg-surface-overlay border border-border-secondary rounded-2xl shadow-2xl overflow-hidden flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center justify-between px-5 py-3 border-b border-border-primary">
                        <div className="flex items-center gap-3">
                            <DotMatrix
                                rows={2}
                                cols={3}
                                activeDots={[0, 2, 3]}
                                dotSize={3}
                                gap={3}
                                color="var(--color-cloud)"
                            />
                            <div className="group">
                                <p className="text-[12px] uppercase tracking-[0.18em] text-content-disabled">Personalization</p>
                                {isEditingName ? (
                                    <div className="flex items-center gap-2 h-[28px]">
                                        <input
                                            ref={nameInputRef}
                                            value={nameDraft}
                                            onChange={(event) => setNameDraft(event.target.value)}
                                            autoFocus
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") {
                                                    event.preventDefault();
                                                    handleSaveName();
                                                }
                                                if (event.key === "Escape") {
                                                    setNameDraft(personality.name);
                                                    setIsEditingName(false);
                                                }
                                            }}
                                            onBlur={handleSaveName}
                                            className="bg-surface-surface border border-border-primary rounded-lg px-2 py-0 text-[18px] font-semibold text-content-primary focus:border-border-hover outline-none h-full"
                                        />
                                        <button
                                            onClick={handleSaveName}
                                            className="h-[28px] w-[28px] flex items-center justify-center rounded hover:bg-border-secondary text-content-primary"
                                        >
                                            <Check size={14} />
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 h-[28px]">
                                        <h2 className="text-[18px] font-semibold text-content-primary">{personality.name}</h2>
                                        <button
                                            onClick={() => setIsEditingName(true)}
                                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-content-muted hover:text-content-secondary"
                                        >
                                            <Pencil size={12} />
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={onDelete}
                                className="p-2 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
                                title="Delete mode"
                            >
                                <Trash2 size={14} />
                            </button>
                            <button
                                onClick={onClose}
                                className="p-2 rounded-lg hover:bg-surface-elevated text-content-muted hover:text-content-primary transition-colors"
                            >
                                <X size={16} />
                            </button>
                        </div>
                    </div>

                    <div className="flex flex-col gap-4 p-4 flex-1 min-h-0">
                        <section className="space-y-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Custom instructions</p>
                            <div className="rounded-xl border border-border-primary bg-surface-surface p-3">
                                <textarea
                                    value={instructionsText}
                                    onChange={(event) => handleInstructionsChange(event.target.value)}
                                    placeholder="Add custom instructions"
                                    className="w-full h-20 resize-none bg-transparent text-[11px] leading-[20px] font-mono text-content-primary placeholder-content-disabled outline-none custom-scrollbar"
                                />
                            </div>
                        </section>

                        <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
                            <section className="space-y-2 flex flex-col min-h-0">
                                <div className="flex items-center justify-between">
                                    <p className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Applications</p>
                                    <span className="text-[10px] text-content-disabled">{personality.apps.length} selected</span>
                                </div>
                                <Dropdown
                                    value={selectedAppOption}
                                    onChange={(value) => {
                                        setSelectedAppOption(value);
                                        addApp(value);
                                    }}
                                    options={appDropdownOptions}
                                    placeholder="Add application"
                                    searchable
                                    searchPlaceholder="Search applications..."
                                    menuClassName="max-h-[220px]"
                                />
                                <div className="space-y-2 flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                                    {personality.apps.length === 0 ? (
                                        <div className="rounded-lg border border-border-primary bg-surface-surface px-3 py-3 text-[11px] text-content-muted">
                                            No applications selected
                                        </div>
                                    ) : (
                                        personality.apps.map((app) => {
                                            const isMissing = !installedNameSet.has(app.toLowerCase());
                                            return (
                                                <div
                                                    key={app}
                                                    className="flex items-center justify-between rounded-lg border border-border-primary bg-surface-surface px-3 py-2"
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={3} gap={2} color="var(--color-border-hover)" />
                                                        <span className="text-[12px] text-content-primary">{app}</span>
                                                        {isMissing && (
                                                            <span className="text-[10px] text-content-disabled">Not installed</span>
                                                        )}
                                                    </div>
                                                    <button
                                                        onClick={() => removeApp(app)}
                                                        className="rounded-md p-1.5 text-content-muted hover:text-content-primary hover:bg-surface-elevated transition-colors"
                                                        title="Remove"
                                                    >
                                                        <X size={12} />
                                                    </button>
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                            </section>

                            <section className="space-y-2 flex flex-col min-h-0">
                                <div className="flex items-center justify-between">
                                    <p className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Websites</p>
                                    <span className="text-[10px] text-content-disabled">{personality.websites.length} sites</span>
                                </div>
                                <div className="flex items-center gap-2 rounded-lg border border-border-primary bg-surface-surface px-3 py-1.5 min-h-[40px] focus-within:border-border-hover transition-colors">
                                    <input
                                        value={websiteInput}
                                        onChange={(event) => {
                                            setWebsiteInput(event.target.value);
                                            if (websiteError) {
                                                setWebsiteError(null);
                                            }
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                                event.preventDefault();
                                                addWebsite();
                                            }
                                        }}
                                        placeholder="Add a site like gmail.com"
                                        className="bg-transparent text-[12px] text-content-primary placeholder-content-disabled outline-none flex-1"
                                    />
                                    <button
                                        onClick={addWebsite}
                                        className="flex items-center gap-1 rounded-md bg-surface-elevated px-2 py-0.5 text-[11px] text-content-primary hover:bg-surface-elevated-hover transition-colors"
                                    >
                                        <Plus size={12} />
                                        Add
                                    </button>
                                </div>
                                {websiteError && (
                                    <p className="text-[10px] text-error">{websiteError}</p>
                                )}
                                <div className="space-y-2 flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                                    {personality.websites.length === 0 ? (
                                        <div className="rounded-lg border border-border-primary bg-surface-surface px-3 py-3 text-[11px] text-content-muted">
                                            No websites added
                                        </div>
                                    ) : (
                                        personality.websites.map((site) => (
                                            <div
                                                key={site}
                                                className="flex items-center justify-between rounded-lg border border-border-primary bg-surface-surface px-3 py-2"
                                            >
                                                <div className="flex items-center gap-2">
                                                    <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={3} gap={2} color="var(--color-border-hover)" />
                                                    <span className="text-[11px] font-mono text-content-primary">{site}</span>
                                                </div>
                                                <button
                                                    onClick={() => removeWebsite(site)}
                                                    className="rounded-md p-1.5 text-content-muted hover:text-content-primary hover:bg-surface-elevated transition-colors"
                                                    title="Remove"
                                                >
                                                    <X size={12} />
                                                </button>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </section>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
};

const PersonalizationView = () => {
    const [personalities, setPersonalities] = useState<Personality[]>([]);
    const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activePersonalityId, setActivePersonalityId] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [personalityResp, appsResp] = await Promise.all([
                invoke<Personality[]>("get_personalities"),
                invoke<InstalledApp[]>("list_installed_apps"),
            ]);
            setPersonalities(personalityResp ?? []);
            setInstalledApps(appsResp ?? []);
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

    const persistPersonalities = useCallback(async (next: Personality[]) => {
        setError(null);
        try {
            const cleaned = await invoke<Personality[]>("set_personalities", { personalities: next });
            setPersonalities(cleaned ?? next);
        } catch (err) {
            console.error(err);
            setError(err instanceof Error ? err.message : String(err));
        }
    }, []);

    const updatePersonalities = useCallback(
        (updater: (prev: Personality[]) => Personality[]) => {
            setPersonalities((prev) => {
                const next = updater(prev);
                void persistPersonalities(next);
                return next;
            });
        },
        [persistPersonalities]
    );

    const updatePersonality = useCallback(
        (id: string, patch: Partial<Personality>) => {
            updatePersonalities((prev) =>
                prev.map((personality) =>
                    personality.id === id ? { ...personality, ...patch } : personality
                )
            );
        },
        [updatePersonalities]
    );

    const updatePersonalityList = useCallback(
        (id: string, updater: (current: Personality) => Personality) => {
            updatePersonalities((prev) =>
                prev.map((personality) => (personality.id === id ? updater(personality) : personality))
            );
        },
        [updatePersonalities]
    );

    const handleAddMode = () => {
        const id = createId();
        const nextMode: Personality = {
            id,
            name: "New Mode",
            enabled: true,
            apps: [],
            websites: [],
            instructions: [],
        };
        updatePersonalities((prev) => [...prev, nextMode]);
        setActivePersonalityId(id);
    };

    const handleDeleteMode = (id: string) => {
        updatePersonalities((prev) => prev.filter((mode) => mode.id !== id));
        setActivePersonalityId(null);
    };

    const activePersonality = useMemo(() => {
        return personalities.find((personality) => personality.id === activePersonalityId) || null;
    }, [personalities, activePersonalityId]);

    useEffect(() => {
        if (activePersonalityId && !activePersonality) {
            setActivePersonalityId(null);
        }
    }, [activePersonalityId, activePersonality]);

    return (
        <div className="w-full text-left">
            <div className="flex items-start gap-3 mb-4">
                <DotMatrix
                    rows={2}
                    cols={3}
                    activeDots={[0, 1, 3, 4]}
                    dotSize={3}
                    gap={3}
                    color="var(--color-accent)"
                />
                <div className="flex-1">
                    <p className="text-2xl font-medium text-content-primary tracking-tight">Personalization</p>
                    <div className="mt-1 flex items-center justify-between gap-4">
                        <p className="text-[12px] text-content-secondary">
                            Tailor modes to apps, sites, and custom instructions.
                        </p>
                        <button
                            onClick={handleAddMode}
                            aria-label="New mode"
                            title="New mode"
                            className="flex items-center gap-2 rounded-lg border border-border-primary bg-surface-surface px-2.5 py-1.5 text-[11px] font-medium text-content-primary hover:bg-surface-elevated transition-colors"
                        >
                            <Plus size={12} />
                            New mode
                        </button>
                    </div>
                </div>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-12">
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
            ) : personalities.length === 0 ? (
                <div className="rounded-xl border border-border-primary bg-surface-secondary px-6 py-8 text-content-muted">
                    <p className="text-[14px] font-medium">No modes yet</p>
                    <p className="text-[12px] text-content-muted">
                        Create a mode to start customizing your apps and websites.
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                    {personalities.map((personality) => {
                        const appsPreview = personality.apps.slice(0, 3);
                        const sitesPreview = personality.websites.slice(0, 2);
                        const moreApps = Math.max(0, personality.apps.length - appsPreview.length);
                        const moreSites = Math.max(0, personality.websites.length - sitesPreview.length);
                        return (
                            <button
                                key={personality.id}
                                onClick={() => setActivePersonalityId(personality.id)}
                                className="group relative rounded-xl border border-border-primary bg-surface-secondary p-2.5 text-left transition-colors hover:bg-surface-tertiary"
                            >
                                <div className="absolute inset-0 pointer-events-none opacity-10">
                                    <DotMatrix rows={6} cols={18} activeDots={[0, 4, 7, 9, 12, 18, 22, 25, 31, 35, 40, 44, 50, 55, 60, 66]} dotSize={2} gap={4} color="var(--color-border-primary)" />
                                </div>
                                <div className="relative space-y-2">
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <p className="text-[14px] font-medium text-content-primary">{personality.name}</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    setActivePersonalityId(personality.id);
                                                }}
                                                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-content-muted hover:text-content-secondary"
                                                aria-label="Edit mode"
                                                title="Edit mode"
                                            >
                                                <Pencil size={12} />
                                            </button>
                                            <button
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    updatePersonality(personality.id, { enabled: !personality.enabled });
                                                }}
                                                aria-label={personality.enabled ? "Disable mode" : "Enable mode"}
                                                className={`relative h-4 w-7 rounded-full transition-colors ${personality.enabled
                                                    ? "bg-cloud"
                                                    : "bg-border-secondary"
                                                    }`}
                                            >
                                                <motion.div
                                                    className="absolute top-[2px] h-3 w-3 rounded-full bg-white shadow-sm"
                                                    animate={{ left: personality.enabled ? "calc(100% - 14px)" : "2px" }}
                                                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                                                />
                                            </button>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-2">
                                        <div>
                                            <p className="text-[9px] uppercase tracking-wider text-content-disabled">Apps</p>
                                            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                                                {appsPreview.length === 0 ? (
                                                    <span className="text-[10px] text-content-disabled">No apps yet</span>
                                                ) : (
                                                    appsPreview.map((app) => (
                                                        <div
                                                            key={app}
                                                            title={app}
                                                            className="h-7 w-7 rounded-lg border border-border-secondary bg-surface-overlay flex items-center justify-center text-[9px] text-content-secondary"
                                                        >
                                                            {getInitials(app)}
                                                        </div>
                                                    ))
                                                )}
                                                {moreApps > 0 && (
                                                    <span className="text-[10px] font-mono text-content-muted">+{moreApps}</span>
                                                )}
                                            </div>
                                        </div>

                                        <div>
                                            <p className="text-[9px] uppercase tracking-wider text-content-disabled">Websites</p>
                                            <div className="mt-1.5 flex items-center gap-1.5 min-w-0 flex-nowrap">
                                                {sitesPreview.length === 0 ? (
                                                    <span className="text-[10px] text-content-disabled">No sites yet</span>
                                                ) : (
                                                    sitesPreview.map((site) => (
                                                            <span
                                                                key={site}
                                                                className="min-w-0 max-w-[110px] truncate rounded-md border border-border-primary bg-surface-overlay px-2.5 py-1 text-[9px] font-mono text-content-secondary"
                                                            >
                                                                {formatWebsitePreview(site)}
                                                            </span>

                                                    ))
                                                )}
                                                {moreSites > 0 && (
                                                    <span className="shrink-0 text-[10px] font-mono text-content-muted">+{moreSites}</span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="mt-2 pt-2 border-t border-border-primary text-[10px] text-content-muted flex items-center gap-2 min-w-0">
                                        <span className="text-[9px] uppercase tracking-wider text-content-disabled">Notes:</span>
                                        <span className="font-mono truncate flex-1">
                                            {personality.instructions.length > 0 ? personality.instructions[0] : "No notes yet"}
                                        </span>
                                    </div>
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}

            {error && (
                <div className="mt-4 text-[12px] text-red-300">
                    {error}
                </div>
            )}

            {activePersonality && (
                <PersonalityModal
                    personality={activePersonality}
                    installedApps={installedApps}
                    onClose={() => setActivePersonalityId(null)}
                    onUpdate={(patch) => updatePersonality(activePersonality.id, patch)}
                    onUpdateList={(updater) => updatePersonalityList(activePersonality.id, updater)}
                    onDelete={() => handleDeleteMode(activePersonality.id)}
                />
            )}

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

export default PersonalizationView;
