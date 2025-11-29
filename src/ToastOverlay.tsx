import React, { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Types
export type ToastType = "error" | "info" | "success" | "warning" | "update";

export interface ToastPayload {
  type: ToastType;
  title?: string;
  message: string;
  autoDismiss?: boolean;
  duration?: number;
  retryId?: string;
  mode?: "local" | "cloud";
}

interface ToastState extends ToastPayload {
  isLeaving: boolean;
}

const COLORS: Record<ToastType, { border: string; dot: string }> = {
  error: { border: "border-red-500/40", dot: "bg-red-500" },
  info: { border: "border-blue-500/30", dot: "bg-blue-400" },
  success: { border: "border-emerald-500/30", dot: "bg-emerald-400" },
  warning: { border: "border-amber-500/40", dot: "bg-amber-400" },
  update: { border: "border-violet-500/40", dot: "bg-violet-400" },
};

const ToastOverlay: React.FC = () => {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close everything - backend hides both windows
  const closeAll = async () => {
    try {
      // This command stops recording and hides the pill overlay
      await invoke("toast_dismissed");
      // Then hide the toast window itself
      await getCurrentWindow().hide();
    } catch (e) {
      console.error("closeAll failed:", e);
    }
  };

  // Dismiss with animation
  const dismiss = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast((t) => (t ? { ...t, isLeaving: true } : null));
    setTimeout(() => {
      setToast(null);
      closeAll();
    }, 120);
  };

  // Handle X button click - close immediately, don't wait for animation
  const handleClose = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast(null);
    closeAll();
  };

  // Handle retry
  const handleRetry = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!toast?.retryId) return;
    setIsRetrying(true);
    try {
      await invoke("retry_transcription", { id: toast.retryId });
      dismiss();
    } catch (err) {
      console.error("Retry failed:", err);
      setIsRetrying(false);
    }
  };

  // Keyboard: Esc to dismiss
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && toast) {
        e.preventDefault();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast]);

  // Listen for toast events
  useEffect(() => {
    const unsub1 = listen<ToastPayload>("toast:show", (ev) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setToast({ ...ev.payload, isLeaving: false });
      setIsRetrying(false);

      // Auto-dismiss for non-error toasts
      const durations: Record<ToastType, number> = {
        error: 0,
        info: 3000,
        success: 2000,
        warning: 5000,
        update: 0,
      };
      const dur = ev.payload.duration ?? durations[ev.payload.type];
      if (dur > 0) {
        timerRef.current = setTimeout(dismiss, dur);
      }
    });

    const unsub2 = listen("toast:hide", () => dismiss());
    const unsub3 = listen("recording:start", () => {
      if (toast) dismiss();
    });

    return () => {
      unsub1.then((u) => u());
      unsub2.then((u) => u());
      unsub3.then((u) => u());
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!toast) return null;

  const colors = COLORS[toast.type];
  const showRetry = toast.retryId && toast.mode === "cloud";

  // Handle background click - close immediately
  const handleBackgroundClick = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast(null);
    closeAll();
  };

  return (
    <div
      className="w-full h-full flex items-end justify-center"
      onClick={handleBackgroundClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className={`
          relative w-full bg-black rounded-2xl border px-4 py-3
          ${colors.border}
          ${toast.isLeaving ? "animate-toast-out" : "animate-toast-in"}
        `}
        onClick={(e) => e.stopPropagation()}
      >
        {/* X button */}
        <button
          type="button"
          onClick={handleClose}
          className="absolute top-2 right-2 w-5 h-5 flex items-center justify-center 
                     text-gray-500 hover:text-white text-xs transition-colors z-10"
        >
          ✕
        </button>

        {/* Content */}
        <div className="flex items-start gap-2 pr-5">
          <div className={`w-2 h-2 rounded-full mt-1 shrink-0 ${colors.dot} ${toast.type === "error" ? "animate-pulse" : ""}`} />
          <div className="flex-1 min-w-0">
            <p className="text-[12px] text-gray-200 leading-relaxed">{toast.message}</p>
            {showRetry && (
              <button
                type="button"
                onClick={handleRetry}
                disabled={isRetrying}
                className="mt-2 text-[11px] text-blue-400 hover:text-white disabled:text-gray-600 transition-colors"
              >
                {isRetrying ? "Retrying…" : "Retry transcription"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ToastOverlay;
