import { useCallback, useEffect, useRef, useState } from "react";
import { useCopyToClipboard } from "../../../../shared/hooks/useCopyToClipboard";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  ArrowUpRight,
  Check,
  EnvelopeSimple,
  FileText,
  GithubLogo,
  Question as HelpCircle,
  Info,
  CircleNotch as Loader2,
} from "@phosphor-icons/react";
import {
  deleteAllData,
  exportDataset,
  getDatasetPreview,
  type DatasetExportOptions,
} from "../../data-api";

const CLI_WIKI_URL = "https://github.com/glimpse-hq/Glimpse/wiki/CLI";
const REPORT_ISSUE_URL = "https://github.com/glimpse-hq/Glimpse/issues/new";
const SUPPORT_EMAIL = "hello@tryglimpse.cc";

const SUPPORT_ACTION_CLASS =
  "group flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-border-primary bg-surface-surface outline-hidden transition-[transform,border-color,background-color] duration-100 ease-out hover:border-[var(--color-accent-30)] hover:bg-[var(--color-accent-10)] active:translate-y-[2px] focus-visible:ring-2 focus-visible:ring-border-hover";
const SUPPORT_ACTION_ICON_CLASS =
  "shrink-0 text-[var(--color-text-muted)] transition-colors duration-150 group-hover:text-[var(--color-text-primary)]";
const SUPPORT_ACTION_LABEL_CLASS =
  "flex items-center gap-0.5 ui-text-micro leading-none text-[var(--color-text-secondary)] transition-colors duration-150 group-hover:text-[var(--color-text-primary)]";
const MANAGEMENT_ACTION_CLASS =
  "relative -ms-2 inline-flex h-7 shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md px-2 ui-text-button-sm ui-color-secondary outline-none transition-colors hover:bg-surface-elevated/60 hover:text-content-primary focus-visible:ring-2 focus-visible:ring-border-hover disabled:pointer-events-none disabled:opacity-60";
import ToggleSwitch from "../../../../shared/ui/ToggleSwitch";
import SectionLabel from "../../../../shared/ui/SectionLabel";
import SettingCard from "../../../../shared/ui/SettingCard";
import SettingRow from "../../../../shared/ui/SettingRow";
import { UpdateChecker } from "../../../updates/components/UpdateChecker";
import { detectAppPlatform } from "../../../../platform/service";
import type {
  AppInfo,
  CliInstallStatus,
  TranscriptionMode,
} from "../../../../types";

const InlineHoldButton = ({
  onConfirm,
  disabled = false,
  busy = false,
  label,
  busyLabel,
  ariaLabel,
  holdMs,
  tone = "neutral",
}: {
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  label: string;
  busyLabel?: string;
  ariaLabel: string;
  holdMs: number;
  tone?: "neutral" | "danger";
}) => {
  const [progress, setProgress] = useState(0);
  const holdingRef = useRef(false);
  const readyRef = useRef(false);
  const startTimeRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  const cancelHold = useCallback(() => {
    holdingRef.current = false;
    readyRef.current = false;
    startTimeRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setProgress(0);
  }, []);

  const stepHold = useCallback(
    (timestamp: number) => {
      if (!holdingRef.current || startTimeRef.current === null) return;

      const elapsed = timestamp - startTimeRef.current;
      const nextProgress = Math.min(1, elapsed / holdMs);
      setProgress(nextProgress);

      if (nextProgress >= 1) {
        readyRef.current = true;
        frameRef.current = null;
        return;
      }

      frameRef.current = requestAnimationFrame(stepHold);
    },
    [holdMs],
  );

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  const startHold = () => {
    holdingRef.current = true;
    readyRef.current = false;
    startTimeRef.current = performance.now();
    setProgress(0);
    frameRef.current = requestAnimationFrame(stepHold);
  };

  const finishHold = () => {
    if (!holdingRef.current) return;
    if (readyRef.current) {
      onConfirm();
    }
    cancelHold();
  };

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        event.preventDefault();
        startHold();
      }}
      onPointerUp={finishHold}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      onKeyDown={(event) => {
        if (disabled || (event.key !== "Enter" && event.key !== " ")) return;
        if (holdingRef.current) return;
        event.preventDefault();
        startHold();
      }}
      onKeyUp={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        finishHold();
      }}
      onBlur={cancelHold}
      className={`relative -ms-2 inline-flex h-7 shrink-0 select-none touch-none items-center justify-center overflow-hidden rounded-md px-2 ui-text-button-sm outline-none transition-colors hover:bg-surface-elevated/60 focus-visible:ring-2 focus-visible:ring-border-hover disabled:pointer-events-none disabled:opacity-60 ${
        tone === "danger" ? "ui-color-error" : "ui-color-secondary"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-0 origin-left rtl:origin-right ${
          tone === "danger" ? "bg-red-500/20" : "bg-[var(--color-accent-20)]"
        }`}
        style={{ transform: `scaleX(${progress})` }}
      />
      <span className="relative inline-flex items-center gap-1">
        {busy && <Loader2 size={10} className="animate-spin" />}
        <span>{busy && busyLabel ? busyLabel : label}</span>
      </span>
    </button>
  );
};

type AboutTabProps = {
  variants: Variants;
  appInfo: AppInfo | null;
  transcriptionMode: TranscriptionMode;
  formatBytes: (bytes: number) => string;
  cliInstallStatus: CliInstallStatus | null;
  cliInstallBusy: boolean;
  activeLicense: boolean;
  onInstallCli: () => void;
  onRemoveCli: () => void;
  onOpenDataDir: () => void;
  onOpenFAQ: () => void;
  onOpenWhatsNew: () => void;
};

const AboutTab = ({
  variants,
  appInfo,
  transcriptionMode,
  formatBytes,
  cliInstallStatus,
  cliInstallBusy,
  activeLicense,
  onInstallCli,
  onRemoveCli,
  onOpenDataDir,
  onOpenFAQ,
  onOpenWhatsNew,
}: AboutTabProps) => {
  const { t } = useLingui();
  const { copied: supportEmailCopied, copy } = useCopyToClipboard(2000);

  const [exportConfigOpen, setExportConfigOpen] = useState(false);
  const [exportOptions, setExportOptions] = useState<DatasetExportOptions>({
    includeTimestamps: true,
    verbatimText: true,
    skipShortClips: true,
  });
  const [exportBusy, setExportBusy] = useState(false);
  const [deletingData, setDeletingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const exportConfigRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportConfigOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!exportConfigRef.current?.contains(event.target as Node)) {
        setExportConfigOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExportConfigOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [exportConfigOpen]);

  const toggleExportOption = (key: keyof DatasetExportOptions) => {
    setExportOptions((previous) => ({ ...previous, [key]: !previous[key] }));
  };

  const datasetPreview = useQuery({
    queryKey: ["dataset-preview"],
    queryFn: getDatasetPreview,
  });
  const pairCount = datasetPreview.data?.pairs;

  const handleExportDataset = async () => {
    setExportConfigOpen(false);
    setDataError(null);
    const destination = await open({
      directory: true,
      multiple: false,
      title: t({
        id: "settings.about.data.export_dialog_title",
        message: "Choose where to save the dataset",
      }),
    });
    if (typeof destination !== "string") return;
    setExportBusy(true);
    try {
      await exportDataset(destination, exportOptions);
    } catch (err) {
      setDataError(String(err));
    } finally {
      setExportBusy(false);
    }
  };

  const handleDeleteAllData = async () => {
    setDataError(null);
    setDeletingData(true);
    try {
      await deleteAllData();
    } catch (err) {
      setDataError(String(err));
      setDeletingData(false);
    }
  };

  const datasetSubtitle = datasetPreview.isError
    ? t({
        id: "settings.about.data.count_error",
        message: "Couldn't read your recordings",
      })
    : pairCount === undefined
      ? t({
          id: "settings.about.data.count_loading",
          message: "Counting recordings…",
        })
      : pairCount === 0
        ? t({
            id: "settings.about.data.count_zero",
            message: "No transcribed audio yet",
          })
        : pairCount === 1
          ? t({
              id: "settings.about.data.count_one",
              message: "1 audio and text pair",
            })
          : t({
              id: "settings.about.data.count_many",
              message: `${pairCount} audio and text pairs`,
            });

  const isCloudMode = transcriptionMode === "cloud";
  const modeLabel = isCloudMode
    ? t({
        id: "settings.about.mode.cloud",
        message: "Cloud",
      })
    : t({
        id: "settings.about.mode.local",
        message: "Local",
      });

  const recordingsBytes = appInfo?.storage_breakdown?.recordings_bytes ?? 0;
  const libraryBytes = appInfo?.storage_breakdown?.library_bytes ?? 0;
  const databasesBytes = appInfo?.storage_breakdown?.databases_bytes ?? 0;
  const modelsBytes = appInfo?.storage_breakdown?.models_bytes ?? 0;
  const totalBytes =
    appInfo?.storage_breakdown?.total_bytes ??
    appInfo?.data_dir_size_bytes ??
    0;
  const cliUnavailable = cliInstallStatus?.sourceAvailable === false;
  const cliInstalled = cliInstallStatus?.installed ?? false;
  const cliManagedByApp = cliInstallStatus?.managedByApp ?? false;
  const cliInstallLocked = !activeLicense && !cliInstalled;
  const cliInstallPath =
    cliInstallStatus?.installPath ?? "~/.local/bin/glimpse";
  const cliInfo = cliUnavailable
    ? t({
        id: "settings.about.cli.unavailable_info",
        message: "This build does not include the command line helper.",
      })
    : cliInstallLocked
      ? t({
          id: "settings.about.cli.locked_info",
          message: "Command line install requires a full active license.",
        })
      : cliInstalled && !cliManagedByApp
        ? t({
            id: "settings.about.cli.externally_managed_info",
            message: `The glimpse command is installed at ${cliInstallPath} and managed outside Glimpse. Use its package manager to update or remove it.`,
          })
        : cliInstalled
          ? t({
              id: "settings.about.cli.installed_info",
              message: `The glimpse command is installed at ${cliInstallPath}. Use it from Terminal, scripts, or automation tools to call Glimpse without opening the app UI.`,
            })
          : cliInstallStatus && !cliInstallStatus.pathInShell
            ? t({
                id: "settings.about.cli.path_missing_info",
                message: `Installs ${cliInstallStatus.command} to ${cliInstallPath}. That folder is not currently on your shell PATH, so you may need to call it by full path or update your shell profile.`,
              })
            : t({
                id: "settings.about.cli.default_info",
                message: `Installs the ${cliInstallStatus?.command ?? "glimpse"} command for Terminal, scripts, and automation tools. Use it when you want to call Glimpse programmatically without opening the app UI.`,
              });
  const cliSubtitle = cliUnavailable
    ? t({
        id: "settings.about.cli.unavailable_subtitle",
        message: "Not available in this build",
      })
    : cliInstallLocked
      ? t({
          id: "settings.about.cli.locked_subtitle",
          message: "Requires a full active license",
        })
      : cliInstalled
        ? t({
            id: "settings.about.cli.installed_subtitle",
            message: `Installed at ${cliInstallPath}`,
          })
        : t({
            id: "settings.about.cli.default_subtitle",
            message: "Use Glimpse from Terminal or scripts",
          });
  const storageBreakdown = [
    {
      label: t({
        id: "settings.about.storage.recordings",
        message: "Recordings",
      }),
      value: recordingsBytes,
    },
    {
      label: t({
        id: "settings.about.storage.library",
        message: "Library",
      }),
      value: libraryBytes,
    },
    {
      label: t({
        id: "settings.about.storage.models",
        message: "Models",
      }),
      value: modelsBytes,
    },
    {
      label: t({
        id: "settings.about.storage.database",
        message: "Database",
      }),
      value: databasesBytes,
    },
    {
      label: t({
        id: "settings.about.storage.total",
        message: "Total",
      }),
      value: totalBytes,
      primary: true,
    },
  ];

  const handleReportIssue = () => {
    const platformLabel =
      detectAppPlatform() === "windows" ? "Windows" : "macOS";
    const setup = [
      `Glimpse version: ${appInfo?.version ?? "unknown"}`,
      `OS version: ${platformLabel}`,
      `Recording mode / model: ${transcriptionMode}`,
    ].join("\n");
    void openUrl(
      `${REPORT_ISSUE_URL}?template=bug_report.yml&setup=${encodeURIComponent(setup)}`,
    );
  };

  const handleCopyEmail = () => copy(SUPPORT_EMAIL);

  const handleResetOnboarding = async () => {
    try {
      await invoke("reset_onboarding");
      window.location.reload();
    } catch (err) {
      console.error("Failed to restart onboarding:", err);
    }
  };

  return (
    <motion.div
      key="about"
      variants={variants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="space-y-5"
    >
      <header>
        <h1 className="ui-text-title-lg font-medium ui-color-primary">
          {t({
            id: "settings.about.version_label",
            message: "Glimpse",
          })}
        </h1>
        <p className="mt-1 ui-text-body-sm ui-color-muted">
          {t({
            id: "settings.about.version_mode",
            message: `Version ${{ version: appInfo?.version ?? "-" }} • ${{ mode: modeLabel }}`,
          })}
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <SectionLabel>
            {t({
              id: "settings.about.updates",
              message: "Updates",
            })}
          </SectionLabel>
          <UpdateChecker
            onOpenWhatsNew={onOpenWhatsNew}
            storeBuild={appInfo ? appInfo.store_build : undefined}
          />
        </div>
        <div className="space-y-2">
          <SectionLabel>
            {t({
              id: "settings.about.support",
              message: "Support",
            })}
          </SectionLabel>
          <div className="grid h-[52px] grid-cols-4 gap-1.5">
            <button
              type="button"
              onClick={() => {
                void invoke("reveal_logs").catch(() => {});
              }}
              className={SUPPORT_ACTION_CLASS}
            >
              <FileText
                size={14}
                aria-hidden="true"
                className={SUPPORT_ACTION_ICON_CLASS}
              />
              <span className={SUPPORT_ACTION_LABEL_CLASS}>
                {t({
                  id: "settings.about.show_logs",
                  message: "Logs",
                })}
              </span>
            </button>
            <button
              type="button"
              onClick={handleReportIssue}
              className={SUPPORT_ACTION_CLASS}
            >
              <GithubLogo
                size={14}
                aria-hidden="true"
                className={SUPPORT_ACTION_ICON_CLASS}
              />
              <span className={SUPPORT_ACTION_LABEL_CLASS}>
                {t({
                  id: "settings.about.report_issue",
                  message: "GitHub",
                })}
                <ArrowUpRight
                  size={9}
                  aria-hidden="true"
                  className="shrink-0 text-[var(--color-text-disabled)] transition-colors duration-150 group-hover:text-[var(--color-text-muted)]"
                />
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                void handleCopyEmail();
              }}
              disabled={supportEmailCopied}
              title={SUPPORT_EMAIL}
              className={`${SUPPORT_ACTION_CLASS} disabled:pointer-events-none`}
            >
              {supportEmailCopied ? (
                <Check
                  size={14}
                  aria-hidden="true"
                  className="text-[var(--color-success)]"
                />
              ) : (
                <EnvelopeSimple
                  size={14}
                  aria-hidden="true"
                  className={SUPPORT_ACTION_ICON_CLASS}
                />
              )}
              <span className={SUPPORT_ACTION_LABEL_CLASS}>
                {supportEmailCopied
                  ? t({
                      id: "settings.about.email_support.copied",
                      message: "Copied",
                    })
                  : t({
                      id: "settings.about.email_support",
                      message: "Email",
                    })}
              </span>
            </button>
            <button
              type="button"
              onClick={onOpenFAQ}
              className={SUPPORT_ACTION_CLASS}
            >
              <HelpCircle
                size={14}
                aria-hidden="true"
                className={SUPPORT_ACTION_ICON_CLASS}
              />
              <span className={SUPPORT_ACTION_LABEL_CLASS}>
                {t({
                  id: "settings.about.faq",
                  message: "FAQ",
                })}
              </span>
            </button>
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <SectionLabel>
          {t({
            id: "settings.about.storage",
            message: "Storage",
          })}
        </SectionLabel>

        <div className="space-y-4 px-1">
          <div className="grid grid-cols-5 gap-x-6 gap-y-3">
            {storageBreakdown.map((row) => (
              <div key={row.label} className="min-w-0">
                <p className="ui-text-micro ui-color-disabled">{row.label}</p>
                <p
                  dir="ltr"
                  className={`mt-1 truncate text-start font-mono tabular-nums ui-text-meta ${
                    row.primary ? "ui-color-primary" : "ui-color-secondary"
                  }`}
                >
                  {formatBytes(row.value)}
                </p>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={onOpenDataDir}
            disabled={!appInfo?.data_dir_path}
            title={appInfo?.data_dir_path}
            className="block w-full min-w-0 truncate text-start ui-text-meta font-mono ui-color-muted transition-colors hover:ui-color-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span
              dir="ltr"
              className="border-b border-dotted border-content-disabled/70 pb-px"
            >
              {appInfo?.data_dir_path ?? "-"}
            </span>
          </button>
        </div>
      </section>

      <section className="grid grid-cols-2 items-stretch gap-4">
        <div className="flex flex-col space-y-2">
          <SectionLabel className="shrink-0">
            {t({
              id: "settings.about.data",
              message: "Data",
            })}
          </SectionLabel>

          <SettingCard flush className="flex flex-1 flex-col">
            <SettingRow
              className="min-h-[88px] flex-1 px-3.5 py-2.5"
              title={t({
                id: "settings.about.data.export_dataset",
                message: "Export dataset",
              })}
              description={datasetSubtitle}
              footer={
                <div className="relative" ref={exportConfigRef}>
                  <button
                    type="button"
                    onClick={() => setExportConfigOpen((previous) => !previous)}
                    disabled={exportBusy || pairCount === 0}
                    className={MANAGEMENT_ACTION_CLASS}
                  >
                    {exportBusy && (
                      <Loader2 size={10} className="animate-spin" />
                    )}
                    <span>
                      {t({
                        id: "settings.about.data.export_action",
                        message: "Export",
                      })}
                    </span>
                  </button>

                  <AnimatePresence>
                    {exportConfigOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.15 }}
                        className="ui-surface-menu absolute end-0 top-full z-20 mt-1 w-64"
                      >
                        <div className="space-y-3 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <span className="min-w-0">
                              <span className="block ui-text-meta ui-color-primary">
                                {t({
                                  id: "settings.about.data.include_timestamps",
                                  message: "Timestamps",
                                })}
                              </span>
                              <span className="block ui-text-micro ui-color-muted">
                                {t({
                                  id: "settings.about.data.include_timestamps_hint",
                                  message: "Segment start and end times",
                                })}
                              </span>
                            </span>
                            <ToggleSwitch
                              enabled={exportOptions.includeTimestamps}
                              onToggle={() =>
                                toggleExportOption("includeTimestamps")
                              }
                              size="xs"
                              ariaLabel={t({
                                id: "settings.about.data.include_timestamps_aria",
                                message: "Include timestamps in the export",
                              })}
                            />
                          </div>

                          <div className="flex items-start justify-between gap-3">
                            <span className="min-w-0">
                              <span className="block ui-text-meta ui-color-primary">
                                {t({
                                  id: "settings.about.data.verbatim_text",
                                  message: "Original text",
                                })}
                              </span>
                              <span className="block ui-text-micro ui-color-muted">
                                {t({
                                  id: "settings.about.data.verbatim_text_hint",
                                  message: "Transcripts before cleanup",
                                })}
                              </span>
                            </span>
                            <ToggleSwitch
                              enabled={exportOptions.verbatimText}
                              onToggle={() =>
                                toggleExportOption("verbatimText")
                              }
                              size="xs"
                              ariaLabel={t({
                                id: "settings.about.data.verbatim_text_aria",
                                message:
                                  "Use the original transcripts before cleanup",
                              })}
                            />
                          </div>

                          <div className="flex items-start justify-between gap-3">
                            <span className="min-w-0">
                              <span className="block ui-text-meta ui-color-primary">
                                {t({
                                  id: "settings.about.data.skip_short",
                                  message: "Skip short clips",
                                })}
                              </span>
                              <span className="block ui-text-micro ui-color-muted">
                                {t({
                                  id: "settings.about.data.skip_short_hint",
                                  message: "Leaves out clips under a second",
                                })}
                              </span>
                            </span>
                            <ToggleSwitch
                              enabled={exportOptions.skipShortClips}
                              onToggle={() =>
                                toggleExportOption("skipShortClips")
                              }
                              size="xs"
                              ariaLabel={t({
                                id: "settings.about.data.skip_short_aria",
                                message: "Skip clips shorter than one second",
                              })}
                            />
                          </div>
                        </div>

                        <div className="border-t border-border-primary/60" />

                        <button
                          type="button"
                          onClick={() => {
                            void handleExportDataset();
                          }}
                          className="flex h-8 w-full items-center justify-center ui-text-button-sm ui-color-secondary transition-colors hover:bg-[var(--surface-interactive)] hover:text-content-primary"
                        >
                          {t({
                            id: "settings.about.data.export_confirm",
                            message: "Export…",
                          })}
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              }
            />

            <div className="ms-[44px] shrink-0 border-t border-border-primary/60" />

            <SettingRow
              className="min-h-[88px] flex-1 px-3.5 py-2.5"
              title={t({
                id: "settings.about.data.delete_all",
                message: "Delete all data",
              })}
              description={t({
                id: "settings.about.data.delete_all_description",
                message:
                  "Removes recordings, transcripts, models, and settings, then quits",
              })}
              footer={
                <InlineHoldButton
                  onConfirm={() => {
                    void handleDeleteAllData();
                  }}
                  disabled={deletingData}
                  busy={deletingData}
                  label={t({
                    id: "settings.about.data.hold_to_delete",
                    message: "Hold to delete",
                  })}
                  busyLabel={t({
                    id: "settings.about.data.deleting",
                    message: "Deleting…",
                  })}
                  ariaLabel={t({
                    id: "settings.about.data.delete_all_aria",
                    message:
                      "Delete all data. Hold for ten seconds to confirm.",
                  })}
                  holdMs={10000}
                  tone="danger"
                />
              }
            />
          </SettingCard>

          {dataError ? (
            <p className="break-words [overflow-wrap:anywhere] px-1 ui-text-micro ui-color-error">
              {dataError}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col space-y-2">
          <SectionLabel className="shrink-0">
            {t({
              id: "settings.about.setup",
              message: "Setup",
            })}
          </SectionLabel>

          <SettingCard flush className="flex flex-1 flex-col">
            <SettingRow
              className="min-h-[88px] flex-1 px-3.5 py-2.5"
              title={
                <div className="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      void openUrl(CLI_WIKI_URL);
                    }}
                    aria-label={t({
                      id: "settings.about.command_line.open_wiki_aria",
                      message: "Open the command line documentation",
                    })}
                    className="inline-flex min-w-0 items-center gap-1 ui-text-label-strong ui-color-primary transition-colors hover:text-content-secondary outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-border-hover"
                  >
                    <span className="min-w-0 break-words">
                      {t({
                        id: "settings.about.command_line",
                        message: "Command line",
                      })}
                    </span>
                    <ArrowUpRight
                      size={12}
                      strokeWidth={2}
                      aria-hidden="true"
                      className="shrink-0 ui-color-muted"
                    />
                  </button>
                  <div className="relative group shrink-0">
                    <button
                      type="button"
                      className="flex size-4 items-center justify-center ui-color-disabled transition-colors hover:ui-color-muted focus:ui-color-muted focus:outline-none"
                      aria-label={t({
                        id: "settings.about.command_line.info_aria",
                        message: "More information about command line tools",
                      })}
                    >
                      <Info size={10} aria-hidden="true" />
                    </button>
                    <div className="absolute left-1/2 bottom-full z-20 mb-1 hidden -translate-x-1/2 group-hover:block group-focus-within:block">
                      <div className="w-56 rounded-lg border border-border-secondary bg-surface-overlay px-2.5 py-1.5 ui-text-micro ui-color-secondary shadow-lg leading-tight">
                        {cliInfo}
                      </div>
                    </div>
                  </div>
                </div>
              }
              description={cliSubtitle}
              footer={
                <button
                  type="button"
                  onClick={
                    cliInstalled && cliManagedByApp ? onRemoveCli : onInstallCli
                  }
                  disabled={
                    cliInstallBusy ||
                    (cliInstalled && !cliManagedByApp) ||
                    (!cliInstalled && (cliUnavailable || !activeLicense))
                  }
                  className={MANAGEMENT_ACTION_CLASS}
                >
                  {cliInstallBusy && (
                    <Loader2 size={10} className="animate-spin" />
                  )}
                  <span>
                    {cliInstalled && cliManagedByApp
                      ? t({
                          id: "settings.about.uninstall_cli",
                          message: "Uninstall",
                        })
                      : cliInstalled
                        ? t({
                            id: "settings.about.cli.installed_action",
                            message: "Installed",
                          })
                        : t({
                            id: "settings.about.install_cli",
                            message: "Install CLI",
                          })}
                  </span>
                </button>
              }
            />

            <div className="ms-[44px] shrink-0 border-t border-border-primary/60" />

            <SettingRow
              className="min-h-[88px] flex-1 px-3.5 py-2.5"
              title={t({
                id: "settings.about.restart_onboarding",
                message: "Restart onboarding",
              })}
              description={t({
                id: "settings.about.restart_onboarding_description",
                message: "Runs setup again",
              })}
              footer={
                <InlineHoldButton
                  onConfirm={() => {
                    void handleResetOnboarding();
                  }}
                  label={t({
                    id: "settings.about.data.hold_to_restart",
                    message: "Hold to restart",
                  })}
                  ariaLabel={t({
                    id: "settings.about.restart_onboarding_hold_aria",
                    message: "Restart Onboarding. Hold to confirm.",
                  })}
                  holdMs={2000}
                />
              }
            />
          </SettingCard>
        </div>
      </section>
    </motion.div>
  );
};

export default AboutTab;
