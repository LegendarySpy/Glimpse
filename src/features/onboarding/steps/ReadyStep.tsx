import { useLingui } from "@lingui/react/macro";
import { motion } from "framer-motion";
import { useCallback, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  SpinnerGap as Loader2,
  PencilSimple,
  CaretRight,
} from "@phosphor-icons/react";
import { formatShortcutForDisplay } from "../../../shared/lib/shortcuts";
import { useShortcutCapture } from "../../../shared/hooks/useShortcutCapture";
import { useInputDevices } from "../../settings/queries";
import { Dropdown } from "../../../shared/ui/Dropdown";
import {
  OnboardingHeader,
  OnboardingStep,
  PRIMARY_BUTTON_CLASS,
  type StepMotionProps,
} from "./shared";

const CHIP_CLASS =
  "flex h-8 items-center gap-1.5 rounded-md bg-surface-elevated px-2.5 transition-colors hover:bg-surface-overlay";

interface ReadyStepProps {
  stepMotionProps: StepMotionProps;
  smartShortcut: string;
  onSetShortcut: (shortcut: string) => void;
  modelLabel: string | null;
  onEditModel: () => void;
  microphoneDevice: string | null;
  onSetMicrophoneDevice: (device: string | null) => void;
  autoLaunch: boolean;
  onSetAutoLaunch: (value: boolean) => void;
  licenseActive: boolean;
  onOpenLicense: () => void;
  isCompleting: boolean;
  completionError: string | null;
  onComplete: () => void;
}

export function ReadyStep({
  stepMotionProps,
  smartShortcut,
  onSetShortcut,
  modelLabel,
  onEditModel,
  microphoneDevice,
  onSetMicrophoneDevice,
  autoLaunch,
  onSetAutoLaunch,
  licenseActive,
  onOpenLicense,
  isCompleting,
  completionError,
  onComplete,
}: ReadyStepProps) {
  const { t } = useLingui();
  const shortcut = formatShortcutForDisplay(smartShortcut);
  const [capturing, setCapturing] = useState(false);
  const [preview, setPreview] = useState("");
  const inputDevices = useInputDevices().data ?? [];
  const systemDefaultLabel = t({
    id: "onboarding.done.recap.microphone_default",
    message: "System default",
  });

  const stopCapture = useCallback(async () => {
    await invoke("set_shortcut_capture_active", { active: false }).catch(
      () => {},
    );
    setCapturing(false);
    setPreview("");
  }, []);

  useShortcutCapture({
    active: capturing,
    onCancel: stopCapture,
    onPreviewChange: setPreview,
    onShortcutCaptured: onSetShortcut,
  });

  const startCapture = () => {
    setPreview("");
    setCapturing(true);
    invoke("set_shortcut_capture_active", { active: true }).catch(() => {
      setCapturing(false);
    });
  };

  return (
    <OnboardingStep
      stepKey="done"
      motionProps={stepMotionProps}
      footer={
        <button
          type="button"
          onClick={onComplete}
          disabled={isCompleting}
          aria-busy={isCompleting}
          className={PRIMARY_BUTTON_CLASS}
        >
          {isCompleting ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              {t({ id: "onboarding.done.saving", message: "Saving..." })}
            </>
          ) : (
            t({ id: "onboarding.done.cta", message: "Start dictating" })
          )}
        </button>
      }
    >
      <OnboardingHeader
        title={t({ id: "onboarding.done.title", message: "You're set" })}
        subtitle={t({
          id: "onboarding.done.subtitle",
          message: "Press your shortcut in any app to dictate.",
        })}
      />

      <div className="w-full divide-y divide-border-secondary border-y border-border-secondary text-left">
        <Row
          label={t({
            id: "onboarding.done.recap.shortcut",
            message: "Smart shortcut",
          })}
        >
          <button
            type="button"
            onClick={startCapture}
            className={`group ${CHIP_CLASS}`}
          >
            {capturing ? (
              <span className="flex items-center gap-1.5 font-mono ui-text-body-sm text-cloud">
                <motion.span
                  className="h-1.5 w-1.5 rounded-full bg-cloud"
                  animate={{ opacity: [0.35, 1, 0.35] }}
                  transition={{ duration: 1, repeat: Infinity }}
                />
                {preview ||
                  t({
                    id: "onboarding.done.recap.shortcut_capture",
                    message: "Press a shortcut",
                  })}
              </span>
            ) : (
              <>
                <span className="font-mono ui-text-body-sm text-content-secondary">
                  {shortcut}
                </span>
                <PencilSimple
                  size={12}
                  className="text-content-disabled transition-colors group-hover:text-content-secondary"
                />
              </>
            )}
          </button>
        </Row>

        {modelLabel ? (
          <Row
            label={t({ id: "onboarding.done.recap.model", message: "Model" })}
          >
            <button
              type="button"
              onClick={onEditModel}
              className={`group min-w-0 ${CHIP_CLASS}`}
            >
              <span className="truncate ui-text-body-sm text-content-secondary">
                {modelLabel}
              </span>
              <CaretRight
                size={12}
                className="text-content-disabled transition-colors group-hover:text-content-secondary"
              />
            </button>
          </Row>
        ) : null}

        <Row
          label={t({
            id: "onboarding.done.recap.microphone",
            message: "Microphone",
          })}
        >
          <Dropdown
            value={microphoneDevice ?? ""}
            onChange={(value) => onSetMicrophoneDevice(value || null)}
            options={[
              { value: "", label: systemDefaultLabel },
              ...inputDevices.map((device) => ({
                value: device.id,
                label: device.name,
              })),
            ]}
            className="h-8 w-60 shrink-0"
            buttonClassName="h-8 !rounded-md !border-0 !bg-surface-elevated px-2.5 ui-text-body-sm hover:!bg-surface-overlay"
            valueClassName="text-content-secondary"
            menuClassName="top-9"
            truncate
          />
        </Row>

        <button
          type="button"
          role="switch"
          aria-checked={autoLaunch}
          onClick={() => onSetAutoLaunch(!autoLaunch)}
          className="flex w-full items-center justify-between gap-4 py-3.5 text-left"
        >
          <span>
            <span className="block ui-text-body-sm-strong text-content-primary">
              {t({
                id: "onboarding.done.auto_launch",
                message: "Open at login",
              })}
            </span>
            <span className="mt-0.5 block ui-text-meta text-content-muted">
              {t({
                id: "onboarding.done.auto_launch.body",
                message: "Start Glimpse when you log in.",
              })}
            </span>
          </span>
          <span
            className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
              autoLaunch ? "bg-emerald-500" : "bg-surface-hover"
            }`}
          >
            <motion.span
              layout
              transition={{ type: "spring", stiffness: 500, damping: 32 }}
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/10 ${
                autoLaunch ? "right-0.5" : "left-0.5"
              }`}
            />
          </span>
        </button>
      </div>

      <div className="mt-8 flex w-full items-start justify-between gap-4 text-left">
        <span>
          <span className="block ui-text-body-sm-strong text-content-primary">
            {licenseActive
              ? t({
                  id: "onboarding.done.license_active_title.v2",
                  message: "Thank you for supporting Glimpse",
                })
              : t({
                  id: "onboarding.done.free_title",
                  message: "Dictation is free forever",
                })}
          </span>
          <span className="mt-0.5 block ui-text-meta text-content-muted text-pretty">
            {licenseActive
              ? t({
                  id: "onboarding.done.license_active.v2",
                  message: "Every feature is unlocked. Go make something!",
                })
              : t({
                  id: "onboarding.done.license_adds.v2",
                  message:
                    "Unlock Cleanup, Personalities, File Transcription, and more.",
                })}
          </span>
        </span>
        {!licenseActive ? (
          <button
            type="button"
            onClick={onOpenLicense}
            className="shrink-0 ui-text-body-sm-strong text-cloud underline-offset-4 transition-colors hover:underline"
          >
            {t({ id: "onboarding.done.get_license", message: "Get a license" })}
          </button>
        ) : null}
      </div>

      {completionError ? (
        <p className="mt-4 ui-text-meta text-error">{completionError}</p>
      ) : null}
    </OnboardingStep>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3.5">
      <span className="text-pretty ui-text-body-sm-strong text-content-primary">
        {label}
      </span>
      {children}
    </div>
  );
}
