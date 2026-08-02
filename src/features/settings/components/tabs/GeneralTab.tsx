import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  Broom as BrushCleaning,
  CaretRight as ChevronRight,
  Check,
  Ghost,
  Info,
  Microphone as Mic,
  Square,
  X,
} from "@phosphor-icons/react";
import SectionLabel from "../../../../shared/ui/SectionLabel";
import ToggleSwitch from "../../../../shared/ui/ToggleSwitch";
import { Dropdown } from "../../../../shared/ui/Dropdown";
import { formatShortcutForDisplay } from "../../../../shared/lib/shortcuts";
import type { DeviceInfo } from "../../../../types";
import type { TranscriptionLanguageOption } from "../../../../shared/lib/transcriptionLanguages";
import type { ShortcutBinding, ShortcutBindings } from "../../../../types";

type ShortcutMode = "smart" | "hold" | "toggle";
type CaptureMode = { mode: ShortcutMode; index: number } | null;
type InvalidShortcutDrafts = Partial<
  Record<ShortcutMode, Record<number, string>>
>;
type HelpTooltipId = "shortcuts";
type MicrophoneTestStatus = "idle" | "starting" | "listening" | "error";
type MicrophoneTestLevels = {
  left: number;
  right: number;
};

type GeneralTabProps = {
  variants: Variants;
  inputDevices: DeviceInfo[];
  microphoneDevice: string | null;
  onMicrophoneDeviceChange: (deviceId: string | null) => void;
  language: string;
  onLanguageChange: (language: string) => void;
  languages: TranscriptionLanguageOption[];
  smartEnabled: boolean;
  setSmartEnabled: (value: boolean) => void;
  holdEnabled: boolean;
  setHoldEnabled: (value: boolean) => void;
  toggleEnabled: boolean;
  setToggleEnabled: (value: boolean) => void;
  shortcutBindings: ShortcutBindings;
  invalidShortcutDrafts: InvalidShortcutDrafts;
  captureActive: CaptureMode;
  capturePreview: string;
  onStartCapture: (mode: ShortcutMode, index?: number) => void;
  updateShortcutBinding: (
    mode: ShortcutMode,
    index: number,
    patch: Partial<ShortcutBinding>,
  ) => void;
  addShortcutBinding: (mode: ShortcutMode) => void;
  removeShortcutBinding: (mode: ShortcutMode, index: number) => void;
  autoDictionaryEnabled: boolean;
  autoDictionarySupported: boolean;
  setAutoDictionaryEnabled: (value: boolean) => void;
  aiFeaturesReady: boolean;
  licenseGateActive: boolean;
  onOpenAccountTab: () => void;
  onOpenProvidersTab: () => void;
};

const GeneralTab = ({
  variants,
  inputDevices,
  microphoneDevice,
  onMicrophoneDeviceChange,
  language,
  onLanguageChange,
  languages,
  smartEnabled,
  setSmartEnabled,
  holdEnabled,
  setHoldEnabled,
  toggleEnabled,
  setToggleEnabled,
  shortcutBindings,
  invalidShortcutDrafts,
  captureActive,
  capturePreview,
  onStartCapture,
  updateShortcutBinding,
  addShortcutBinding,
  removeShortcutBinding,
  autoDictionaryEnabled,
  autoDictionarySupported,
  setAutoDictionaryEnabled,
  aiFeaturesReady,
  licenseGateActive,
  onOpenAccountTab,
  onOpenProvidersTab,
}: GeneralTabProps) => {
  const { t } = useLingui();
  const [openHelpTooltip, setOpenHelpTooltip] = useState<HelpTooltipId | null>(
    null,
  );
  const [expandedShortcut, setExpandedShortcut] = useState<ShortcutMode | null>(
    null,
  );
  const [micDropdownOpen, setMicDropdownOpen] = useState(false);
  const [languageDropdownOpen, setLanguageDropdownOpen] = useState(false);
  const deviceRowElevated = micDropdownOpen || languageDropdownOpen;
  const {
    activeDeviceLabel,
    error: microphoneTestError,
    levels: microphoneTestLevels,
    reset: resetMicrophoneTest,
    start: startMicrophoneTest,
    status: microphoneTestStatus,
  } = useMicrophoneTest(inputDevices, microphoneDevice);
  const aiFeaturesDisabled = !aiFeaturesReady;
  const cleanupNeedsLicense = !licenseGateActive;
  const autoDictionaryBody = autoDictionarySupported
    ? t({
        id: "settings.general.auto_dictionary.body",
        message: "suggests names and terms after you correct dictated text",
      })
    : t({
        id: "settings.general.auto_dictionary.unsupported_body",
        message: "requires a model with dictionary support",
      });
  const systemDefaultLabel = t({
    id: "settings.general.system_default",
    message: "System Default",
  });

  const showHelpTooltip = (tooltip: HelpTooltipId) => {
    setOpenHelpTooltip(tooltip);
  };

  const hideHelpTooltip = (tooltip: HelpTooltipId) => {
    setOpenHelpTooltip((current) => (current === tooltip ? null : current));
  };

  const toggleHelpTooltip = (tooltip: HelpTooltipId) => {
    setOpenHelpTooltip((current) => (current === tooltip ? null : tooltip));
  };

  const isMicrophoneTestActive =
    microphoneTestStatus === "starting" || microphoneTestStatus === "listening";

  const handleMicrophoneTestButton = () => {
    if (isMicrophoneTestActive || microphoneTestStatus === "error") {
      resetMicrophoneTest();
      return;
    }

    void startMicrophoneTest();
  };

  return (
    <motion.div
      key="general"
      variants={variants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="space-y-6"
    >
      <div
        className={`grid grid-cols-2 gap-3${deviceRowElevated ? " relative z-dropdown-open" : ""}`}
      >
        <div className="space-y-1.5">
          <div className="flex h-5 items-center justify-between gap-2">
            <label className="ui-text-label-strong ui-color-primary leading-none">
              {t({
                id: "settings.general.microphone",
                message: "Microphone",
              })}
            </label>
            <button
              type="button"
              onClick={handleMicrophoneTestButton}
              className={`flex h-5 items-center gap-1 rounded-md px-1.5 ui-text-meta transition-colors ${
                isMicrophoneTestActive
                  ? "ui-color-error hover:bg-error/10"
                  : "ui-color-muted hover:bg-surface-elevated hover:text-content-primary"
              }`}
            >
              {isMicrophoneTestActive ? (
                <>
                  <Square size={9} fill="currentColor" aria-hidden="true" />
                  {t({
                    id: "settings.general.microphone_test.stop",
                    message: "Stop",
                  })}
                </>
              ) : microphoneTestStatus === "error" ? (
                <>
                  <Check size={10} aria-hidden="true" />
                  {t({
                    id: "settings.general.microphone_test.done",
                    message: "Done",
                  })}
                </>
              ) : (
                <>
                  <Mic size={10} aria-hidden="true" />
                  {t({
                    id: "settings.general.microphone_test.test",
                    message: "Test",
                  })}
                </>
              )}
            </button>
          </div>
          <div className="h-[38px]">
            {microphoneTestStatus === "listening" ||
            microphoneTestStatus === "error" ? (
              <MicrophoneTestSlot
                status={microphoneTestStatus}
                levels={microphoneTestLevels}
                label={
                  activeDeviceLabel ??
                  getSelectedMicrophoneName(inputDevices, microphoneDevice) ??
                  systemDefaultLabel
                }
                error={microphoneTestError}
              />
            ) : (
              <Dropdown
                value={microphoneDevice || ""}
                onChange={(val) =>
                  onMicrophoneDeviceChange(val === "" ? null : val)
                }
                onOpenChange={setMicDropdownOpen}
                options={[
                  {
                    value: "",
                    label: systemDefaultLabel,
                  },
                  ...inputDevices.map((device) => ({
                    value: device.id,
                    label: device.name,
                  })),
                ]}
                placeholder={t({
                  id: "settings.general.select_microphone",
                  message: "Select microphone...",
                })}
                className="h-[38px]"
                buttonClassName="h-[38px] px-3 py-2 ui-text-body-sm"
                menuClassName="top-[38px]"
              />
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex h-5 items-center">
            <div className="flex items-center gap-1">
              <label className="ui-text-label-strong ui-color-primary leading-none">
                {t({
                  id: "settings.general.transcription_language",
                  message: "Transcription Language",
                })}
              </label>
              <div className="relative group">
                <button
                  className="flex h-4 w-4 items-center justify-center text-content-disabled hover:text-content-muted transition-colors"
                  aria-label={t({
                    id: "settings.general.language_info_aria",
                    message:
                      "More information about transcription language support",
                  })}
                >
                  <Info size={10} aria-hidden="true" />
                </button>
                <div className="absolute right-0 top-full mt-1.5 hidden group-hover:block group-focus-within:block z-tooltip">
                  <div className="ui-surface-menu w-56 px-2.5 py-1.5 ui-text-micro ui-color-secondary leading-tight">
                    <p>
                      {t({
                        id: "settings.general.language_info.active_model",
                        message:
                          "Unsupported languages aren't available on your active model. Switch to a supported model to use them.",
                      })}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div>
            <Dropdown
              value={language}
              onChange={(val) => onLanguageChange(val)}
              onOpenChange={setLanguageDropdownOpen}
              options={languages.map((lang) => ({
                value: lang.code,
                label: lang.name,
                locked: lang.locked,
                isHeader: lang.isHeader,
                prominentHeader: lang.prominentHeader,
                description: lang.description,
              }))}
              searchable
              searchPlaceholder={t({
                id: "settings.general.search_language",
                message: "Search language...",
              })}
              buttonClassName="min-h-[38px] px-3 py-2 ui-text-body-sm"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <SectionLabel
            trailing={
              <div
                className="relative"
                onMouseEnter={() => showHelpTooltip("shortcuts")}
                onMouseLeave={() => hideHelpTooltip("shortcuts")}
              >
                <button
                  type="button"
                  className="flex h-4 w-4 items-center justify-center text-content-disabled transition-colors hover:text-content-muted"
                  aria-label={t({
                    id: "settings.general.shortcuts.info_aria",
                    message: "More information about shortcut options",
                  })}
                  aria-expanded={openHelpTooltip === "shortcuts"}
                  aria-controls="shortcuts-help-tooltip"
                  onFocus={() => showHelpTooltip("shortcuts")}
                  onBlur={() => hideHelpTooltip("shortcuts")}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      hideHelpTooltip("shortcuts");
                    }
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleHelpTooltip("shortcuts");
                    }
                  }}
                >
                  <Info size={10} aria-hidden="true" />
                </button>
                <div
                  id="shortcuts-help-tooltip"
                  role="tooltip"
                  className={`absolute left-0 top-full mt-1.5 z-tooltip ${
                    openHelpTooltip === "shortcuts" ? "block" : "hidden"
                  }`}
                >
                  <div className="w-64 rounded-lg border border-border-secondary bg-surface-overlay px-2.5 py-2 ui-text-micro ui-color-secondary shadow-lg leading-snug">
                    <p>
                      <Ghost
                        size={10}
                        className="mr-1 inline-block align-[-1px]"
                        aria-hidden="true"
                      />
                      {t({
                        id: "settings.general.shortcuts.help_temporary",
                        message:
                          "Makes a shortcut temporary. It will not save audio, transcript, or history.",
                      })}
                    </p>
                    <p className="mt-1">
                      <BrushCleaning
                        size={10}
                        className="mr-1 inline-block align-[-1px]"
                        aria-hidden="true"
                      />
                      {t({
                        id: "settings.general.shortcuts.help_writing",
                        message:
                          "Uses the writing model for that shortcut only. It tidies what you dictate, and rewrites selected text when you speak an instruction.",
                      })}
                    </p>
                  </div>
                </div>
              </div>
            }
          >
            {t({
              id: "settings.general.shortcuts",
              message: "Shortcuts",
            })}
          </SectionLabel>

          <div className="relative space-y-3 rounded-lg bg-surface-surface p-2.5">
            <ShortcutRow
              mode="smart"
              isExpanded={expandedShortcut === "smart"}
              onToggleExpand={() =>
                setExpandedShortcut(
                  expandedShortcut === "smart" ? null : "smart",
                )
              }
              label={t({
                id: "settings.general.shortcuts.smart",
                message: "Smart",
              })}
              description={t({
                id: "settings.general.shortcuts.smart_description",
                message: "tap to toggle, hold to talk",
              })}
              bindings={shortcutBindings.smart}
              invalidDrafts={invalidShortcutDrafts.smart}
              enabled={smartEnabled}
              captureActive={captureActive}
              capturePreview={capturePreview}
              onToggle={() => {
                if (!smartEnabled && !holdEnabled && !toggleEnabled) return;
                setSmartEnabled(!smartEnabled);
              }}
              onCapture={(index) => {
                if (!smartEnabled) return;
                onStartCapture("smart", index);
              }}
              onUpdateBinding={updateShortcutBinding}
              onAddBinding={addShortcutBinding}
              onRemoveBinding={removeShortcutBinding}
              canDisable={holdEnabled || toggleEnabled}
              cleanupDisabled={aiFeaturesDisabled}
            />
            <ShortcutRow
              mode="hold"
              isExpanded={expandedShortcut === "hold"}
              onToggleExpand={() =>
                setExpandedShortcut(expandedShortcut === "hold" ? null : "hold")
              }
              label={t({
                id: "settings.general.shortcuts.hold",
                message: "Hold",
              })}
              description={t({
                id: "settings.general.shortcuts.hold_description",
                message: "hold to talk, release to stop",
              })}
              bindings={shortcutBindings.hold}
              invalidDrafts={invalidShortcutDrafts.hold}
              enabled={holdEnabled}
              captureActive={captureActive}
              capturePreview={capturePreview}
              onToggle={() => {
                if (!holdEnabled && !toggleEnabled && !smartEnabled) return;
                setHoldEnabled(!holdEnabled);
              }}
              onCapture={(index) => {
                if (!holdEnabled) return;
                onStartCapture("hold", index);
              }}
              onUpdateBinding={updateShortcutBinding}
              onAddBinding={addShortcutBinding}
              onRemoveBinding={removeShortcutBinding}
              canDisable={smartEnabled || toggleEnabled}
              cleanupDisabled={aiFeaturesDisabled}
            />
            <ShortcutRow
              mode="toggle"
              isExpanded={expandedShortcut === "toggle"}
              onToggleExpand={() =>
                setExpandedShortcut(
                  expandedShortcut === "toggle" ? null : "toggle",
                )
              }
              label={t({
                id: "settings.general.shortcuts.toggle",
                message: "Toggle",
              })}
              description={t({
                id: "settings.general.shortcuts.toggle_description",
                message: "tap to start, tap to stop",
              })}
              bindings={shortcutBindings.toggle}
              invalidDrafts={invalidShortcutDrafts.toggle}
              enabled={toggleEnabled}
              captureActive={captureActive}
              capturePreview={capturePreview}
              onToggle={() => {
                if (!toggleEnabled && !holdEnabled && !smartEnabled) return;
                setToggleEnabled(!toggleEnabled);
              }}
              onCapture={(index) => {
                if (!toggleEnabled) return;
                onStartCapture("toggle", index);
              }}
              onUpdateBinding={updateShortcutBinding}
              onAddBinding={addShortcutBinding}
              onRemoveBinding={removeShortcutBinding}
              canDisable={smartEnabled || holdEnabled}
              cleanupDisabled={aiFeaturesDisabled}
            />
          </div>

          {aiFeaturesDisabled && (
            <p className="ui-text-meta ui-color-muted px-0.5">
              <BrushCleaning
                size={10}
                className="me-1 inline-block align-[-1px]"
                aria-hidden="true"
              />
              {cleanupNeedsLicense
                ? t({
                    id: "settings.general.shortcuts.cleanup_locked.license_prefix",
                    message: "Cleanup needs a license. Activate it in",
                  })
                : t({
                    id: "settings.general.shortcuts.cleanup_locked.provider_prefix",
                    message: "Cleanup needs a writing model. Set one up in",
                  })}{" "}
              <button
                type="button"
                onClick={
                  cleanupNeedsLicense ? onOpenAccountTab : onOpenProvidersTab
                }
                className="ui-color-primary underline underline-offset-2 decoration-[var(--color-border-secondary)] hover:decoration-[var(--color-text-primary)] transition-colors"
              >
                {cleanupNeedsLicense
                  ? t({
                      id: "settings.general.shortcuts.cleanup_locked.account_link",
                      message: "Account",
                    })
                  : t({
                      id: "settings.general.shortcuts.cleanup_locked.providers_link",
                      message: "Providers",
                    })}
              </button>
            </p>
          )}
        </div>

        <div className="space-y-2">
          <SectionLabel>
            {t({
              id: "settings.general.features",
              message: "Features",
            })}
          </SectionLabel>

          <div className="space-y-3">
            <div className="rounded-lg bg-surface-surface">
              <div className="py-2 px-2.5">
                <div className="flex items-center justify-between">
                  <span className="ui-text-label-strong ui-color-primary">
                    {t({
                      id: "settings.general.auto_dictionary",
                      message: "Auto Dictionary",
                    })}
                  </span>
                  <ToggleSwitch
                    enabled={autoDictionarySupported && autoDictionaryEnabled}
                    disabled={!autoDictionarySupported}
                    onToggle={() => {
                      if (autoDictionarySupported) {
                        setAutoDictionaryEnabled(!autoDictionaryEnabled);
                      }
                    }}
                    ariaLabel={t({
                      id: "settings.general.auto_dictionary.toggle_aria",
                      message: "Toggle Auto Dictionary",
                    })}
                  />
                </div>
                <span className="ui-text-meta ui-color-muted block mt-0.5">
                  {autoDictionaryBody}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

const MICROPHONE_TEST_DOT_COLS = 32;
const MICROPHONE_TEST_DOT_SIZE = 2;
const MICROPHONE_TEST_DOT_GAP = 2;
const MICROPHONE_TEST_DOT_WIDTH =
  MICROPHONE_TEST_DOT_COLS * MICROPHONE_TEST_DOT_SIZE +
  (MICROPHONE_TEST_DOT_COLS - 1) * MICROPHONE_TEST_DOT_GAP;
const EMPTY_MICROPHONE_TEST_LEVELS = { left: 0, right: 0 };
const MICROPHONE_TEST_UPDATE_INTERVAL_MS = 24;

type MicrophoneTestSlotProps = {
  status: MicrophoneTestStatus;
  levels: MicrophoneTestLevels;
  label: string;
  error: string | null;
};

const MicrophoneTestSlot = ({
  status,
  levels,
  label,
  error,
}: MicrophoneTestSlotProps) => {
  const { t } = useLingui();

  if (status === "error") {
    return (
      <div className="flex h-[38px] items-center rounded-lg border border-error/30 bg-error/5 px-3">
        <p className="ui-text-meta ui-color-error truncate">
          {error ??
            t({
              id: "settings.general.microphone_test.generic_error",
              message: "Couldn't start microphone test.",
            })}
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex h-[38px] items-center gap-2 rounded-lg border border-border-primary bg-surface-surface px-3"
      aria-live="polite"
    >
      <span
        className="min-w-0 flex-1 truncate ui-text-meta ui-color-muted"
        title={label}
      >
        {label}
      </span>
      <MicrophoneLevelMeter levels={levels} />
    </div>
  );
};

type MicrophoneLevelMeterProps = {
  levels: MicrophoneTestLevels;
};

const MicrophoneLevelMeter = ({ levels }: MicrophoneLevelMeterProps) => (
  <div
    className="ml-auto grid shrink-0 place-items-center overflow-hidden"
    style={{
      gridTemplateColumns: `repeat(${MICROPHONE_TEST_DOT_COLS}, ${MICROPHONE_TEST_DOT_SIZE}px)`,
      gap: MICROPHONE_TEST_DOT_GAP,
      width: MICROPHONE_TEST_DOT_WIDTH,
    }}
  >
    {[levels.left, levels.right].flatMap((level, row) =>
      Array.from({ length: MICROPHONE_TEST_DOT_COLS }, (_, col) => {
        const active = col < levelToDotCount(level);
        return (
          <div
            key={`${row}-${col}`}
            style={{
              width: MICROPHONE_TEST_DOT_SIZE,
              height: MICROPHONE_TEST_DOT_SIZE,
              backgroundColor: getMicrophoneDotColor(col),
              opacity: active ? 0.95 : 0.16,
              borderRadius: active ? 0.5 : "50%",
              transition:
                "border-radius 0.18s ease-out, opacity 0.18s ease-out",
            }}
          />
        );
      }),
    )}
  </div>
);

const levelToDotCount = (level: number) =>
  Math.min(
    MICROPHONE_TEST_DOT_COLS,
    Math.round(level * MICROPHONE_TEST_DOT_COLS),
  );

const getMicrophoneDotColor = (col: number) => {
  if (col < 5) return "var(--color-warning)";
  if (col >= MICROPHONE_TEST_DOT_COLS - 4) return "var(--color-error)";
  return "var(--color-success)";
};

const getSelectedMicrophoneName = (
  inputDevices: DeviceInfo[],
  microphoneDevice: string | null,
) => {
  if (!microphoneDevice) return null;
  return (
    inputDevices.find((device) => device.id === microphoneDevice)?.name ?? null
  );
};

const useMicrophoneTest = (
  inputDevices: DeviceInfo[],
  microphoneDevice: string | null,
) => {
  const { t } = useLingui();
  const [status, setStatus] = useState<MicrophoneTestStatus>("idle");
  const [levels, setLevels] = useState<MicrophoneTestLevels>(
    EMPTY_MICROPHONE_TEST_LEVELS,
  );
  const [error, setError] = useState<string | null>(null);
  const [activeDeviceLabel, setActiveDeviceLabel] = useState<string | null>(
    null,
  );
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const smoothedLevelsRef = useRef<MicrophoneTestLevels>(
    EMPTY_MICROPHONE_TEST_LEVELS,
  );
  const runIdRef = useRef(0);

  const releaseResources = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }, []);

  const clearMeterState = useCallback(() => {
    smoothedLevelsRef.current = EMPTY_MICROPHONE_TEST_LEVELS;
    setLevels(EMPTY_MICROPHONE_TEST_LEVELS);
    setActiveDeviceLabel(null);
  }, []);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    releaseResources();
    setStatus("idle");
    clearMeterState();
    setError(null);
  }, [clearMeterState, releaseResources]);

  const start = useCallback(async () => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      setStatus("error");
      setError(
        t({
          id: "settings.general.microphone_test.unsupported",
          message: "Microphone testing isn't available in this window.",
        }),
      );
      return;
    }

    runIdRef.current += 1;
    const runId = runIdRef.current;
    releaseResources();
    setStatus("starting");
    clearMeterState();
    setError(null);

    let stream: MediaStream | null = null;

    try {
      const selectedDeviceName = getSelectedMicrophoneName(
        inputDevices,
        microphoneDevice,
      );

      stream = await mediaDevices.getUserMedia({ audio: true });

      if (runIdRef.current !== runId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const matchedDeviceId = await findBrowserMicrophoneDeviceId(
        mediaDevices,
        selectedDeviceName,
      );

      if (matchedDeviceId) {
        let selectedStream: MediaStream | null = null;
        try {
          selectedStream = await mediaDevices.getUserMedia({
            audio: { deviceId: { exact: matchedDeviceId } },
          });

          if (runIdRef.current !== runId) {
            selectedStream.getTracks().forEach((track) => track.stop());
            stream.getTracks().forEach((track) => track.stop());
            return;
          }

          stream.getTracks().forEach((track) => track.stop());
          stream = selectedStream;
          selectedStream = null;
        } catch (err) {
          selectedStream?.getTracks().forEach((track) => track.stop());
          stream?.getTracks().forEach((track) => track.stop());
          stream = null;
          throw err;
        }
      }

      const AudioContextCtor =
        window.AudioContext ??
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;

      if (!AudioContextCtor) {
        throw new Error("AudioContext is not available");
      }

      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const leftAnalyser = audioContext.createAnalyser();
      const rightAnalyser = audioContext.createAnalyser();
      const splitter = audioContext.createChannelSplitter(2);
      const channelCount =
        stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1;
      leftAnalyser.fftSize = 128;
      rightAnalyser.fftSize = 128;
      leftAnalyser.smoothingTimeConstant = 0.12;
      rightAnalyser.smoothingTimeConstant = 0.12;
      source.connect(splitter);
      splitter.connect(leftAnalyser, 0);
      splitter.connect(rightAnalyser, channelCount > 1 ? 1 : 0);

      streamRef.current = stream;
      audioContextRef.current = audioContext;
      const displayLabel =
        stream.getAudioTracks()[0]?.label || selectedDeviceName;
      setActiveDeviceLabel(displayLabel);
      setStatus("listening");

      const leftData = new Uint8Array(leftAnalyser.fftSize);
      const rightData = new Uint8Array(rightAnalyser.fftSize);
      let lastUpdate = 0;

      const updateLevel = (now: number) => {
        leftAnalyser.getByteTimeDomainData(leftData);
        rightAnalyser.getByteTimeDomainData(rightData);

        if (now - lastUpdate > MICROPHONE_TEST_UPDATE_INTERVAL_MS) {
          smoothedLevelsRef.current = smoothMicrophoneLevels(
            smoothedLevelsRef.current,
            {
              left: calculateMicrophoneLevel(leftData),
              right: calculateMicrophoneLevel(rightData),
            },
          );
          setLevels(smoothedLevelsRef.current);
          lastUpdate = now;
        }

        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };

      animationFrameRef.current = requestAnimationFrame(updateLevel);
    } catch (err) {
      stream?.getTracks().forEach((track) => track.stop());
      if (runIdRef.current !== runId) return;
      releaseResources();
      clearMeterState();
      setStatus("error");
      setError(t(formatMicrophoneTestError(err)));
    }
  }, [clearMeterState, inputDevices, microphoneDevice, releaseResources, t]);

  useEffect(() => releaseResources, [releaseResources]);

  return {
    activeDeviceLabel,
    error,
    levels,
    reset,
    start,
    status,
  };
};

const smoothMicrophoneLevels = (
  previous: MicrophoneTestLevels,
  target: MicrophoneTestLevels,
) => ({
  left: smoothMicrophoneLevel(previous.left, target.left),
  right: smoothMicrophoneLevel(previous.right, target.right),
});

const smoothMicrophoneLevel = (previous: number, target: number) => {
  const factor = target > previous ? 0.78 : 0.32;
  const next = previous + (target - previous) * factor;
  return next < 0.02 ? 0 : next;
};

const calculateMicrophoneLevel = (data: Uint8Array) => {
  let sum = 0;
  for (const sample of data) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }

  const noiseFloor = 0.012;
  const speechCeiling = 0.18;
  const rms = Math.sqrt(sum / data.length);
  const normalized =
    Math.max(0, rms - noiseFloor) / (speechCeiling - noiseFloor);

  return Math.min(1, Math.pow(normalized, 0.72));
};

const findBrowserMicrophoneDeviceId = async (
  mediaDevices: MediaDevices,
  selectedDeviceName: string | null,
) => {
  if (!selectedDeviceName || !mediaDevices.enumerateDevices) return null;

  const browserDevices = await mediaDevices.enumerateDevices();
  const selectedName = normalizeMicrophoneLabel(selectedDeviceName);
  if (!selectedName) return null;

  const match = browserDevices.find((device) => {
    if (device.kind !== "audioinput" || !device.deviceId || !device.label) {
      return false;
    }

    const browserLabel = normalizeMicrophoneLabel(device.label);
    return (
      browserLabel.includes(selectedName) || selectedName.includes(browserLabel)
    );
  });

  return match?.deviceId ?? null;
};

const normalizeMicrophoneLabel = (label: string) =>
  label
    .toLowerCase()
    .replace(/^default\s*[-:]\s*/, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

const formatMicrophoneTestError = (err: unknown) => {
  if (err instanceof DOMException) {
    if (
      err.name === "NotAllowedError" ||
      err.name === "PermissionDeniedError"
    ) {
      return msg({
        id: "settings.general.microphone_test.permission_error",
        message: "Microphone access was denied.",
      });
    }

    if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      return msg({
        id: "settings.general.microphone_test.not_found_error",
        message: "No microphone was found.",
      });
    }

    if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      return msg({
        id: "settings.general.microphone_test.busy_error",
        message: "That microphone is already in use.",
      });
    }
  }

  return msg({
    id: "settings.general.microphone_test.start_error",
    message: "Couldn't start microphone test.",
  });
};

const ShortcutBindingsList = ({
  mode,
  bindings,
  invalidDrafts,
  enabled,
  isExpanded,
  captureActive,
  capturePreview,
  onCapture,
  onToggleExpand,
  onUpdateBinding,
  onAddBinding,
  onRemoveBinding,
  cleanupDisabled,
}: {
  mode: ShortcutMode;
  bindings: ShortcutBinding[];
  invalidDrafts?: Record<number, string>;
  enabled: boolean;
  isExpanded: boolean;
  captureActive: CaptureMode;
  capturePreview: string;
  onCapture: (index: number) => void;
  onToggleExpand: () => void;
  onUpdateBinding: (
    mode: ShortcutMode,
    index: number,
    patch: Partial<ShortcutBinding>,
  ) => void;
  onAddBinding: (mode: ShortcutMode) => void;
  onRemoveBinding: (mode: ShortcutMode, index: number) => void;
  cleanupDisabled: boolean;
}) => {
  const { t } = useLingui();
  const addShortcutLabel = t({
    id: "settings.general.shortcuts.add_shortcut",
    message: "+ Add shortcut",
  });
  const temporaryLabel = t({
    id: "settings.general.shortcuts.temporary",
    message: "Temporary",
  });
  const cleanupLabel = t({
    id: "settings.general.shortcuts.cleanup",
    message: "Cleanup",
  });
  const visibleBindings =
    bindings.length > 0
      ? bindings
      : [{ shortcut: "", temporary: false, cleanup_enabled: false }];
  const primaryBinding = visibleBindings[0];
  const primaryInvalid = Boolean(invalidDrafts?.[0]);
  const alternateCount = Math.max(visibleBindings.length - 1, 0);
  const canAdd = visibleBindings.length < 3;
  const primaryCapturing =
    captureActive?.mode === mode && captureActive.index === 0;
  const primaryDisplay = primaryBinding.shortcut
    ? formatShortcutForDisplay(primaryBinding.shortcut)
    : addShortcutLabel;

  return (
    <div className="w-full">
      <div
        className={`flex min-h-7 items-center gap-1.5 border-b py-1 ui-text-kbd transition-colors ${
          primaryCapturing
            ? "border-border-hover ui-color-primary"
            : primaryInvalid
              ? "border-error/40 ui-color-error"
              : enabled
                ? "border-border-primary ui-color-secondary hover:border-border-secondary"
                : "border-border-primary ui-color-disabled"
        }`}
      >
        <button
          type="button"
          onClick={() => onCapture(0)}
          className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${
            enabled ? "hover:text-content-primary" : ""
          }`}
        >
          {primaryCapturing ? (
            <>
              <motion.span
                className="h-1 w-1 rounded-full bg-cloud"
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 1, repeat: Infinity }}
              />
              <span
                className={`truncate ${
                  capturePreview ? "ui-color-primary" : "ui-color-muted"
                }`}
              >
                {capturePreview || "..."}
              </span>
            </>
          ) : (
            <span className="truncate">{primaryDisplay}</span>
          )}
        </button>

        <ShortcutIconToggle
          label={temporaryLabel}
          tone="local"
          active={primaryBinding.temporary}
          disabled={false}
          onClick={() =>
            onUpdateBinding(mode, 0, {
              temporary: !primaryBinding.temporary,
            })
          }
        >
          <Ghost size={13} aria-hidden="true" />
        </ShortcutIconToggle>
        <ShortcutIconToggle
          label={cleanupLabel}
          tone="cloud"
          active={primaryBinding.cleanup_enabled}
          disabled={cleanupDisabled}
          onClick={() =>
            onUpdateBinding(mode, 0, {
              cleanup_enabled: !primaryBinding.cleanup_enabled,
            })
          }
        >
          <BrushCleaning size={13} aria-hidden="true" />
        </ShortcutIconToggle>

        {(alternateCount > 0 || canAdd) && (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? t({
                    id: "settings.general.shortcuts.hide_shortcuts",
                    message: "Hide shortcuts",
                  })
                : t({
                    id: "settings.general.shortcuts.show_shortcuts",
                    message: "Show shortcuts",
                  })
            }
            className="flex w-10 shrink-0 items-center justify-center gap-1 rounded px-1.5 py-0.5 ui-text-meta ui-color-muted transition-colors hover:bg-surface-overlay hover:ui-color-secondary"
          >
            <span className="flex w-5 items-center justify-center">
              <motion.span
                initial={false}
                animate={{ x: alternateCount > 0 ? -2 : 0 }}
                transition={{ duration: 0.14, ease: "easeOut" }}
              >
                +
              </motion.span>
              <span className="relative ml-0.5 inline-flex h-3 w-1.5 overflow-hidden">
                {[1, 2].map((count) => (
                  <motion.span
                    key={count}
                    initial={false}
                    className="absolute inset-0 flex items-center justify-start"
                    animate={{
                      opacity: alternateCount === count ? 1 : 0,
                      y:
                        alternateCount === count
                          ? 0
                          : alternateCount > count
                            ? -3
                            : 3,
                    }}
                    transition={{ duration: 0.12, ease: "easeOut" }}
                  >
                    {count}
                  </motion.span>
                ))}
              </span>
            </span>
            <motion.span
              initial={false}
              animate={{ rotate: isExpanded ? 90 : 0 }}
              transition={{ duration: 0.15 }}
              className="flex items-center"
            >
              <ChevronRight size={12} aria-hidden="true" />
            </motion.span>
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="space-y-1 pt-1">
              {visibleBindings.slice(1).map((binding, offset) => {
                const index = offset + 1;
                const isCapturing =
                  captureActive?.mode === mode && captureActive.index === index;
                const isInvalid = Boolean(invalidDrafts?.[index]);
                const displayShortcut = binding.shortcut
                  ? formatShortcutForDisplay(binding.shortcut)
                  : addShortcutLabel;

                return (
                  <div
                    key={`${mode}-${index}`}
                    className={`flex min-h-7 items-center gap-1.5 border-b py-1 ui-text-kbd transition-colors ${
                      isCapturing
                        ? "border-border-hover ui-color-primary"
                        : isInvalid
                          ? "border-error/40 ui-color-error"
                          : "border-border-primary ui-color-muted hover:border-border-secondary hover:ui-color-secondary"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onCapture(index)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-content-primary"
                    >
                      {isCapturing ? (
                        <>
                          <motion.span
                            className="h-1 w-1 rounded-full bg-cloud"
                            animate={{ opacity: [0.3, 1, 0.3] }}
                            transition={{ duration: 1, repeat: Infinity }}
                          />
                          <span
                            className={`truncate ${
                              capturePreview
                                ? "ui-color-primary"
                                : "ui-color-muted"
                            }`}
                          >
                            {capturePreview || "..."}
                          </span>
                        </>
                      ) : (
                        <span className="truncate">{displayShortcut}</span>
                      )}
                    </button>

                    <ShortcutIconToggle
                      label={temporaryLabel}
                      tone="local"
                      active={binding.temporary}
                      disabled={false}
                      onClick={() =>
                        onUpdateBinding(mode, index, {
                          temporary: !binding.temporary,
                        })
                      }
                    >
                      <Ghost size={13} aria-hidden="true" />
                    </ShortcutIconToggle>
                    <ShortcutIconToggle
                      label={cleanupLabel}
                      tone="cloud"
                      active={binding.cleanup_enabled}
                      disabled={cleanupDisabled}
                      onClick={() =>
                        onUpdateBinding(mode, index, {
                          cleanup_enabled: !binding.cleanup_enabled,
                        })
                      }
                    >
                      <BrushCleaning size={13} aria-hidden="true" />
                    </ShortcutIconToggle>
                    <button
                      type="button"
                      onClick={() => onRemoveBinding(mode, index)}
                      aria-label={t({
                        id: "settings.general.shortcuts.remove_shortcut",
                        message: "Remove shortcut",
                      })}
                      className="ui-button-ghost ui-hover-error-strong h-5 w-5"
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}

              {canAdd && (
                <button
                  type="button"
                  onClick={() => onAddBinding(mode)}
                  className="h-6 w-full border-b border-dashed border-border-primary text-left ui-text-meta ui-color-disabled transition-colors hover:border-border-secondary hover:ui-color-muted"
                >
                  {addShortcutLabel}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const ShortcutIconToggle = ({
  label,
  tone,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  tone: "local" | "cloud";
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) => {
  const activeClass =
    tone === "local"
      ? "text-[var(--color-local)] bg-[var(--color-local-10)] border-[var(--color-local-30)]"
      : "text-[var(--color-cloud)] bg-[var(--color-cloud-10)] border-[var(--color-cloud-30)]";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`box-border flex h-5 w-5 shrink-0 items-center justify-center rounded-md border leading-none transition-colors [&_svg]:block [&_svg]:shrink-0 disabled:pointer-events-none disabled:opacity-40 ${
        active
          ? activeClass
          : "border-transparent ui-color-muted hover:bg-surface-overlay hover:ui-color-secondary"
      }`}
    >
      {children}
    </button>
  );
};

type ShortcutRowProps = {
  mode: ShortcutMode;
  label: string;
  description: string;
  bindings: ShortcutBinding[];
  invalidDrafts?: Record<number, string>;
  enabled: boolean;
  isExpanded: boolean;
  captureActive: CaptureMode;
  capturePreview: string;
  onToggle: () => void;
  onCapture: (index: number) => void;
  onToggleExpand: () => void;
  onUpdateBinding: (
    mode: ShortcutMode,
    index: number,
    patch: Partial<ShortcutBinding>,
  ) => void;
  onAddBinding: (mode: ShortcutMode) => void;
  onRemoveBinding: (mode: ShortcutMode, index: number) => void;
  canDisable: boolean;
  cleanupDisabled: boolean;
};

const ShortcutRow = ({
  mode,
  label,
  description,
  bindings,
  invalidDrafts,
  enabled,
  isExpanded,
  captureActive,
  capturePreview,
  onToggle,
  onCapture,
  onToggleExpand,
  onUpdateBinding,
  onAddBinding,
  onRemoveBinding,
  canDisable,
  cleanupDisabled,
}: ShortcutRowProps) => {
  const { t } = useLingui();

  return (
    <div
      className={`space-y-1.5 px-2 py-1.5 ${
        enabled ? "opacity-100" : "opacity-80"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="ui-text-label-strong ui-color-primary">{label}</span>
          <span className="truncate ui-text-meta ui-color-disabled">
            {description}
          </span>
        </div>
        <ToggleSwitch
          enabled={enabled}
          onToggle={onToggle}
          ariaLabel={t({
            id: "settings.general.shortcut.toggle_aria",
            message: `Toggle ${label} shortcut`,
          })}
          disabled={enabled && !canDisable}
        />
      </div>
      <ShortcutBindingsList
        mode={mode}
        bindings={bindings}
        invalidDrafts={invalidDrafts}
        enabled={enabled}
        isExpanded={isExpanded}
        captureActive={captureActive}
        capturePreview={capturePreview}
        onCapture={onCapture}
        onToggleExpand={onToggleExpand}
        onUpdateBinding={onUpdateBinding}
        onAddBinding={onAddBinding}
        onRemoveBinding={onRemoveBinding}
        cleanupDisabled={cleanupDisabled}
      />
    </div>
  );
};

export default GeneralTab;
