import { invoke } from "@tauri-apps/api/core";
import { Bug, Bell, AlertTriangle, CheckCircle, Info, AlertCircle, Zap } from "lucide-react";

export function DebugSection() {
    const showToast = async (
        toastType: string,
        message: string,
        action?: string,
        actionLabel?: string
    ) => {
        await invoke("debug_show_toast", {
            toastType,
            message,
            action: action ?? null,
            actionLabel: actionLabel ?? null,
        });
    };

    const resetVersionTracking = () => {
        localStorage.setItem("glimpse_last_version", "0.0.0");
        alert("Version tracking reset. Reload the app to see the update toast.");
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-2 pb-3 border-b border-border-primary">
                <Bug size={16} className="text-red-400" />
                <h3 className="text-[14px] font-semibold text-content-primary">Developer Tools</h3>
                <span className="ml-auto text-[10px] px-2 py-0.5 rounded bg-red-500/20 text-red-400 font-mono">
                    DEV ONLY
                </span>
            </div>

            <div className="space-y-4">
                <div>
                    <p className="text-[11px] font-medium text-content-muted uppercase tracking-wider mb-3">
                        Toast Notifications
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => showToast("success", "This is a success toast!")}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-[11px] text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                        >
                            <CheckCircle size={12} />
                            Success
                        </button>
                        <button
                            onClick={() => showToast("error", "This is an error toast!")}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-[11px] text-red-400 hover:bg-red-500/20 transition-colors"
                        >
                            <AlertCircle size={12} />
                            Error
                        </button>
                        <button
                            onClick={() => showToast("warning", "This is a warning toast!")}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-400 hover:bg-amber-500/20 transition-colors"
                        >
                            <AlertTriangle size={12} />
                            Warning
                        </button>
                        <button
                            onClick={() => showToast("info", "This is an info toast!")}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-[11px] text-blue-400 hover:bg-blue-500/20 transition-colors"
                        >
                            <Info size={12} />
                            Info
                        </button>
                        <button
                            onClick={() => showToast(
                                "update",
                                "Updated to v0.4.0",
                                "open_whats_new",
                                "See what's new"
                            )}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-[11px] text-violet-400 hover:bg-violet-500/20 transition-colors col-span-2"
                        >
                            <Zap size={12} />
                            Update Toast (with action)
                        </button>
                    </div>
                </div>

                <div>
                    <p className="text-[11px] font-medium text-content-muted uppercase tracking-wider mb-3">
                        Version Tracking
                    </p>
                    <button
                        onClick={resetVersionTracking}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-elevated border border-border-secondary text-[11px] text-content-secondary hover:bg-surface-elevated-hover hover:border-border-hover transition-colors w-full"
                    >
                        <Bell size={12} />
                        Reset Version (trigger update toast on reload)
                    </button>
                </div>

                <div>
                    <p className="text-[11px] font-medium text-content-muted uppercase tracking-wider mb-3">
                        Storage
                    </p>
                    <div className="space-y-2">
                        <button
                            onClick={() => {
                                localStorage.clear();
                                alert("localStorage cleared. Reload the app.");
                            }}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-[11px] text-red-400 hover:bg-red-500/20 transition-colors w-full"
                        >
                            <AlertTriangle size={12} />
                            Clear localStorage
                        </button>
                    </div>
                </div>

                <div className="pt-3 border-t border-border-primary">
                    <p className="text-[10px] text-content-disabled font-mono">
                        This section is only visible to accounts with the 'dev' label.
                    </p>
                </div>
            </div>
        </div>
    );
}

export default DebugSection;
