import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  Warning as AlertTriangle,
  Check,
  CaretLeft as ChevronLeft,
  CaretRight as ChevronRight,
  ArrowElbowDownRight as CornerDownRight,
  CircleNotch as Loader2,
} from "@phosphor-icons/react";
import ToggleSwitch from "../../../../shared/ui/ToggleSwitch";
import SectionLabel from "../../../../shared/ui/SectionLabel";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  checkMacInputMonitoringPermission,
  requestMacAccessibilityPermission,
  requestMacInputMonitoringPermission,
} from "../../../../shared/lib/macosPermissions";
import { buildAppLocaleOptions } from "../../../../shared/lib/appLocales";
import { Dropdown } from "../../../../shared/ui/Dropdown";
import type { PlatformCapabilities } from "../../../../shared/lib/platform";
import type {
  AppLocaleSetting,
  AutoDeleteTarget,
  MediaAction,
  RecordingPrunePolicy,
  TextSizeMode,
  ThemeMode,
} from "../../../../types";

type RecordingPrunePreview = {
  candidate_count: number;
};

type PruneTarget = AutoDeleteTarget;

type PendingPruneConfirmation = {
  target: PruneTarget;
  duration: RecordingPrunePolicy;
  candidateCount: number | null;
};

const recordingPrunePolicyFor = (
  target: PruneTarget,
  duration: RecordingPrunePolicy,
) => (target === "audio" ? duration : "never");

const transcriptionPrunePolicyFor = (
  target: PruneTarget,
  duration: RecordingPrunePolicy,
) => (target === "transcripts" ? duration : "never");

const recordingPrunePolicySeverity: Record<RecordingPrunePolicy, number> = {
  never: 0,
  year: 1,
  three_months: 1,
  month: 3,
  week: 4,
  day: 5,
  immediately: 6,
};

const inlineAutoDeleteDropdownProps = {
  className: "w-fit",
  buttonClassName:
    "!h-[22px] !w-auto !rounded-md !border-transparent !bg-transparent !px-0.5 !py-0 ui-text-label-strong focus:!border-transparent",
  valueClassName:
    "text-left underline underline-offset-[3px] decoration-content-muted hover:decoration-content-primary transition-colors",
  optionClassName: "!px-2 !py-1.5",
  optionLabelClassName: "ui-text-meta font-medium whitespace-nowrap",
  menuClassName: "w-max min-w-full !right-auto",
  truncate: false as const,
  fitButtonToWidestOption: false as const,
  hideChevron: true as const,
};

const PermissionStatus = ({ granted }: { granted: boolean | null }) => {
  const { t } = useLingui();

  if (granted === null) {
    return (
      <Loader2
        size={10}
        className="animate-spin text-content-muted"
        aria-label={t({
          id: "settings.app.permission.checking",
          message: "Checking permission",
        })}
      />
    );
  }
  if (granted) {
    return (
      <span className="ui-text-meta ui-color-success flex items-center gap-1">
        <Check size={10} aria-hidden="true" />
        <span className="sr-only">
          {t({
            id: "settings.app.permission.enabled",
            message: "Enabled",
          })}
        </span>
      </span>
    );
  }
  return (
    <span className="ui-text-meta ui-color-warning">
      {t({
        id: "settings.app.permission.off",
        message: "off",
      })}
    </span>
  );
};

type AppTabProps = {
  variants: Variants;
  micPermission: boolean | null;
  accessibilityPermission: boolean | null;
  inputMonitoringPermission: boolean | null;
  onRequestMicrophonePermission: () => Promise<void>;
  textSizeMode: TextSizeMode;
  onTextSizeModeChange: (mode: TextSizeMode) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  appLocale: AppLocaleSetting;
  onAppLocaleChange: (locale: AppLocaleSetting) => void;
  mediaAction: MediaAction;
  onMediaActionChange: (action: MediaAction) => void;
  autoUpdateEnabled: boolean;
  onAutoUpdateEnabledChange: (enabled: boolean) => void;
  storeBuild: boolean;
  autoLaunchEnabled: boolean;
  onAutoLaunchEnabledChange: (enabled: boolean) => void;
  startInBackground: boolean;
  onStartInBackgroundChange: (enabled: boolean) => void;
  autoDeleteTarget: AutoDeleteTarget;
  onAutoDeleteTargetChange: (target: AutoDeleteTarget) => void;
  autoDeleteDuration: RecordingPrunePolicy;
  onAutoDeleteDurationChange: (duration: RecordingPrunePolicy) => void;
  analyticsEnabled: boolean;
  onAnalyticsEnabledChange: (enabled: boolean) => void;
  platformCapabilities: PlatformCapabilities;
};

const AppTab = ({
  variants,
  micPermission,
  accessibilityPermission,
  inputMonitoringPermission,
  onRequestMicrophonePermission,
  textSizeMode,
  onTextSizeModeChange,
  themeMode,
  onThemeModeChange,
  appLocale,
  onAppLocaleChange,
  mediaAction,
  onMediaActionChange,
  autoUpdateEnabled,
  onAutoUpdateEnabledChange,
  storeBuild,
  autoLaunchEnabled,
  onAutoLaunchEnabledChange,
  startInBackground,
  onStartInBackgroundChange,
  autoDeleteTarget,
  onAutoDeleteTargetChange,
  autoDeleteDuration,
  onAutoDeleteDurationChange,
  analyticsEnabled,
  onAnalyticsEnabledChange,
  platformCapabilities,
}: AppTabProps) => {
  const { t } = useLingui();
  const [isPreviewingPrune, setIsPreviewingPrune] = useState(false);
  const [pendingPruneConfirmation, setPendingPruneConfirmation] =
    useState<PendingPruneConfirmation | null>(null);

  const duckStops: Array<{ label: string; value: MediaAction }> = [
    {
      label: t({ id: "settings.app.auto_pause_media.off", message: "Off" }),
      value: "off",
    },
    { label: "10%", value: "duck10" },
    { label: "25%", value: "duck25" },
    { label: "50%", value: "duck50" },
    { label: "75%", value: "duck75" },
    {
      label: t({ id: "settings.app.auto_pause_media.pause", message: "Pause" }),
      value: "pause",
    },
  ];
  const duckIndex = Math.max(
    0,
    duckStops.findIndex((stop) => stop.value === mediaAction),
  );
  const handleDuckChange = (index: number) => {
    onMediaActionChange(duckStops[index].value);
  };
  const handleDuckScrubStart = (
    event:
      React.MouseEvent<HTMLSpanElement> | React.TouchEvent<HTMLSpanElement>,
  ) => {
    event.preventDefault();
    const startX =
      "touches" in event ? event.touches[0].clientX : event.clientX;
    const initialIndex = duckIndex;
    let lastIndex = initialIndex;
    const handleMove = (e: MouseEvent | TouchEvent) => {
      const currentX =
        "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const steps = Math.round((currentX - startX) / 15);
      const nextIndex = Math.min(
        duckStops.length - 1,
        Math.max(0, initialIndex + steps),
      );
      if (nextIndex !== lastIndex) {
        lastIndex = nextIndex;
        handleDuckChange(nextIndex);
      }
    };
    const handleEnd = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleEnd);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleEnd);
    window.addEventListener("touchmove", handleMove, { passive: false });
    window.addEventListener("touchend", handleEnd);
  };
  const duckDescription =
    mediaAction === "off"
      ? t({
          id: "settings.app.auto_pause_media.body_off",
          message: "System audio plays while recording.",
        })
      : mediaAction === "pause"
        ? t({
            id: "settings.app.auto_pause_media.body_pause",
            message: "Pauses system audio while recording.",
          })
        : t({
            id: "settings.app.auto_pause_media.body_duck",
            message: "Lowers system volume while recording.",
          });

  const textSizeOptions: Array<{ value: TextSizeMode; label: string }> = [
    {
      value: "small",
      label: t({ id: "settings.app.text_size.small", message: "Small" }),
    },
    {
      value: "default",
      label: t({ id: "settings.app.text_size.default", message: "Default" }),
    },
    {
      value: "large",
      label: t({ id: "settings.app.text_size.large", message: "Large" }),
    },
  ];

  const themeOptions: Array<{ value: ThemeMode; label: string }> = [
    {
      value: "system",
      label: t({ id: "settings.app.theme.system", message: "System" }),
    },
    {
      value: "light",
      label: t({ id: "settings.app.theme.light", message: "Light" }),
    },
    {
      value: "dark",
      label: t({ id: "settings.app.theme.dark", message: "Dark" }),
    },
  ];

  const recordingPruneOptions: Array<{
    value: RecordingPrunePolicy;
    label: string;
  }> = [
    {
      value: "never",
      label: t({ id: "settings.app.prune.never", message: "Never" }),
    },
    {
      value: "immediately",
      label: t({ id: "settings.app.prune.instantly", message: "Instantly" }),
    },
    {
      value: "day",
      label: t({ id: "settings.app.prune.day", message: "A Day" }),
    },
    {
      value: "week",
      label: t({ id: "settings.app.prune.week", message: "A Week" }),
    },
    {
      value: "month",
      label: t({ id: "settings.app.prune.month", message: "A Month" }),
    },
    {
      value: "year",
      label: t({ id: "settings.app.prune.year", message: "A Year" }),
    },
  ];

  const pruneTargetOptions: Array<{ value: PruneTarget; label: string }> = [
    {
      value: "audio",
      label: t({ id: "settings.app.prune_target.audio", message: "Audio" }),
    },
    {
      value: "transcripts",
      label: t({
        id: "settings.app.prune_target.transcripts",
        message: "Transcripts",
      }),
    },
  ];

  const appLanguageOptions = buildAppLocaleOptions(
    t({
      id: "settings.app.language.system",
      message: "System",
    }),
  );

  const isMoreAggressivePolicy = (
    nextPolicy: RecordingPrunePolicy,
    currentPolicy: RecordingPrunePolicy,
  ) =>
    recordingPrunePolicySeverity[nextPolicy] >
    recordingPrunePolicySeverity[currentPolicy];

  const getRecordingPrunePolicyLabel = (policy: RecordingPrunePolicy) =>
    recordingPruneOptions.find((option) => option.value === policy)?.label ??
    policy;

  const describeRecordingPruneThreshold = (policy: RecordingPrunePolicy) => {
    switch (policy) {
      case "immediately":
        return t({
          id: "settings.app.prune.threshold.immediately",
          message: "right now",
        });
      case "day":
        return t({
          id: "settings.app.prune.threshold.day",
          message: "a day",
        });
      case "week":
        return t({
          id: "settings.app.prune.threshold.week",
          message: "a week",
        });
      case "month":
        return t({
          id: "settings.app.prune.threshold.month",
          message: "a month",
        });
      case "year":
        return t({
          id: "settings.app.prune.threshold.year",
          message: "a year",
        });
      case "never":
      default:
        return null;
    }
  };

  const buildPruneConfirmationMessage = (
    target: PruneTarget,
    duration: RecordingPrunePolicy,
    candidateCount: number | null,
  ) => {
    const policyLabel = getRecordingPrunePolicyLabel(duration);
    const noun =
      target === "audio"
        ? candidateCount === 1
          ? t({
              id: "settings.app.prune.noun.audio.one",
              message: "audio file",
            })
          : t({
              id: "settings.app.prune.noun.audio.other",
              message: "audio files",
            })
        : candidateCount === 1
          ? t({
              id: "settings.app.prune.noun.transcripts.one",
              message: "transcript",
            })
          : t({
              id: "settings.app.prune.noun.transcripts.other",
              message: "transcripts",
            });

    if (duration === "immediately") {
      if (candidateCount === null) {
        return t({
          id: "settings.app.auto_delete.confirm.immediately.unknown_count",
          message: `Changing auto-delete to ${{ policyLabel }} may immediately delete your existing ${{ noun }}.`,
        });
      }
      return t({
        id: "settings.app.auto_delete.confirm.immediately.known_count",
        message: `Changing auto-delete to ${{ policyLabel }} will immediately delete ${candidateCount} existing ${{ noun }}.`,
      });
    }

    const threshold = describeRecordingPruneThreshold(duration);
    if (!threshold) {
      return "";
    }

    if (candidateCount === null) {
      return t({
        id: "settings.app.auto_delete.confirm.threshold.unknown_count",
        message: `Changing auto-delete to ${{ policyLabel }} may immediately delete ${{ noun }} already older than ${{ threshold }}.`,
      });
    }

    return t({
      id: "settings.app.auto_delete.confirm.threshold.known_count",
      message: `Changing auto-delete to ${{ policyLabel }} will immediately delete ${candidateCount} ${{ noun }} already older than ${{ threshold }}.`,
    });
  };

  const applyAutoDeleteChange = async (
    nextTarget: PruneTarget,
    nextDuration: RecordingPrunePolicy,
  ) => {
    if (isPreviewingPrune) return;
    if (
      nextTarget === autoDeleteTarget &&
      nextDuration === autoDeleteDuration
    ) {
      return;
    }

    const nextRecordingPolicy = recordingPrunePolicyFor(
      nextTarget,
      nextDuration,
    );
    const nextTranscriptionPolicy = transcriptionPrunePolicyFor(
      nextTarget,
      nextDuration,
    );
    const currentRecordingPolicy = recordingPrunePolicyFor(
      autoDeleteTarget,
      autoDeleteDuration,
    );
    const currentTranscriptionPolicy = transcriptionPrunePolicyFor(
      autoDeleteTarget,
      autoDeleteDuration,
    );

    const recordingMoreAggressive = isMoreAggressivePolicy(
      nextRecordingPolicy,
      currentRecordingPolicy,
    );
    const transcriptionMoreAggressive = isMoreAggressivePolicy(
      nextTranscriptionPolicy,
      currentTranscriptionPolicy,
    );

    const commitChange = () => {
      onAutoDeleteTargetChange(nextTarget);
      onAutoDeleteDurationChange(nextDuration);
    };

    if (!recordingMoreAggressive && !transcriptionMoreAggressive) {
      commitChange();
      return;
    }

    setIsPreviewingPrune(true);
    try {
      let total = 0;
      let unknown = false;
      if (recordingMoreAggressive) {
        try {
          const preview = await invoke<RecordingPrunePreview>(
            "preview_recording_prune",
            { policy: nextRecordingPolicy },
          );
          total += preview.candidate_count;
        } catch (error) {
          console.error("Failed to preview recording prune impact", error);
          unknown = true;
        }
      }
      if (transcriptionMoreAggressive) {
        try {
          const preview = await invoke<RecordingPrunePreview>(
            "preview_transcription_prune",
            { policy: nextTranscriptionPolicy },
          );
          total += preview.candidate_count;
        } catch (error) {
          console.error("Failed to preview transcription prune impact", error);
          unknown = true;
        }
      }

      if (!unknown && total <= 0) {
        commitChange();
        return;
      }

      setPendingPruneConfirmation({
        target: nextTarget,
        duration: nextDuration,
        candidateCount: unknown ? null : total,
      });
    } finally {
      setIsPreviewingPrune(false);
    }
  };

  const handleConfirmPruneChange = () => {
    if (!pendingPruneConfirmation) {
      return;
    }
    onAutoDeleteTargetChange(pendingPruneConfirmation.target);
    onAutoDeleteDurationChange(pendingPruneConfirmation.duration);
    setPendingPruneConfirmation(null);
  };

  const handleClosePruneConfirmation = () => {
    setPendingPruneConfirmation(null);
  };

  const pruneConfirmationMessage = pendingPruneConfirmation
    ? buildPruneConfirmationMessage(
        pendingPruneConfirmation.target,
        pendingPruneConfirmation.duration,
        pendingPruneConfirmation.candidateCount,
      )
    : "";

  const pruneConfirmationFootnote =
    pendingPruneConfirmation?.candidateCount === null
      ? t({
          id: "settings.app.auto_delete.confirm.unknown_count",
          message:
            "We couldn't count them right now, but auto-delete will still run as soon as you save this change.",
        })
      : pendingPruneConfirmation?.target === "audio"
        ? t({
            id: "settings.app.auto_delete.confirm.audio_only",
            message:
              "This only removes saved audio files, not your transcripts.",
          })
        : t({
            id: "settings.app.auto_delete.confirm.audio_too",
            message:
              "Deleting transcripts also removes the audio they reference.",
          });

  const hasPermissionRows =
    platformCapabilities.requiresNativeMicrophonePermission ||
    platformCapabilities.requiresAccessibilityPermission ||
    platformCapabilities.requiresInputMonitoringPermission;

  return (
    <>
      <motion.div
        key="app"
        variants={variants}
        initial="hidden"
        animate="visible"
        exit="exit"
        className="space-y-6"
      >
        <div className="space-y-2">
          <SectionLabel>
            {t({
              id: "settings.app.appearance",
              message: "Appearance",
            })}
          </SectionLabel>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <span className="ui-text-label-strong ui-color-primary">
                {t({
                  id: "settings.app.text_size.label",
                  message: "Text Size",
                })}
              </span>
              <Dropdown
                value={textSizeMode}
                onChange={onTextSizeModeChange}
                options={textSizeOptions}
              />
            </div>
            <div className="space-y-1.5">
              <span className="ui-text-label-strong ui-color-primary">
                {t({
                  id: "settings.app.theme.label",
                  message: "Theme",
                })}
              </span>
              <Dropdown
                value={themeMode}
                onChange={onThemeModeChange}
                options={themeOptions}
              />
            </div>
            <div className="space-y-1.5">
              <span className="ui-text-label-strong ui-color-primary">
                {t({
                  id: "settings.app.language.label",
                  message: "Language",
                })}
              </span>
              <Dropdown
                value={appLocale}
                onChange={(value) => onAppLocaleChange(value)}
                options={appLanguageOptions}
                searchable
                searchPlaceholder={t({
                  id: "settings.app.language.search",
                  message: "Search language...",
                })}
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 items-stretch">
          <div className="space-y-2 flex flex-col">
            <SectionLabel className="shrink-0">
              {t({
                id: "settings.app.privacy_permissions",
                message: "Privacy & Permissions",
              })}
            </SectionLabel>

            {hasPermissionRows && (
              <div className="space-y-3 rounded-lg bg-surface-surface p-2.5">
                {platformCapabilities.requiresNativeMicrophonePermission && (
                  <div className="px-2 py-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="shrink-0 whitespace-nowrap ui-text-label-strong ui-color-primary">
                          {t({
                            id: "settings.app.microphone",
                            message: "Microphone",
                          })}
                        </span>
                        <span className="min-w-0 ui-text-meta ui-color-disabled">
                          {t({
                            id: "settings.app.microphone.description",
                            message: "required for transcription",
                          })}
                        </span>
                      </div>
                      <PermissionStatus granted={micPermission} />
                    </div>
                    <button
                      onClick={() => {
                        void onRequestMicrophonePermission();
                      }}
                      className="mt-1.5 ui-text-meta ui-color-muted hover:text-content-secondary transition-colors"
                    >
                      {t({
                        id: "settings.app.open_settings",
                        message: "Open Settings",
                      })}
                    </button>
                  </div>
                )}

                {platformCapabilities.requiresAccessibilityPermission && (
                  <div className="px-2 py-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="shrink-0 whitespace-nowrap ui-text-label-strong ui-color-primary">
                          {t({
                            id: "settings.app.accessibility",
                            message: "Accessibility",
                          })}
                        </span>
                        <span className="min-w-0 ui-text-meta ui-color-disabled">
                          {t({
                            id: "settings.app.accessibility.description",
                            message: "required for auto-paste",
                          })}
                        </span>
                      </div>
                      <PermissionStatus granted={accessibilityPermission} />
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          const granted =
                            await requestMacAccessibilityPermission();
                          if (!granted)
                            await invoke("open_accessibility_settings");
                        } catch {
                          await invoke("open_accessibility_settings");
                        }
                      }}
                      className="mt-1.5 ui-text-meta ui-color-muted hover:text-content-secondary transition-colors"
                    >
                      {t({
                        id: "settings.app.open_settings",
                        message: "Open Settings",
                      })}
                    </button>
                  </div>
                )}

                {platformCapabilities.requiresInputMonitoringPermission && (
                  <div className="px-2 py-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="shrink-0 whitespace-nowrap ui-text-label-strong ui-color-primary">
                          {t({
                            id: "settings.app.input_monitoring",
                            message: "Input Monitoring",
                          })}
                        </span>
                        <span className="min-w-0 ui-text-meta ui-color-disabled">
                          {t({
                            id: "settings.app.input_monitoring.description",
                            message: "required for global shortcuts",
                          })}
                        </span>
                      </div>
                      <PermissionStatus granted={inputMonitoringPermission} />
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          await requestMacInputMonitoringPermission();
                          const granted =
                            await checkMacInputMonitoringPermission();
                          if (!granted)
                            await invoke("open_input_monitoring_settings");
                        } catch {
                          await invoke("open_input_monitoring_settings");
                        }
                      }}
                      className="mt-1.5 ui-text-meta ui-color-muted hover:text-content-secondary transition-colors"
                    >
                      {t({
                        id: "settings.app.open_settings",
                        message: "Open Settings",
                      })}
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="rounded-lg bg-surface-surface p-2.5">
              <div className="px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="ui-text-label-strong ui-color-primary">
                    {t({
                      id: "settings.app.analytics",
                      message: "Usage Analytics",
                    })}
                  </span>
                  <ToggleSwitch
                    enabled={analyticsEnabled}
                    onToggle={() => onAnalyticsEnabledChange(!analyticsEnabled)}
                    ariaLabel={t({
                      id: "settings.app.analytics.toggle_aria",
                      message: "Toggle usage analytics",
                    })}
                  />
                </div>
                <span className="ui-text-micro ui-color-disabled block mt-0.5">
                  {t({
                    id: "settings.app.analytics.body",
                    message: "anonymous, no transcripts or audio shared.",
                  })}{" "}
                  <button
                    onClick={() =>
                      openUrl(
                        "https://github.com/glimpse-hq/Glimpse/wiki/Analytics",
                      )
                    }
                    className="ui-color-muted hover:text-content-secondary transition-colors underline"
                  >
                    {t({
                      id: "settings.app.analytics.more_info",
                      message: "More info",
                    })}
                  </button>
                </span>
              </div>
            </div>

            {hasPermissionRows && (
              <p className="ui-text-micro ui-color-disabled px-0.5">
                {t({
                  id: "settings.app.permissions_restart_notice",
                  message: "Permission changes may require a restart.",
                })}
              </p>
            )}
          </div>

          <div className="space-y-2 flex flex-col">
            <SectionLabel className="shrink-0">
              {t({
                id: "settings.app.automation",
                message: "Automation",
              })}
            </SectionLabel>

            <div className="flex-1 space-y-6 rounded-lg bg-surface-surface p-2.5">
              {platformCapabilities.supportsAutoPauseMedia && (
                <div className="px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="ui-text-label-strong ui-color-primary">
                      {t({
                        id: "settings.app.auto_pause_media",
                        message: "Auto-pause Media",
                      })}
                    </span>
                    <div className="flex items-center gap-0.5 ui-text-micro leading-none">
                      <button
                        type="button"
                        onClick={() =>
                          handleDuckChange(Math.max(0, duckIndex - 1))
                        }
                        disabled={duckIndex === 0}
                        aria-label={t({
                          id: "settings.app.auto_pause_media.lower",
                          message: "Previous media action",
                        })}
                        className={`transition-colors p-0.5 ${
                          duckIndex === 0
                            ? "text-content-disabled"
                            : "text-content-muted hover:text-content-primary"
                        }`}
                      >
                        <ChevronLeft size={10} />
                      </button>
                      <AnimatePresence mode="popLayout" initial={false}>
                        <motion.span
                          key={duckIndex}
                          initial={{ opacity: 0, y: -2, scale: 0.92 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 2, scale: 0.92 }}
                          transition={{ duration: 0.16, ease: "easeOut" }}
                          onMouseDown={handleDuckScrubStart}
                          onTouchStart={handleDuckScrubStart}
                          className={`w-[40px] min-w-[40px] text-center font-medium tabular-nums cursor-ew-resize select-none ${
                            mediaAction === "off"
                              ? "ui-color-disabled"
                              : "ui-color-cloud"
                          }`}
                        >
                          {duckStops[duckIndex].label}
                        </motion.span>
                      </AnimatePresence>
                      <button
                        type="button"
                        onClick={() =>
                          handleDuckChange(
                            Math.min(duckStops.length - 1, duckIndex + 1),
                          )
                        }
                        disabled={duckIndex === duckStops.length - 1}
                        aria-label={t({
                          id: "settings.app.auto_pause_media.raise",
                          message: "Next media action",
                        })}
                        className={`transition-colors p-0.5 ${
                          duckIndex === duckStops.length - 1
                            ? "text-content-disabled"
                            : "text-content-muted hover:text-content-primary"
                        }`}
                      >
                        <ChevronRight size={10} />
                      </button>
                    </div>
                  </div>
                  <span className="ui-text-micro ui-color-disabled block mt-0.5">
                    {duckDescription}
                  </span>
                </div>
              )}

              {!storeBuild && (
              <div className="px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="ui-text-label-strong ui-color-primary">
                    {t({
                      id: "settings.app.auto_update",
                      message: "Auto-update",
                    })}
                  </span>
                  <ToggleSwitch
                    enabled={autoUpdateEnabled}
                    onToggle={() =>
                      onAutoUpdateEnabledChange(!autoUpdateEnabled)
                    }
                    ariaLabel={t({
                      id: "settings.app.auto_update.toggle_aria",
                      message: "Toggle auto-update",
                    })}
                  />
                </div>
                <span className="ui-text-micro ui-color-disabled block mt-0.5">
                  {t({
                    id: "settings.app.auto_update.body",
                    message:
                      "downloads and installs updates in the background.",
                  })}
                </span>
              </div>
              )}

              <div className="px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="ui-text-label-strong ui-color-primary">
                    {t({
                      id: "settings.app.auto_launch",
                      message: "Launch at Login",
                    })}
                  </span>
                  <ToggleSwitch
                    enabled={autoLaunchEnabled}
                    onToggle={() =>
                      onAutoLaunchEnabledChange(!autoLaunchEnabled)
                    }
                    ariaLabel={t({
                      id: "settings.app.auto_launch.toggle_aria",
                      message: "Toggle launch at login",
                    })}
                  />
                </div>
                <div className="flex items-center justify-between gap-2 pl-3 mt-1.5">
                  <div className="flex items-center gap-1.5 ui-text-meta text-content-secondary">
                    <CornerDownRight
                      size={10}
                      className="text-content-disabled"
                      aria-hidden="true"
                    />
                    <span>
                      {t({
                        id: "settings.app.start_in_background",
                        message: "Start in background",
                      })}
                    </span>
                  </div>
                  <ToggleSwitch
                    enabled={autoLaunchEnabled && startInBackground}
                    disabled={!autoLaunchEnabled}
                    onToggle={() =>
                      onStartInBackgroundChange(!startInBackground)
                    }
                    ariaLabel={t({
                      id: "settings.app.start_in_background.toggle_aria",
                      message: "Toggle start in background",
                    })}
                    size="xs"
                  />
                </div>
              </div>
              <div className="relative px-2 py-1.5 overflow-visible">
                <div
                  className={
                    textSizeMode === "large"
                      ? "flex flex-wrap items-center gap-x-1 gap-y-1"
                      : "flex items-center gap-x-1 whitespace-nowrap"
                  }
                >
                  <span className="ui-text-label-strong ui-color-primary shrink-0">
                    {t({
                      id: "settings.app.auto_delete",
                      message: "Auto-delete",
                    })}
                  </span>
                  <div className="shrink-0">
                    <Dropdown
                      value={autoDeleteTarget}
                      onChange={(value) => {
                        void applyAutoDeleteChange(value, autoDeleteDuration);
                      }}
                      options={pruneTargetOptions}
                      disabled={isPreviewingPrune}
                      {...inlineAutoDeleteDropdownProps}
                    />
                  </div>
                  <span className="ui-text-label-strong ui-color-muted shrink-0">
                    {t({
                      id: "settings.app.auto_delete.after",
                      message: "after",
                    })}
                  </span>
                  <div className="shrink-0">
                    <Dropdown
                      value={autoDeleteDuration}
                      onChange={(value) => {
                        void applyAutoDeleteChange(autoDeleteTarget, value);
                      }}
                      options={recordingPruneOptions}
                      disabled={isPreviewingPrune}
                      {...inlineAutoDeleteDropdownProps}
                    />
                  </div>
                </div>
                <span className="ui-text-micro ui-color-disabled block mt-1">
                  {t({
                    id: "settings.app.auto_delete.body",
                    message:
                      "Deleting transcripts also removes their saved audio.",
                  })}
                </span>
              </div>
            </div>
            <p className="ui-text-micro px-0.5 invisible" aria-hidden="true">
              &nbsp;
            </p>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {pendingPruneConfirmation && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-xs px-6"
            onClick={handleClosePruneConfirmation}
          >
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl border border-red-500/30 bg-surface-tertiary p-5 ui-shadow-modal-deep"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={t({
                id: "settings.app.auto_delete.confirm.title",
                message: "Delete older items now?",
              })}
            >
              <div className="mb-3 flex items-start gap-3">
                <AlertTriangle
                  size={20}
                  className="mt-1 shrink-0 text-red-400"
                />
                <div className="min-w-0">
                  <p className="ui-text-body-lg font-semibold ui-color-error-strong leading-tight">
                    {t({
                      id: "settings.app.auto_delete.confirm.title",
                      message: "Delete older items now?",
                    })}
                  </p>
                  <p className="mt-1 ui-text-body text-content-primary leading-relaxed">
                    {pruneConfirmationMessage}
                  </p>
                </div>
              </div>
              <p className="ui-text-micro text-content-muted">
                {pruneConfirmationFootnote}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={handleClosePruneConfirmation}
                  className="rounded-lg border border-border-secondary px-4 py-2 ui-text-body-sm font-medium text-content-secondary hover:border-border-hover transition-colors"
                >
                  {t({
                    id: "settings.app.cancel",
                    message: "Cancel",
                  })}
                </button>
                <button
                  onClick={handleConfirmPruneChange}
                  className="rounded-lg bg-red-500/90 px-4 py-2 ui-text-body-sm font-semibold ui-color-on-solid hover:bg-red-500 transition-colors"
                >
                  {t({
                    id: "settings.app.auto_delete.confirm.apply",
                    message: "Apply anyway",
                  })}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default AppTab;
