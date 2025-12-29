import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

interface WhatsNewModalProps {
    isOpen: boolean;
    onClose: () => void;
}

interface ReleaseInfo {
    version: string;
    body: string;
    publishedAt: string;
    htmlUrl: string;
}

const GITHUB_API_URL = "https://api.github.com/repos/LegendarySpy/Glimpse/releases";
const MAX_RELEASES = 10;

const isFeatureRelease = (version: string): boolean => {
    const match = version.match(/v?(\d+)\.(\d+)\.(\d+)/);
    if (!match) return false;
    const patch = parseInt(match[3], 10);
    return patch === 0;
};

export function WhatsNewModal({ isOpen, onClose }: WhatsNewModalProps) {
    const [releases, setReleases] = useState<ReleaseInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen && releases.length === 0) {
            fetchReleases();
        }
    }, [isOpen]);

    const fetchReleases = async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`${GITHUB_API_URL}?per_page=${MAX_RELEASES}`, {
                method: "GET",
                headers: {
                    "Accept": "application/vnd.github.v3+json",
                    "User-Agent": "Glimpse-App"
                }
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch: ${response.status}`);
            }
            const data = await response.json() as Array<{
                tag_name: string;
                body: string;
                published_at: string;
                html_url: string;
            }>;
            setReleases(data.map(release => ({
                version: release.tag_name,
                body: release.body || "No changelog available.",
                publishedAt: release.published_at,
                htmlUrl: release.html_url,
            })));
        } catch (err) {
            console.error("Failed to fetch releases:", err);
            setError(err instanceof Error ? err.message : "Failed to load changelog");
        } finally {
            setLoading(false);
        }
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        return date.toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric"
        });
    };

    const renderMarkdown = (text: string) => {
        const lines = text.split("\n");
        const elements: React.ReactElement[] = [];
        let listItems: string[] = [];

        const flushList = () => {
            if (listItems.length > 0) {
                elements.push(
                    <ul key={`list-${elements.length}`} className="space-y-2.5 mb-4 ml-1">
                        {listItems.map((item, i) => (
                            <li key={i} className="flex items-start gap-3 text-[13px] leading-relaxed text-content-secondary">
                                <span className="text-amber-400 mt-1 text-[10px]">●</span>
                                <span>{item}</span>
                            </li>
                        ))}
                    </ul>
                );
                listItems = [];
            }
        };

        lines.forEach((line, index) => {
            const trimmed = line.trim();
            if (!trimmed) {
                flushList();
                return;
            }

            if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
                listItems.push(trimmed.slice(2));
                return;
            }

            flushList();

            if (trimmed.startsWith("### ")) {
                elements.push(
                    <h4 key={index} className="text-[12px] font-semibold text-content-muted uppercase tracking-wider mt-5 mb-2">
                        {trimmed.slice(4)}
                    </h4>
                );
            } else if (trimmed.startsWith("## ")) {
                elements.push(
                    <h3 key={index} className="text-[14px] font-medium text-content-primary mt-5 mb-2">
                        {trimmed.slice(3)}
                    </h3>
                );
            } else if (trimmed.startsWith("# ")) {
                elements.push(
                    <h2 key={index} className="text-[15px] font-semibold text-content-primary mt-5 mb-2">
                        {trimmed.slice(2)}
                    </h2>
                );
            } else if (trimmed.match(/^\*\*(.+):\*\*$/)) {
                const match = trimmed.match(/^\*\*(.+):\*\*$/);
                elements.push(
                    <p key={index} className="text-[13px] font-semibold text-amber-400 mt-5 mb-2">
                        {match?.[1]}
                    </p>
                );
            } else if (trimmed.match(/^(.+):$/)) {
                const match = trimmed.match(/^(.+):$/);
                elements.push(
                    <p key={index} className="text-[13px] font-semibold text-amber-400/90 mt-5 mb-2">
                        {match?.[1]}
                    </p>
                );
            } else if (!trimmed.startsWith("<!--") && !trimmed.startsWith("**Full Changelog**")) {
                elements.push(
                    <p key={index} className="text-[13px] leading-relaxed text-content-secondary mb-3">
                        {trimmed}
                    </p>
                );
            }
        });

        flushList();
        return elements;
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 10 }}
                        transition={{ type: "spring", stiffness: 400, damping: 30 }}
                        onClick={(e) => e.stopPropagation()}
                        className="relative w-full max-w-md max-h-[70vh] bg-surface-secondary border border-border-primary rounded-2xl shadow-2xl overflow-hidden"
                    >
                        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 bg-surface-secondary backdrop-blur-sm border-b border-border-primary">
                            <h2 className="text-[15px] font-semibold text-content-primary">What's New</h2>
                            <button
                                onClick={onClose}
                                className="p-1.5 rounded-lg text-content-muted hover:text-content-primary hover:bg-surface-elevated transition-colors"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        <div className="px-5 py-5 overflow-y-auto settings-scroll" style={{ maxHeight: 'calc(70vh - 140px)' }}>
                            {(loading || releases.length === 0) && !error && (
                                <div className="flex items-center justify-center py-8">
                                    <Loader2 size={20} className="animate-spin text-content-muted" />
                                </div>
                            )}

                            {error && (
                                <div className="flex flex-col items-center gap-3 py-6">
                                    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 w-full">
                                        <AlertCircle size={14} className="text-red-400 shrink-0" />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[13px] text-red-400 font-medium">Couldn't load releases</p>
                                            <p className="text-[11px] text-red-400/70 mt-0.5">GitHub may be temporarily unavailable. Check your connection and try again.</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={fetchReleases}
                                        className="text-[12px] font-medium text-content-secondary hover:text-content-primary transition-colors"
                                    >
                                        Retry
                                    </button>
                                </div>
                            )}

                            {!loading && !error && releases.length > 0 && (
                                <div className="space-y-6">
                                    {releases.map((release, index) => {
                                        const isFeatured = isFeatureRelease(release.version);
                                        return (
                                            <div key={release.version} className={isFeatured ? "pl-3 border-l-2 border-amber-400" : ""}>
                                                <div className="flex items-center justify-between mb-3">
                                                    <h3 className={`font-semibold ${isFeatured ? "text-[15px] text-amber-400" : "text-[14px] text-content-primary"}`}>
                                                        {release.version}
                                                    </h3>
                                                    <span className="text-[11px] text-content-muted">
                                                        {formatDate(release.publishedAt)}
                                                    </span>
                                                </div>
                                                <div className="pb-2">
                                                    {renderMarkdown(release.body)}
                                                </div>
                                                {index < releases.length - 1 && (
                                                    <div className={`border-t border-border-primary mt-4 ${isFeatured ? "-ml-3" : ""}`} />
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {releases.length > 0 && (
                            <div className="sticky bottom-0 px-5 py-3 bg-surface-secondary backdrop-blur-sm border-t border-border-primary">
                                <button
                                    onClick={() => openUrl("https://github.com/LegendarySpy/Glimpse/releases")}
                                    className="flex items-center justify-center gap-1.5 w-full py-2 px-3 rounded-lg bg-surface-elevated border border-border-secondary text-[11px] font-medium text-content-secondary hover:text-content-primary hover:border-border-hover transition-colors"
                                >
                                    <ExternalLink size={12} />
                                    View all releases on GitHub
                                </button>
                            </div>
                        )}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

export default WhatsNewModal;
