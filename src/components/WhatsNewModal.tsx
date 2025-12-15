import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

interface WhatsNewModalProps {
    isOpen: boolean;
    onClose: () => void;
    version?: string;
}

interface ReleaseInfo {
    version: string;
    body: string;
    publishedAt: string;
    htmlUrl: string;
}

const GITHUB_API_URL = "https://api.github.com/repos/LegendarySpy/Glimpse/releases/latest";

export function WhatsNewModal({ isOpen, onClose, version }: WhatsNewModalProps) {
    const [release, setRelease] = useState<ReleaseInfo | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen && !release) {
            fetchRelease();
        }
    }, [isOpen]);

    const fetchRelease = async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(GITHUB_API_URL, {
                method: "GET",
                headers: {
                    "Accept": "application/vnd.github.v3+json",
                    "User-Agent": "Glimpse-App"
                }
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch: ${response.status}`);
            }
            const data = await response.json() as {
                tag_name: string;
                body: string;
                published_at: string;
                html_url: string;
            };
            setRelease({
                version: data.tag_name,
                body: data.body || "No changelog available.",
                publishedAt: data.published_at,
                htmlUrl: data.html_url,
            });
        } catch (err) {
            console.error("Failed to fetch release:", err);
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
                            <li key={i} className="flex items-start gap-3 text-[13px] leading-relaxed text-[#c8c8cc]">
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
                    <h4 key={index} className="text-[12px] font-semibold text-[#8b8b96] uppercase tracking-wider mt-5 mb-2">
                        {trimmed.slice(4)}
                    </h4>
                );
            } else if (trimmed.startsWith("## ")) {
                elements.push(
                    <h3 key={index} className="text-[14px] font-medium text-[#e8e8eb] mt-5 mb-2">
                        {trimmed.slice(3)}
                    </h3>
                );
            } else if (trimmed.startsWith("# ")) {
                elements.push(
                    <h2 key={index} className="text-[15px] font-semibold text-[#e8e8eb] mt-5 mb-2">
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
                    <p key={index} className="text-[13px] leading-relaxed text-[#c8c8cc] mb-3">
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
                        className="relative w-full max-w-md max-h-[70vh] bg-[#0a0a0c] border border-[#1e1e22] rounded-2xl shadow-2xl overflow-hidden"
                    >
                        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 bg-[#0a0a0c]/95 backdrop-blur-sm border-b border-[#1e1e22]">
                            <div>
                                <h2 className="text-[15px] font-semibold text-[#e8e8eb]">What's New</h2>
                                {release && (
                                    <p className="text-[11px] text-[#6b6b76] mt-0.5">
                                        {version || release.version} • {formatDate(release.publishedAt)}
                                    </p>
                                )}
                            </div>
                            <button
                                onClick={onClose}
                                className="p-1.5 rounded-lg text-[#6b6b76] hover:text-[#e8e8eb] hover:bg-[#1a1a1e] transition-colors"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        <div className="px-5 py-5 overflow-y-auto settings-scroll" style={{ maxHeight: 'calc(70vh - 140px)' }}>
                            {(loading || !release) && !error && (
                                <div className="flex items-center justify-center py-8">
                                    <Loader2 size={20} className="animate-spin text-[#6b6b76]" />
                                </div>
                            )}

                            {error && (
                                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                                    <AlertCircle size={14} className="text-red-400 shrink-0" />
                                    <p className="text-[13px] text-red-400">{error}</p>
                                </div>
                            )}

                            {!loading && !error && release && (
                                <div className="pb-4">
                                    {renderMarkdown(release.body)}
                                </div>
                            )}
                        </div>

                        {release && (
                            <div className="sticky bottom-0 px-5 py-3 bg-[#0a0a0c]/95 backdrop-blur-sm border-t border-[#1e1e22]">
                                <button
                                    onClick={() => openUrl(release.htmlUrl)}
                                    className="flex items-center justify-center gap-1.5 w-full py-2 px-3 rounded-lg bg-[#1a1a1e] border border-[#2a2a30] text-[11px] font-medium text-[#a0a0ab] hover:text-[#e8e8eb] hover:border-[#3a3a45] transition-colors"
                                >
                                    <ExternalLink size={12} />
                                    View on GitHub
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
