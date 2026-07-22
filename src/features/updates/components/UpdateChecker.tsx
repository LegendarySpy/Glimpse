import { useLingui } from "@lingui/react/macro";
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import {
  DownloadSimple as Download,
  ArrowsClockwise as RefreshCw,
  CheckCircle,
  WarningCircle as AlertCircle,
  CircleNotch as Loader2,
} from "@phosphor-icons/react";
import { motion, AnimatePresence } from "framer-motion";
import WhatsNewModal from "./WhatsNewModal";
import DotMatrix from "../../../shared/ui/DotMatrix";
import { updateKeys, useUpdateStatus } from "../queries";

interface UpdateCheckerProps {
  autoCheck?: boolean;
  onOpenWhatsNew?: () => void;
  // undefined while app info is loading; true on Microsoft Store installs
  storeBuild?: boolean;
}

interface UpdateDownloadProgressPayload {
  downloaded: number;
  total?: number | null;
  progress?: number | null;
}

const PENDING_RESTART_KEY = "glimpse_update_pending_restart";

const UPDATE_BOX_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 h-[52px]";

const formatError = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

export function UpdateChecker({
  autoCheck = true,
  onOpenWhatsNew,
  storeBuild,
}: UpdateCheckerProps) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const { data: updateStatus } = useUpdateStatus();
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const availableVersion =
    installed || !updateStatus?.available ? null : updateStatus.version;

  useEffect(() => {
    const pendingVersion = localStorage.getItem(PENDING_RESTART_KEY);
    if (!pendingVersion) return;
    getVersion().then((currentVersion) => {
      if (pendingVersion === currentVersion) {
        // Update was already applied - clear stale key
        localStorage.removeItem(PENDING_RESTART_KEY);
      } else {
        setInstalled(true);
      }
    });
  }, []);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    setError(null);
    setDownloadError(null);
    try {
      await invoke("check_for_updates");
      await queryClient.invalidateQueries({ queryKey: updateKeys.status() });
    } catch (err) {
      console.error("Update check failed:", err);
      setError(formatError(err));
    } finally {
      setChecking(false);
    }
  }, [queryClient]);

  useEffect(() => {
    let cancelled = false;
    let unlistenCheck: UnlistenFn | undefined;

    // Wait until storeBuild resolves to false; store installs never check.
    if (storeBuild !== false) return;

    if (autoCheck) {
      void checkForUpdates();
    }

    listen("updater:check", () => {
      void checkForUpdates();
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenCheck = fn;
    });

    return () => {
      cancelled = true;
      unlistenCheck?.();
    };
  }, [autoCheck, checkForUpdates, storeBuild]);

  useEffect(() => {
    let cancelled = false;
    let unlistenProgress: UnlistenFn | undefined;

    listen<UpdateDownloadProgressPayload>(
      "update:download-progress",
      (event) => {
        const payload = event.payload;
        if (!payload) return;

        if (typeof payload.progress === "number") {
          setProgress(Math.max(0, Math.min(100, Math.round(payload.progress))));
          return;
        }

        const total = payload.total;
        if (typeof total === "number" && total > 0) {
          setProgress(
            Math.max(
              0,
              Math.min(100, Math.round((payload.downloaded / total) * 100)),
            ),
          );
        }
      },
    ).then((fn) => {
      if (cancelled) fn();
      else unlistenProgress = fn;
    });

    return () => {
      cancelled = true;
      unlistenProgress?.();
    };
  }, []);

  const handleDownloadAndInstall = async () => {
    setDownloading(true);
    setProgress(0);
    setError(null);
    setDownloadError(null);

    try {
      const pendingVersion = availableVersion;
      await invoke("download_and_install_update");

      setInstalled(true);
      queryClient.setQueryData(updateKeys.status(), {
        available: false,
        version: null,
      });
      if (pendingVersion) {
        localStorage.setItem(PENDING_RESTART_KEY, pendingVersion);
      }
    } catch (err) {
      console.error("Update failed:", err);
      setDownloadError(formatError(err));
    } finally {
      setDownloading(false);
    }
  };

  const handleRelaunch = async () => {
    localStorage.removeItem(PENDING_RESTART_KEY);
    await relaunch();
  };

  if (storeBuild) {
    return (
      <>
        <div className={`${UPDATE_BOX_CLASS} bg-surface-surface`}>
          <CheckCircle size={16} className="text-content-disabled shrink-0" />
          <p className="flex-1 ui-text-body-sm ui-color-primary">
            {t({
              id: "updates.store_managed",
              message: "Updates come from the Microsoft Store",
            })}
          </p>
          <button
            onClick={() => {
              if (onOpenWhatsNew) {
                onOpenWhatsNew();
              } else {
                setWhatsNewOpen(true);
              }
            }}
            className="ui-text-label ui-color-muted hover:text-content-secondary underline underline-offset-2 transition-colors shrink-0"
          >
            {t({
              id: "updates.whats_new",
              message: "What's new?",
            })}
          </button>
        </div>
        {!onOpenWhatsNew && (
          <WhatsNewModal
            isOpen={whatsNewOpen}
            onClose={() => setWhatsNewOpen(false)}
          />
        )}
      </>
    );
  }

  if (installed) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className={`${UPDATE_BOX_CLASS} border border-green-500/20 bg-green-500/10`}
      >
        <CheckCircle size={16} className="ui-color-success-strong shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="ui-text-body-sm-strong ui-color-success-strong">
            {t({
              id: "updates.installed",
              message: "Update installed",
            })}
          </p>
          <p className="ui-text-meta ui-color-success-subtle">
            {t({
              id: "updates.restart_to_apply",
              message: "Restart to apply",
            })}
          </p>
        </div>
        <motion.button
          onClick={handleRelaunch}
          className="rounded-lg bg-green-500 px-2.5 py-1.5 ui-text-button ui-color-on-solid hover:bg-green-400 transition-colors shrink-0"
          whileTap={{ scale: 0.97 }}
        >
          {t({
            id: "updates.restart",
            message: "Restart",
          })}
        </motion.button>
      </motion.div>
    );
  }

  if (availableVersion) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className={`${UPDATE_BOX_CLASS} border border-amber-400/20 bg-amber-400/5`}
      >
        <Download size={16} className="ui-color-warning-strong shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="ui-text-body-sm-strong ui-color-warning-strong truncate">
            {t({
              id: "updates.available_version",
              message: `v${{ version: availableVersion }} available`,
            })}
          </p>
          {downloadError ? (
            <p
              className="ui-text-meta ui-color-error-subtle truncate"
              title={downloadError}
            >
              {downloadError}
            </p>
          ) : (
            <p className="ui-text-meta ui-color-warning-subtle">
              {t({
                id: "updates.ready_to_install",
                message: "Ready to install",
              })}
            </p>
          )}
        </div>
        <AnimatePresence mode="wait">
          {downloading ? (
            <motion.div
              key="downloading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 shrink-0"
            >
              <DotMatrix
                rows={2}
                cols={10}
                activeDots={Array.from(
                  {
                    length: Math.min(
                      10,
                      Math.max(0, Math.floor((progress / 100) * 10)),
                    ),
                  },
                  (_, col) => [col, col + 10],
                ).flat()}
                dotSize={2}
                gap={2}
                color="var(--color-accent)"
                className="opacity-80"
              />
              <span className="ui-text-meta ui-color-muted w-8 tabular-nums">
                {progress}%
              </span>
            </motion.div>
          ) : (
            <motion.button
              key="update-btn"
              onClick={handleDownloadAndInstall}
              className="rounded-lg bg-amber-400 px-2.5 py-1.5 ui-text-button ui-color-on-warning hover:bg-amber-300 transition-colors shrink-0"
              whileTap={{ scale: 0.97 }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {t({
                id: "updates.update",
                message: "Update",
              })}
            </motion.button>
          )}
        </AnimatePresence>
      </motion.div>
    );
  }

  if (error) {
    return (
      <div
        className={`${UPDATE_BOX_CLASS} border border-red-500/20 bg-red-500/5`}
      >
        <AlertCircle size={16} className="ui-color-error-strong shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="ui-text-body-sm-strong ui-color-error-strong">
            {t({
              id: "updates.check_failed",
              message: "Update check failed",
            })}
          </p>
          <p
            className="ui-text-meta ui-color-error-subtle truncate"
            title={error}
          >
            {error}
          </p>
        </div>
        <motion.button
          onClick={() => checkForUpdates()}
          className="flex items-center gap-1.5 rounded-lg border border-red-500/20 px-2.5 py-1.5 ui-text-button ui-color-error-strong hover:bg-red-500/10 transition-colors shrink-0"
          whileTap={{ scale: 0.97 }}
        >
          <RefreshCw size={12} />
          {t({
            id: "updates.retry",
            message: "Retry",
          })}
        </motion.button>
      </div>
    );
  }

  return (
    <>
      <div className={`${UPDATE_BOX_CLASS} bg-surface-surface`}>
        {checking ? (
          <>
            <Loader2
              size={16}
              className="text-content-muted animate-spin shrink-0"
            />
            <p className="flex-1 ui-text-body-sm ui-color-muted">
              {t({
                id: "updates.checking",
                message: "Checking for updates...",
              })}
            </p>
          </>
        ) : (
          <>
            <CheckCircle size={16} className="text-content-disabled shrink-0" />
            <p className="flex-1 ui-text-body-sm ui-color-primary">
              {t({
                id: "updates.up_to_date",
                message: "You're up to date",
              })}
            </p>
          </>
        )}
        <button
          onClick={() => {
            if (onOpenWhatsNew) {
              onOpenWhatsNew();
            } else {
              setWhatsNewOpen(true);
            }
          }}
          className="ui-text-label ui-color-muted hover:text-content-secondary underline underline-offset-2 transition-colors shrink-0"
        >
          {t({
            id: "updates.whats_new",
            message: "What's new?",
          })}
        </button>
        <motion.button
          onClick={() => checkForUpdates()}
          disabled={checking}
          className="p-1.5 rounded-md text-content-muted hover:text-content-secondary hover:bg-surface-elevated transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          whileTap={{ scale: 0.95 }}
          title={t({
            id: "updates.check_title",
            message: "Check for updates",
          })}
          aria-label={t({
            id: "updates.check_aria",
            message: "Check for updates",
          })}
        >
          <RefreshCw size={14} />
        </motion.button>
      </div>
      {!onOpenWhatsNew && (
        <WhatsNewModal
          isOpen={whatsNewOpen}
          onClose={() => setWhatsNewOpen(false)}
        />
      )}
    </>
  );
}
