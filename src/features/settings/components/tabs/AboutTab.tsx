import { useCopyToClipboard } from "../../../../shared/hooks/useCopyToClipboard";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLingui } from "@lingui/react/macro";
import { motion, type Variants } from "framer-motion";
import {
  ArrowUpRight,
  Check,
  EnvelopeSimple,
  FileText,
  GithubLogo,
  Question as HelpCircle,
  Info,
  CircleNotch as Loader2,
  ArrowCounterClockwise as RotateCcw,
  TerminalWindow as Terminal,
} from "@phosphor-icons/react";

const CLI_WIKI_URL = "https://github.com/glimpse-hq/Glimpse/wiki/CLI";
const REPORT_ISSUE_URL = "https://github.com/glimpse-hq/Glimpse/issues/new";
const SUPPORT_EMAIL = "hello@tryglimpse.cc";

const SUPPORT_ACTION_CLASS =
  "group flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-border-primary bg-surface-surface outline-hidden transition-[transform,border-color,background-color] duration-100 ease-out hover:border-[var(--color-accent-30)] hover:bg-[var(--color-accent-10)] active:translate-y-[2px] focus-visible:ring-2 focus-visible:ring-border-hover";
const SUPPORT_ACTION_ICON_CLASS =
  "shrink-0 text-[var(--color-text-muted)] transition-colors duration-150 group-hover:text-[var(--color-text-primary)]";
const SUPPORT_ACTION_LABEL_CLASS =
  "flex items-center gap-0.5 ui-text-micro leading-none text-[var(--color-text-secondary)] transition-colors duration-150 group-hover:text-[var(--color-text-primary)]";
import ActionCardButton from "../../../../shared/ui/ActionCardButton";
import SectionLabel from "../../../../shared/ui/SectionLabel";
import HoldActionCardButton from "../../../../shared/ui/HoldActionCardButton";
import { UpdateChecker } from "../../../updates/components/UpdateChecker";
import { detectAppPlatform } from "../../../../platform/service";
import type {
  AppInfo,
  CliInstallStatus,
  TranscriptionMode,
} from "../../../../types";

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
            id: "settings.about.version",
            message: "Version",
          })}{" "}
          <span className="font-mono tabular-nums">
            {appInfo?.version ?? "-"}
          </span>
          <span aria-hidden="true" className="mx-1.5 ui-color-disabled">
            ·
          </span>
          <span>{modeLabel}</span>
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
          <div className="grid h-[52px] grid-cols-3 gap-1.5">
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
                  className={`mt-1 truncate font-mono tabular-nums ui-text-meta ${
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
            className="block w-full min-w-0 truncate text-left ui-text-meta font-mono ui-color-muted transition-colors hover:ui-color-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="border-b border-dotted border-content-disabled/70 pb-px">
              {appInfo?.data_dir_path ?? "-"}
            </span>
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <SectionLabel>
          {t({
            id: "settings.about.setup",
            message: "Setup & help",
          })}
        </SectionLabel>

        <div className="grid grid-cols-2 gap-4">
          <HoldActionCardButton
            onConfirm={() => {
              void handleResetOnboarding();
            }}
            accentPreset="accent"
            title={t({
              id: "settings.about.restart_onboarding",
              message: "Restart Onboarding",
            })}
            description={t({
              id: "settings.about.restart_onboarding_description",
              message: "hold to re-run setup experience",
            })}
            ariaLabel={t({
              id: "settings.about.restart_onboarding_hold_aria",
              message: "Restart Onboarding. Hold to confirm.",
            })}
            icon={<RotateCcw size={14} strokeWidth={2} />}
          />
          <ActionCardButton
            onClick={onOpenFAQ}
            title={t({
              id: "settings.about.faq_help",
              message: "FAQ & Help",
            })}
            description={t({
              id: "settings.about.faq_help_description",
              message: "common questions",
            })}
            icon={<HelpCircle size={14} strokeWidth={2} />}
            accentPreset="cloud"
          />
        </div>
      </section>

      <section className="space-y-2">
        <SectionLabel>
          {t({
            id: "settings.about.advanced",
            message: "Advanced",
          })}
        </SectionLabel>

        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg bg-surface-surface p-2.5">
            <div className="flex min-h-[52px] gap-2.5 px-1 py-0.5">
              <span className="flex size-5 shrink-0 self-center items-center justify-center ui-color-muted">
                <Terminal size={14} strokeWidth={2} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
                      <span className="truncate">
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
                  <button
                    type="button"
                    onClick={
                      cliInstalled && cliManagedByApp
                        ? onRemoveCli
                        : onInstallCli
                    }
                    disabled={
                      cliInstallBusy ||
                      (cliInstalled && !cliManagedByApp) ||
                      (!cliInstalled && (cliUnavailable || !activeLicense))
                    }
                    className="inline-flex h-6 min-w-[4.75rem] shrink-0 items-center justify-center gap-1 px-1 ui-text-button-sm ui-color-secondary transition-colors hover:text-content-primary disabled:pointer-events-none disabled:opacity-60"
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
                </div>
                <p className="mt-1 truncate ui-text-meta ui-color-muted">
                  {cliSubtitle}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </motion.div>
  );
};

export default AboutTab;
