import { useLingui } from "@lingui/react/macro";
import { motion } from "framer-motion";
import { useCallback, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SpinnerGap as Loader2, PencilSimple } from "@phosphor-icons/react";
import { formatShortcutForDisplay } from "../../../shared/lib/shortcuts";
import { useShortcutCapture } from "../../../shared/hooks/useShortcutCapture";
import {
  OnboardingHeader,
  OnboardingStep,
  PRIMARY_BUTTON_CLASS,
  type StepMotionProps,
} from "./shared";

interface ReadyStepProps {
  stepMotionProps: StepMotionProps;
  smartShortcut: string;
  onSetShortcut: (shortcut: string) => void;
  modelLabel: string | null;
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
            className="group flex items-center gap-1.5 rounded-md bg-surface-elevated px-2 py-1 transition-colors hover:bg-surface-overlay"
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
            <span className="ui-text-body-sm text-content-secondary">
              {modelLabel}
            </span>
          </Row>
        ) : null}

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

      <p className="mt-3 ui-text-meta text-content-disabled">
        {t({
          id: "onboarding.done.more_options",
          message: "More options available in Settings.",
        })}
      </p>

      <div className="mt-8 flex w-full items-start justify-between gap-4 text-left">
        <span>
          <span className="block ui-text-body-sm-strong text-content-primary">
            {licenseActive
              ? t({
                  id: "onboarding.done.license_active_title",
                  message: "License active",
                })
              : t({
                  id: "onboarding.done.free_title",
                  message: "Dictation is free forever",
                })}
          </span>
          <span className="mt-0.5 block ui-text-meta text-content-muted text-pretty">
            {licenseActive
              ? t({
                  id: "onboarding.done.license_active",
                  message: "Every feature is unlocked.",
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
    <div className="flex items-center justify-between gap-4 py-3.5">
      <span className="ui-text-body-sm-strong text-content-primary">
        {label}
      </span>
      {children}
    </div>
  );
}
