import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { motion, AnimatePresence } from "framer-motion";
import {
    Lock,
    Loader2,
    Check,
    Monitor,
    Smartphone,
    LogOut,
    AlertCircle,
    CloudCog,
    Pencil,
    Eye,
    EyeOff,
    X,
    Cloud,
    CreditCard,
    Copy,
    Activity
} from "lucide-react";
import type { Models } from "appwrite";
import {
    updateName,
    updatePassword,
    listSessions,
    deleteSessionById,
    logoutAll,
    type User as AppwriteUser
} from "../lib/auth";
import DotMatrix from "./DotMatrix";

interface AccountViewProps {
    currentUser: AppwriteUser | null;
    cloudSyncEnabled: boolean;
    onCloudSyncToggle: () => void;
    onUserUpdate: () => void;
    onSignOut: () => void;
}

const AccountView = ({
    currentUser,
    cloudSyncEnabled,
    onCloudSyncToggle,
    onUserUpdate,
    onSignOut
}: AccountViewProps) => {
    const [isEditingName, setIsEditingName] = useState(false);
    const [editName, setEditName] = useState(currentUser?.name || "");
    const [nameLoading, setNameLoading] = useState(false);

    const [showPasswordModal, setShowPasswordModal] = useState(false);
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [passwordLoading, setPasswordLoading] = useState(false);
    const [passwordError, setPasswordError] = useState<string | null>(null);
    const [passwordErrorCopied, setPasswordErrorCopied] = useState(false);
    const [passwordSuccess, setPasswordSuccess] = useState(false);
    const [showCurrentPassword, setShowCurrentPassword] = useState(false);
    const [showNewPassword, setShowNewPassword] = useState(false);

    const [sessions, setSessions] = useState<Models.Session[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [deletingSession, setDeletingSession] = useState<string | null>(null);

    type UsageStats = {
        cloud_minutes_this_month: number;
        cloud_hours_lifetime: number;
        cloud_transcriptions_count: number;
        cloud_transcriptions_this_month: number;
    };
    const [usageStats, setUsageStats] = useState<UsageStats | null>(null);

    useEffect(() => {
        if (currentUser) {
            loadSessions();
            loadUsageStats();
        }
    }, [currentUser]);

    useEffect(() => {
        setEditName(currentUser?.name || "");
    }, [currentUser?.name]);

    const loadUsageStats = async () => {
        try {
            const stats = await invoke<UsageStats>("get_usage_stats");
            setUsageStats(stats);
        } catch (err) {
            console.error("Failed to load usage stats:", err);
        }
    };

    const loadSessions = async () => {
        setSessionsLoading(true);
        try {
            const result = await listSessions();
            setSessions(result.sessions);
        } catch (err) {
            console.error("Failed to load sessions:", err);
        } finally {
            setSessionsLoading(false);
        }
    };

    const handleSaveName = async () => {
        if (!editName.trim() || editName === currentUser?.name) {
            setIsEditingName(false);
            return;
        }
        setNameLoading(true);
        try {
            await updateName(editName.trim());
            onUserUpdate();
            setIsEditingName(false);
        } catch (err) {
            console.error("Failed to update name:", err);
        } finally {
            setNameLoading(false);
        }
    };

    const handlePasswordChange = async (e: React.FormEvent) => {
        e.preventDefault();
        setPasswordError(null);
        setPasswordSuccess(false);

        if (newPassword !== confirmPassword) {
            setPasswordError("Passwords don't match");
            return;
        }
        if (newPassword.length < 8) {
            setPasswordError("Password must be at least 8 characters");
            return;
        }

        setPasswordLoading(true);
        try {
            await updatePassword(newPassword, currentPassword);
            setPasswordSuccess(true);
            setTimeout(() => {
                closePasswordModal();
            }, 1500);
        } catch (err) {
            setPasswordError(err instanceof Error ? err.message : "Failed to update password");
        } finally {
            setPasswordLoading(false);
        }
    };

    const closePasswordModal = () => {
        setShowPasswordModal(false);
        setPasswordError(null);
        setPasswordSuccess(false);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setShowCurrentPassword(false);
        setShowNewPassword(false);
    };

    const handleDeleteSession = async (sessionId: string) => {
        setDeletingSession(sessionId);
        try {
            await deleteSessionById(sessionId);
            setSessions(prev => prev.filter(s => s.$id !== sessionId));
        } catch (err) {
            console.error("Failed to delete session:", err);
        } finally {
            setDeletingSession(null);
        }
    };

    const handleSignOutAll = async () => {
        try {
            await logoutAll();
            onSignOut();
        } catch (err) {
            console.error("Failed to sign out all:", err);
        }
    };

    if (!currentUser) return null;

    const isSubscriber = currentUser.labels?.includes("subscriber");

    return (
        <div className="max-w-2xl mx-auto space-y-8 pb-10">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <div className="relative">
                        <div className="h-16 w-16 rounded-full bg-gradient-to-tr from-[#2a2a35] to-[#1a1a20] flex items-center justify-center border border-border-secondary shadow-lg overflow-hidden">
                            <span className="text-xl font-medium text-content-primary">
                                {currentUser.name?.[0]?.toUpperCase() || currentUser.email?.[0]?.toUpperCase() || "?"}
                            </span>
                        </div>
                        {isSubscriber && (
                            <div className="absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-surface-primary flex items-center justify-center p-0.5">
                                <div className="h-full w-full rounded-full bg-amber-400 flex items-center justify-center text-black">
                                    <Cloud size={10} strokeWidth={3} />
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="group">
                        <div className="flex items-center gap-2">
                            {isEditingName ? (
                                <div className="flex items-center gap-2 h-[28px]">
                                    <input
                                        type="text"
                                        value={editName}
                                        onChange={(e) => setEditName(e.target.value)}
                                        autoFocus
                                        className="bg-surface-elevated border border-border-secondary rounded px-2 py-0 text-[18px] font-medium text-white focus:border-amber-400/50 outline-none w-48 h-full"
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") handleSaveName();
                                            if (e.key === "Escape") {
                                                setEditName(currentUser.name || "");
                                                setIsEditingName(false);
                                            }
                                        }}
                                    />
                                    <button
                                        onClick={handleSaveName}
                                        disabled={nameLoading}
                                        className="h-[28px] w-[28px] flex items-center justify-center rounded hover:bg-border-secondary text-amber-400"
                                    >
                                        <Check size={16} />
                                    </button>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 h-[28px]">
                                    <h1 className="text-[18px] font-medium text-white">
                                        {currentUser.name || "Glimpse User"}
                                    </h1>
                                    <button
                                        onClick={() => setIsEditingName(true)}
                                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-content-muted hover:text-content-secondary"
                                    >
                                        <Pencil size={12} />
                                    </button>
                                </div>
                            )}
                        </div>
                        <p className="text-[13px] text-content-muted mb-1.5">{currentUser.email}</p>
                        <button
                            onClick={() => setShowPasswordModal(true)}
                            className="flex items-center gap-1.5 text-[11px] text-content-disabled hover:text-content-primary transition-colors group/pass"
                        >
                            <Lock size={10} />
                            <span className="font-mono">••••••••</span>
                            <Pencil size={10} className="opacity-0 group-hover/pass:opacity-100 transition-opacity" />
                        </button>
                    </div>
                </div>
                <button
                    onClick={onSignOut}
                    className="flex items-center gap-2 text-[12px] text-content-muted hover:text-content-primary transition-colors"
                >
                    <LogOut size={14} />
                    Sign out
                </button>
            </div>

            <div className="space-y-3">
                <h3 className="text-[11px] uppercase tracking-wider font-semibold text-content-disabled pl-1">Account Settings</h3>
                <div className="bg-surface-tertiary border border-border-primary rounded-xl overflow-hidden divide-y divide-surface-elevated">
                    <div className="flex items-center justify-between p-4 hover:bg-surface-surface transition-colors group">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-surface-elevated text-content-secondary">
                                <CreditCard size={16} />
                            </div>
                            <div>
                                <div className="text-[13px] text-content-primary font-medium">Subscription</div>
                                <div className="text-[11px] text-content-muted">
                                    {isSubscriber ? "Active Pro Plan" : "Free Plan"}
                                </div>
                            </div>
                        </div>
                        {isSubscriber ? (
                            <button
                                onClick={() => openUrl("https://glimpse-app.lemonsqueezy.com/billing")}
                                className="text-[11px] font-medium text-amber-400 hover:text-amber-300 transition-colors"
                            >
                                Manage
                            </button>
                        ) : (
                            <button
                                onClick={() => openUrl("https://glimpse-app.lemonsqueezy.com/buy/16bdbd7d-2aa4-4c4e-a101-482386083ea7")}
                                className="px-3 py-1.5 rounded-lg bg-amber-400/10 border border-amber-400/20 text-[11px] font-medium text-amber-400 hover:bg-amber-400/20 transition-colors"
                            >
                                Upgrade
                            </button>
                        )}
                    </div>

                    <div className="flex items-center justify-between p-4 hover:bg-surface-surface transition-colors">
                        <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg ${isSubscriber ? "bg-surface-elevated text-content-secondary" : "bg-surface-elevated text-content-disabled"}`}>
                                <CloudCog size={16} />
                            </div>
                            <div>
                                <div className={`text-[13px] font-medium ${isSubscriber ? "text-content-primary" : "text-content-muted"}`}>History Sync</div>
                                <div className="text-[11px] text-content-muted">
                                    {isSubscriber ? "Sync transcriptions across devices" : "Cloud feature"}
                                </div>
                            </div>
                        </div>
                        {isSubscriber ? (
                            <button
                                onClick={onCloudSyncToggle}
                                className={`relative w-9 h-5 rounded-full transition-colors ${cloudSyncEnabled ? "bg-amber-400" : "bg-border-secondary"}`}
                            >
                                <div
                                    className={`absolute top-[2px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${cloudSyncEnabled ? "translate-x-[18px]" : "translate-x-[2px]"}`}
                                />
                            </button>
                        ) : (
                            <button
                                onClick={() => openUrl("https://glimpse-app.lemonsqueezy.com/buy/16bdbd7d-2aa4-4c4e-a101-482386083ea7")}
                                className="px-3 py-1.5 rounded-lg bg-amber-400/10 border border-amber-400/20 text-[11px] font-medium text-amber-400 hover:bg-amber-400/20 transition-colors"
                            >
                                Upgrade
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Cloud Usage Stats Section */}
            <div className="space-y-3">
                <h3 className="text-[11px] uppercase tracking-wider font-semibold text-content-disabled pl-1">Cloud Usage</h3>
                <div className="bg-surface-tertiary border border-border-primary rounded-xl overflow-hidden">
                    {usageStats ? (
                        <div className="p-5">
                            <div className="grid grid-cols-2 gap-8">
                                {/* Monthly Stats */}
                                {isSubscriber && (
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="flex items-center gap-2">
                                                <Cloud size={14} className="text-content-muted" />
                                                <span className="text-[12px] font-medium text-content-primary">This Month</span>
                                            </div>
                                            <div className="text-right">
                                                <div className="text-[11px] font-mono text-content-secondary leading-none mb-1">
                                                    <span className="text-content-primary">{usageStats.cloud_minutes_this_month.toFixed(0)}</span>
                                                    <span className="opacity-50"> / 600 min</span>
                                                </div>
                                                <div className="text-[9px] text-content-disabled font-medium">
                                                    {((usageStats.cloud_minutes_this_month / 600) * 100).toFixed(0)}% used
                                                </div>
                                            </div>
                                        </div>

                                        <UsageBar
                                            value={usageStats.cloud_minutes_this_month}
                                            max={600}
                                            color="var(--color-cloud)"
                                            cols={25}
                                            rows={4}
                                        />

                                        <div className="flex items-center gap-1.5 pt-1">
                                            <DotMatrix rows={1} cols={1} activeDots={[0]} dotSize={2} gap={1} color="var(--color-cloud)" />
                                            <span className="text-[10px] text-content-muted">
                                                {usageStats.cloud_transcriptions_this_month} transcriptions
                                            </span>
                                        </div>
                                    </div>
                                )}

                                {/* Lifetime Stats */}
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2 mb-1">
                                        <Activity size={14} className="text-content-muted" />
                                        <span className="text-[12px] font-medium text-content-primary">Lifetime</span>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <div className="text-[20px] font-mono text-success leading-none mb-1">
                                                {usageStats.cloud_hours_lifetime < 1
                                                    ? (usageStats.cloud_hours_lifetime * 60).toFixed(0)
                                                    : usageStats.cloud_hours_lifetime.toFixed(1)
                                                }
                                                <span className="text-[12px] text-success/70 ml-1">
                                                    {usageStats.cloud_hours_lifetime < 1 ? 'min' : 'hrs'}
                                                </span>
                                            </div>
                                            <div className="text-[10px] text-content-muted">Audio processed</div>
                                        </div>

                                        <div>
                                            <div className="text-[20px] font-mono text-content-primary leading-none mb-1">
                                                {usageStats.cloud_transcriptions_count}
                                            </div>
                                            <div className="text-[10px] text-content-muted">Transcriptions</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="p-8 flex justify-center">
                            <Loader2 size={18} className="animate-spin text-content-disabled" />
                        </div>
                    )}
                </div>
            </div>

            <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                    <h3 className="text-[11px] uppercase tracking-wider font-semibold text-content-disabled">Active Sessions</h3>
                    {sessions.length > 1 && (
                        <button
                            onClick={handleSignOutAll}
                            className="text-[10px] text-red-400 hover:text-red-300 transition-colors"
                        >
                            Sign out all devices
                        </button>
                    )}
                </div>

                <div className="bg-surface-tertiary border border-border-primary rounded-xl overflow-hidden divide-y divide-surface-elevated">
                    {sessionsLoading ? (
                        <div className="p-8 flex justify-center">
                            <Loader2 size={18} className="animate-spin text-content-disabled" />
                        </div>
                    ) : (
                        sessions.map((session) => (
                            <div key={session.$id} className="flex items-center justify-between p-4 hover:bg-surface-surface transition-colors group">
                                <div className="flex items-center gap-3">
                                    <div className={`p-2 rounded-lg ${session.current ? "bg-amber-400/10 text-amber-400" : "bg-surface-elevated text-content-secondary"}`}>
                                        {permissionBasedIcon(session)}
                                    </div>
                                    <div className="flex flex-col">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[13px] text-content-primary font-medium">
                                                {session.clientName || "Unknown Device"}
                                            </span>
                                            {session.current && (
                                                <span className="text-[9px] font-semibold text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">
                                                    Current
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-[11px] text-content-muted">
                                            {session.osName}, {session.countryName || "Unknown Location"}
                                        </span>
                                    </div>
                                </div>
                                {!session.current && (
                                    <button
                                        onClick={() => handleDeleteSession(session.$id)}
                                        disabled={deletingSession === session.$id}
                                        className="text-[11px] font-medium text-content-disabled hover:text-red-400 transition-colors px-2 py-1 opacity-0 group-hover:opacity-100 disabled:opacity-100"
                                    >
                                        {deletingSession === session.$id ? (
                                            <Loader2 size={12} className="animate-spin text-red-400" />
                                        ) : (
                                            "Revoke"
                                        )}
                                    </button>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>

            <AnimatePresence>
                {showPasswordModal && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
                        onClick={closePasswordModal}
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 10 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 10 }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-[380px] rounded-2xl border border-border-primary bg-surface-tertiary p-6 shadow-2xl"
                        >
                            <div className="flex items-center justify-between mb-6">
                                <h3 className="text-[15px] font-medium text-white">Change Password</h3>
                                <button
                                    onClick={closePasswordModal}
                                    className="p-1 rounded-lg hover:bg-surface-elevated text-content-disabled hover:text-white transition-colors"
                                >
                                    <X size={16} />
                                </button>
                            </div>

                            {passwordSuccess ? (
                                <div className="flex flex-col items-center py-6 animate-in fade-in zoom-in duration-300">
                                    <div className="h-12 w-12 rounded-full bg-emerald-500/10 flex items-center justify-center mb-3">
                                        <Check size={20} className="text-emerald-400" />
                                    </div>
                                    <p className="text-[13px] text-content-primary">Password updated successfully</p>
                                </div>
                            ) : (
                                <form onSubmit={handlePasswordChange} className="space-y-4">
                                    {passwordError && (
                                        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-red-200 text-[11px]">
                                            <AlertCircle size={12} className="shrink-0" />
                                            <span className="flex-1">{passwordError}</span>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    navigator.clipboard.writeText(passwordError);
                                                    setPasswordErrorCopied(true);
                                                    setTimeout(() => setPasswordErrorCopied(false), 1500);
                                                }}
                                                className="shrink-0 p-0.5 rounded hover:bg-red-500/20 transition-colors"
                                                title="Copy error"
                                            >
                                                {passwordErrorCopied ? <Check size={11} /> : <Copy size={11} />}
                                            </button>
                                        </div>
                                    )}

                                    <div className="space-y-3">
                                        <div>
                                            <div className="relative">
                                                <input
                                                    type={showCurrentPassword ? "text" : "password"}
                                                    value={currentPassword}
                                                    onChange={(e) => setCurrentPassword(e.target.value)}
                                                    placeholder="Current password"
                                                    className="w-full bg-surface-surface border border-border-secondary rounded-xl px-4 py-2.5 text-[13px] text-white placeholder-content-disabled focus:border-content-disabled outline-none transition-colors"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                                                    className="absolute right-3 top-2.5 text-content-disabled hover:text-content-secondary"
                                                >
                                                    {showCurrentPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                                                </button>
                                            </div>
                                        </div>

                                        <div>
                                            <div className="relative">
                                                <input
                                                    type={showNewPassword ? "text" : "password"}
                                                    value={newPassword}
                                                    onChange={(e) => setNewPassword(e.target.value)}
                                                    placeholder="New password"
                                                    className="w-full bg-surface-surface border border-border-secondary rounded-xl px-4 py-2.5 text-[13px] text-white placeholder-content-disabled focus:border-content-disabled outline-none transition-colors"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => setShowNewPassword(!showNewPassword)}
                                                    className="absolute right-3 top-2.5 text-content-disabled hover:text-content-secondary"
                                                >
                                                    {showNewPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                                                </button>
                                            </div>
                                        </div>

                                        <div>
                                            <input
                                                type="password"
                                                value={confirmPassword}
                                                onChange={(e) => setConfirmPassword(e.target.value)}
                                                placeholder="Confirm new password"
                                                className="w-full bg-surface-surface border border-border-secondary rounded-xl px-4 py-2.5 text-[13px] text-white placeholder-content-disabled focus:border-content-disabled outline-none transition-colors"
                                            />
                                        </div>
                                    </div>

                                    <button
                                        type="submit"
                                        disabled={passwordLoading}
                                        className="w-full bg-content-primary hover:bg-white text-black font-medium rounded-xl py-2.5 text-[13px] transition-colors disabled:opacity-50 mt-2"
                                    >
                                        {passwordLoading ? (
                                            <Loader2 size={14} className="animate-spin mx-auto" />
                                        ) : (
                                            "Save and Update"
                                        )}
                                    </button>
                                </form>
                            )}
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

const permissionBasedIcon = (session: Models.Session) => {
    const client = session.clientType?.toLowerCase() || "";
    if (client.includes("mobile") || session.deviceName?.toLowerCase().includes("phone")) {
        return <Smartphone size={16} fill="currentColor" className="opacity-80" />;
    }
    return <Monitor size={16} fill="currentColor" className="opacity-80" />;
};

const UsageBar = ({ value, max, color, cols = 40, rows = 2 }: { value: number; max: number; color: string; cols?: number; rows?: number }) => {
    const totalDots = cols * rows;
    const percent = Math.min(100, (value / max) * 100);
    const activeCount = Math.round((percent / 100) * totalDots);

    const activeDots = [];
    for (let i = 0; i < activeCount && i < totalDots; i++) {
        activeDots.push(i);
    }

    return (
        <DotMatrix
            rows={rows}
            cols={cols}
            activeDots={activeDots}
            dotSize={3}
            gap={2}
            color={color}
            className="opacity-70"
        />
    );
};

export default AccountView;
