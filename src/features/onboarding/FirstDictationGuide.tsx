import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle,
  PencilSimple,
  SpinnerGap as Loader2,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShortcutCapture } from "../../shared/hooks/useShortcutCapture";
import { formatShortcutForDisplay } from "../../shared/lib/shortcuts";
import {
  OnboardingHeader,
  OnboardingStep,
  PRIMARY_BUTTON_CLASS,
  type StepMotionProps,
} from "./steps/shared";

interface FirstDictationGuideProps {
  stepMotionProps: StepMotionProps;
  smartShortcut: string;
  onSetShortcut: (shortcut: string) => void | Promise<void>;
  onFinish: () => void;
  isFinishing: boolean;
  completionError: string | null;
}

const CELEBRATION_DOTS = [
  { x: -18, y: -10, color: "bg-cloud", delay: 0 },
  { x: -15, y: 12, color: "bg-local", delay: 0.04 },
  { x: 0, y: -18, color: "bg-local", delay: 0.08 },
  { x: 17, y: -9, color: "bg-cloud", delay: 0.12 },
  { x: 16, y: 12, color: "bg-local", delay: 0.16 },
] as const;

function CelebrationMark() {
  return (
    <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
      {CELEBRATION_DOTS.map((dot) => (
        <motion.span
          key={`${dot.x}-${dot.y}`}
          className={`absolute h-1 w-1 rounded-full ${dot.color}`}
          initial={{ x: 0, y: 0, opacity: 0, scale: 0 }}
          animate={{
            x: [0, dot.x, dot.x * 1.12],
            y: [0, dot.y, dot.y * 1.12],
            opacity: [0, 1, 0],
            scale: [0, 1, 0.6],
          }}
          transition={{
            duration: 0.7,
            delay: dot.delay,
            ease: "easeOut",
          }}
        />
      ))}
      <motion.div
        className="relative flex h-8 w-8 items-center justify-center rounded-full bg-local/12"
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", stiffness: 360, damping: 20 }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.4, rotate: -16 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          transition={{
            type: "spring",
            stiffness: 420,
            damping: 19,
            delay: 0.08,
          }}
        >
          <CheckCircle size={20} weight="fill" className="text-local" />
        </motion.div>
      </motion.div>
    </div>
  );
}

export default function FirstDictationGuide({
  stepMotionProps,
  smartShortcut,
  onSetShortcut,
  onFinish,
  isFinishing,
  completionError,
}: FirstDictationGuideProps) {
  const { t } = useLingui();
  const practiceRef = useRef<HTMLTextAreaElement>(null);
  const [completedDictation, setCompletedDictation] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [preview, setPreview] = useState("");
  const shortcutLabel = formatShortcutForDisplay(smartShortcut);

  const stopCapture = useCallback(async () => {
    await invoke("set_shortcut_capture_active", { active: false }).catch(
      () => {},
    );
    setCapturing(false);
    setPreview("");
  }, []);

  const handleShortcutCaptured = useCallback(
    (shortcut: string) => {
      void Promise.resolve(onSetShortcut(shortcut)).finally(() => {
        window.setTimeout(() => practiceRef.current?.focus(), 0);
      });
    },
    [onSetShortcut],
  );

  useShortcutCapture({
    active: capturing,
    onCancel: stopCapture,
    onPreviewChange: setPreview,
    onShortcutCaptured: handleShortcutCaptured,
  });

  useEffect(() => {
    practiceRef.current?.focus();

    const unlistenPromise = listen("transcription:complete", () => {
      setCompletedDictation(true);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const startCapture = () => {
    setPreview("");
    setCapturing(true);
    void invoke("set_shortcut_capture_active", { active: true }).catch(() => {
      setCapturing(false);
    });
  };

  return (
    <OnboardingStep
      stepKey="practice"
      motionProps={stepMotionProps}
      align="center"
      footer={
        <>
          <button
            type="button"
            onClick={onFinish}
            disabled={!completedDictation || isFinishing}
            aria-busy={isFinishing}
            className={PRIMARY_BUTTON_CLASS}
          >
            {isFinishing ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {t({
                  id: "onboarding.first_dictation.finishing",
                  message: "Finishing...",
                })}
              </>
            ) : completedDictation ? (
              t({
                id: "onboarding.first_dictation.continue",
                message: "Continue to Glimpse",
              })
            ) : (
              t({
                id: "onboarding.first_dictation.dictate_to_continue",
                message: "Dictate to continue",
              })
            )}
          </button>
          <div className="flex h-5 items-center justify-center">
            <motion.button
              type="button"
              onClick={onFinish}
              disabled={isFinishing || completedDictation}
              aria-hidden={completedDictation}
              tabIndex={completedDictation ? -1 : 0}
              className="ui-text-body-sm text-content-muted transition-colors hover:text-content-primary disabled:pointer-events-none"
              animate={{
                opacity: completedDictation ? 0 : 1,
                y: completedDictation ? 3 : 0,
              }}
              transition={{ duration: 0.18 }}
            >
              {t({
                id: "onboarding.first_dictation.later",
                message: "Skip",
              })}
            </motion.button>
          </div>
        </>
      }
    >
      <OnboardingHeader
        title={t({
          id: "onboarding.first_dictation.title",
          message: "Press your shortcut, then say this",
        })}
      />

      <div className="flex flex-col items-center">
        <span className="ui-text-uppercase-meta font-semibold text-content-muted">
          {t({
            id: "onboarding.done.recap.shortcut",
            message: "Smart shortcut",
          })}
        </span>
        <button
          type="button"
          onClick={startCapture}
          className="group mt-1.5 flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:text-content-primary"
        >
          {capturing ? (
            <span className="flex items-center gap-1.5 font-mono ui-text-body-lg text-local">
              <motion.span
                className="h-1.5 w-1.5 rounded-full bg-local"
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
              <span className="font-mono ui-text-body-lg text-content-primary">
                {shortcutLabel}
              </span>
              <PencilSimple
                size={12}
                className="text-content-disabled transition-colors group-hover:text-content-secondary"
              />
            </>
          )}
        </button>
      </div>

      <div className="mt-7 w-full text-left">
        <p className="text-center ui-text-body-lg font-medium text-content-primary">
          {t({
            id: "onboarding.first_dictation.prompt",
            message: "“Glimpse turns my voice into text.”",
          })}
        </p>

        <motion.div
          className={`mt-5 min-h-[104px] border-b px-2 pb-3 transition-colors ${
            completedDictation
              ? "border-local/50"
              : "border-border-secondary focus-within:border-local/50"
          }`}
          animate={
            completedDictation
              ? { borderColor: [null, "var(--color-local)", null] }
              : undefined
          }
          transition={{ duration: 0.7, ease: "easeOut" }}
        >
          <textarea
            ref={practiceRef}
            rows={3}
            spellCheck={false}
            aria-label={t({
              id: "onboarding.first_dictation.practice_aria",
              message: "Practice your first dictation",
            })}
            placeholder={t({
              id: "onboarding.first_dictation.placeholder",
              message: "Your words will appear here…",
            })}
            className="block w-full resize-none bg-transparent p-0 ui-text-body-lg text-content-primary outline-none placeholder:text-content-disabled"
          />
        </motion.div>

        <div className="flex h-14 items-center justify-center">
          <AnimatePresence initial={false}>
            {completedDictation ? (
              <motion.div
                className="flex items-center gap-3"
                initial={{ opacity: 0, y: 6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{
                  type: "spring",
                  stiffness: 300,
                  damping: 22,
                  delay: 0.06,
                }}
              >
                <CelebrationMark />
                <div>
                  <p className="ui-text-body-sm font-medium text-content-primary">
                    {t({
                      id: "onboarding.first_dictation.complete",
                      message: "First dictation complete",
                    })}
                  </p>
                  <p className="mt-0.5 ui-text-meta text-content-muted">
                    {t({
                      id: "onboarding.first_dictation.success_body",
                      message: "Use the same shortcut wherever you type.",
                    })}
                  </p>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {completionError ? (
        <p className="mt-4 ui-text-meta text-error">{completionError}</p>
      ) : null}
    </OnboardingStep>
  );
}
