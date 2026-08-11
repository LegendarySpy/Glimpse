import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
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

const REVEAL_VARIANTS = {
  hidden: { opacity: 0, y: 5 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.25, ease: "easeOut" } },
} as const;

interface FirstDictationGuideProps {
  stepMotionProps: StepMotionProps;
  smartShortcut: string;
  onSetShortcut: (shortcut: string) => void | Promise<void>;
  onFinish: () => void;
  isFinishing: boolean;
  completionError: string | null;
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
          id: "onboarding.first_dictation.title.v2",
          message: "Try your first dictation",
        })}
        subtitle={t({
          id: "onboarding.first_dictation.subtitle",
          message: "Hold your shortcut and read the line below out loud.",
        })}
      />

      <button
        type="button"
        onClick={startCapture}
        className="group -mt-5 mb-8 flex min-w-[132px] items-center justify-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-surface-elevated"
      >
        {capturing ? (
          <span className="flex items-center gap-1.5 font-mono ui-text-body-sm text-local">
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
            <span className="font-mono ui-text-body-sm text-content-secondary">
              {shortcutLabel}
            </span>
            <PencilSimple
              size={12}
              className="text-content-disabled transition-colors group-hover:text-content-secondary"
            />
          </>
        )}
      </button>

      <div className="w-full">
        <p className="ui-text-body-lg font-medium text-content-secondary">
          {t({
            id: "onboarding.first_dictation.prompt",
            message: "“Glimpse turns my voice into text.”",
          })}
        </p>

        <div
          className={`relative mt-4 min-h-[72px] border-b px-2 pb-3 transition-colors ${
            completedDictation
              ? "border-local/50"
              : "border-border-secondary focus-within:border-local/50"
          }`}
        >
          {completedDictation ? (
            <motion.span
              aria-hidden
              className="absolute inset-x-0 -bottom-px h-px origin-center bg-local"
              initial={{ scaleX: 0, opacity: 1 }}
              animate={{ scaleX: 1, opacity: 0.5 }}
              transition={{ duration: 0.55, ease: "easeOut" }}
            />
          ) : null}
          <textarea
            ref={practiceRef}
            rows={2}
            spellCheck={false}
            aria-label={t({
              id: "onboarding.first_dictation.practice_aria",
              message: "Practice your first dictation",
            })}
            placeholder={t({
              id: "onboarding.first_dictation.placeholder",
              message: "Your words will appear here…",
            })}
            className="block w-full resize-none bg-transparent p-0 text-center ui-text-body-lg text-content-primary outline-none placeholder:text-content-disabled"
          />
        </div>

        <div
          aria-live="polite"
          className="mt-5 flex min-h-[76px] items-start justify-center"
        >
          <AnimatePresence initial={false} mode="wait">
            {completedDictation ? (
              <motion.div
                key="done"
                className="w-full"
                variants={{
                  hidden: {},
                  shown: { transition: { staggerChildren: 0.07 } },
                }}
                initial="hidden"
                animate="shown"
              >
                <motion.p
                  variants={REVEAL_VARIANTS}
                  className="flex items-center justify-center gap-1.5 text-balance ui-text-body-sm font-medium text-content-primary"
                >
                  <motion.span
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{
                      type: "spring",
                      stiffness: 420,
                      damping: 18,
                      delay: 0.1,
                    }}
                  >
                    <Check size={14} weight="bold" className="text-local" />
                  </motion.span>
                  {t({
                    id: "onboarding.first_dictation.complete.v2",
                    message: "That's it, that's the whole thing.",
                  })}
                </motion.p>
                <ul className="mx-auto mt-2.5 flex max-w-sm flex-col gap-1 text-balance ui-text-meta text-content-muted">
                  <motion.li variants={REVEAL_VARIANTS}>
                    {t({
                      id: "onboarding.first_dictation.next.anywhere",
                      message:
                        "The same shortcut works in any app where you can type.",
                    })}
                  </motion.li>
                  <motion.li variants={REVEAL_VARIANTS}>
                    {t({
                      id: "onboarding.first_dictation.next.library",
                      message: "Every dictation is saved in your Library.",
                    })}
                  </motion.li>
                </ul>
              </motion.div>
            ) : (
              <motion.p
                key="waiting"
                className="ui-text-body-sm text-content-muted"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                {t({
                  id: "onboarding.first_dictation.waiting.v2",
                  message: "Waiting for you to speak.",
                })}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>

      {completionError ? (
        <p className="mt-4 ui-text-meta text-error">{completionError}</p>
      ) : null}
    </OnboardingStep>
  );
}
