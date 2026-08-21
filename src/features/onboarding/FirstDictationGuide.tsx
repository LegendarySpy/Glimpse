import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  PencilSimple,
  SpinnerGap as Loader2,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useShortcutCapture } from "../../shared/hooks/useShortcutCapture";
import { shortcutDisplayParts } from "../../shared/lib/shortcuts";
import type {
  PillStatePayload,
  PillStatus,
  TranscriptionCompletePayload,
} from "../../types";
import {
  OnboardingHeader,
  OnboardingStep,
  PRIMARY_BUTTON_CLASS,
  ShortcutKeys,
  type StepMotionProps,
} from "./steps/shared";

const REVEAL_VARIANTS = {
  hidden: { opacity: 0, y: 5 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.25, ease: "easeOut" } },
} as const;

const hasSpokenWords = (text: string) => /\p{L}|\p{N}/u.test(text);

interface FirstDictationGuideProps {
  stepMotionProps: StepMotionProps;
  smartShortcut: string;
  onSetShortcut: (shortcut: string) => void | Promise<void>;
  onFinish: (firstDictation: boolean) => void;
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
  const holdingRef = useRef(false);
  const [completedDictation, setCompletedDictation] = useState(false);
  const [dictationFailed, setDictationFailed] = useState(false);
  const [practiceText, setPracticeText] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [preview, setPreview] = useState("");
  const [holding, setHolding] = useState(false);
  const [pillStatus, setPillStatus] = useState<PillStatus>("idle");
  const isListening = holding || pillStatus === "listening";
  const isProcessing = pillStatus === "processing";
  const showSuccess = completedDictation && hasSpokenWords(practiceText);

  const stopCapture = useCallback(async () => {
    await invoke("set_shortcut_capture_active", { active: false }).catch(
      () => {},
    );
    setCapturing(false);
    setPreview("");
  }, []);

  const stopHold = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    void invoke("stop_hold_recording").catch(() => {});
  }, []);

  const handleShortcutCaptured = useCallback(
    (shortcut: string) => {
      void onSetShortcut(shortcut);
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
    const unlistenPromises = [
      listen<TranscriptionCompletePayload>(
        "transcription:complete",
        (event) => {
          const transcript = event.payload.transcript.trim();
          if (!hasSpokenWords(transcript)) {
            setPracticeText("");
            setCompletedDictation(false);
            setDictationFailed(true);
            return;
          }
          setPracticeText(transcript);
          setDictationFailed(false);
          setCompletedDictation(true);
        },
      ),
      listen("transcription:error", () => {
        setDictationFailed(true);
      }),
      listen<PillStatePayload>("pill:state", (event) => {
        setPillStatus(event.payload.status);
        if (event.payload.status === "listening") {
          setDictationFailed(false);
        }
        if (event.payload.status === "error") {
          setDictationFailed(true);
        }
      }),
    ];

    return () => {
      if (holdingRef.current) {
        holdingRef.current = false;
        void invoke("stop_hold_recording").catch(() => {});
      }
      unlistenPromises.forEach((promise) => {
        promise.then((unlisten) => unlisten()).catch(() => {});
      });
    };
  }, []);

  const startCapture = () => {
    setPreview("");
    setCapturing(true);
    void invoke("set_shortcut_capture_active", { active: true }).catch(() => {
      setCapturing(false);
    });
  };

  const startHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (capturing || showSuccess || isProcessing || (isListening && !holding)) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    holdingRef.current = true;
    setHolding(true);
    setDictationFailed(false);
    void invoke("start_hold_recording")
      .then(() => {
        if (!holdingRef.current) {
          void invoke("stop_hold_recording").catch(() => {});
        }
      })
      .catch(() => {
        if (!holdingRef.current) return;
        holdingRef.current = false;
        setHolding(false);
        setDictationFailed(true);
      });
  };

  const holdLabel = isProcessing
    ? t({
        id: "onboarding.first_dictation.transcribing",
        message: "Transcribing...",
      })
    : isListening
      ? t({
          id: "onboarding.first_dictation.listening",
          message: "Listening…",
        })
      : t({
          id: "onboarding.first_dictation.hold",
          message: "Hold to dictate",
        });

  let waitingMessage = t({
    id: "onboarding.first_dictation.waiting.v5",
    message: "Press the shortcut above, or hold the button below.",
  });
  if (capturing) {
    waitingMessage = t({
      id: "onboarding.first_dictation.waiting.capture",
      message: "Press the shortcut you want.",
    });
  } else if (holding) {
    waitingMessage = t({
      id: "onboarding.first_dictation.waiting.hold",
      message: "Keep holding, then release when you are done.",
    });
  } else if (isListening) {
    waitingMessage = t({
      id: "onboarding.first_dictation.waiting.speak",
      message: "Go ahead and speak.",
    });
  }

  return (
    <OnboardingStep
      stepKey="practice"
      motionProps={stepMotionProps}
      align="center"
      footer={
        <>
          {showSuccess ? (
            <button
              type="button"
              onClick={() => onFinish(true)}
              disabled={isFinishing}
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
              ) : (
                t({
                  id: "onboarding.first_dictation.continue",
                  message: "Continue to Glimpse",
                })
              )}
            </button>
          ) : (
            <button
              type="button"
              onPointerDown={startHold}
              onPointerUp={stopHold}
              onPointerCancel={stopHold}
              onLostPointerCapture={stopHold}
              disabled={capturing || isProcessing || (isListening && !holding)}
              aria-pressed={isListening}
              className={`${PRIMARY_BUTTON_CLASS} select-none touch-none`}
            >
              {isProcessing ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {holdLabel}
                </>
              ) : (
                holdLabel
              )}
            </button>
          )}
          <div className="flex h-5 items-center justify-center">
            <motion.button
              type="button"
              onClick={() => onFinish(false)}
              disabled={isFinishing || showSuccess}
              aria-hidden={showSuccess}
              tabIndex={showSuccess ? -1 : 0}
              className="ui-text-body-sm text-content-muted transition-colors hover:text-content-primary disabled:pointer-events-none"
              animate={{
                opacity: showSuccess ? 0 : 1,
                y: showSuccess ? 3 : 0,
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
          id: "onboarding.first_dictation.subtitle.v5",
          message: "Press this shortcut and read the line below.",
        })}
      />

      <button
        type="button"
        onClick={() => {
          if (capturing) {
            void stopCapture();
            return;
          }
          startCapture();
        }}
        disabled={isListening || isProcessing}
        aria-pressed={capturing}
        aria-label={
          capturing
            ? t({
                id: "onboarding.first_dictation.cancel_shortcut_aria",
                message: "Cancel shortcut change",
              })
            : t({
                id: "onboarding.first_dictation.edit_shortcut_aria",
                message: "Change shortcut",
              })
        }
        className="group -mt-2 mb-8 inline-flex items-center justify-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-surface-elevated disabled:pointer-events-none"
      >
        <ShortcutKeys
          parts={shortcutDisplayParts(preview || smartShortcut)}
          highlighted={capturing || isListening}
          waiting={capturing && !preview}
        />
        <PencilSimple
          size={14}
          className={`transition-colors ${
            capturing
              ? "text-local"
              : "text-content-disabled group-hover:text-content-secondary"
          }`}
        />
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
            showSuccess
              ? "border-local/50"
              : "border-border-secondary focus-within:border-local/50"
          }`}
        >
          {showSuccess ? (
            <motion.span
              aria-hidden
              className="absolute inset-x-0 -bottom-px h-px origin-center bg-local"
              initial={{ scaleX: 0, opacity: 1 }}
              animate={{ scaleX: 1, opacity: 0.5 }}
              transition={{ duration: 0.55, ease: "easeOut" }}
            />
          ) : null}
          <textarea
            rows={2}
            readOnly
            spellCheck={false}
            value={practiceText}
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
            {showSuccess ? (
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
            ) : dictationFailed ? (
              <motion.div
                key="failed"
                className="w-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                <p className="text-balance ui-text-body-sm font-medium text-content-primary">
                  {t({
                    id: "onboarding.first_dictation.failed_empty",
                    message: "No words came through.",
                  })}
                </p>
                <p className="mx-auto mt-1 max-w-sm text-balance ui-text-meta text-content-muted">
                  {t({
                    id: "onboarding.first_dictation.failed_empty_body",
                    message: "Hold a little longer, then try again.",
                  })}
                </p>
              </motion.div>
            ) : (
              <motion.p
                key={capturing ? "capture" : "waiting"}
                className="ui-text-body-sm text-content-muted"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                {waitingMessage}
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
