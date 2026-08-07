import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { estimateTypewriterMs } from "../../../shared/ui/TypewriterText";

export type CardRevealStage =
  | "draft"
  | "wiping"
  | "stamp"
  | "name"
  | "email"
  | "details"
  | "coverage"
  | "done";

export const REVEAL_NAME_SPEED_MS = 34;
export const REVEAL_VALUE_SPEED_MS = 26;

const WIPE_MS = 750;
const STAMP_HOLD_MS = 650;
const PAUSE_AFTER_STAMP_MS = 420;
const PAUSE_AFTER_NAME_MS = 520;
const PAUSE_AFTER_EMAIL_MS = 380;
const DETAILS_HOLD_MS = 700;
const PAUSE_BEFORE_COVERAGE_MS = 480;
const REVEAL_FLOOR_MS = 6400;

// The reveal is a one-time event, not a property of the mounted component.
// Remounting the account screen, or a background license refetch, must not
// replay it.
let sessionRevealed = false;

export function useCardActivationSequence(
  activating: boolean,
  active: boolean,
  headlineText: string | null,
  licenseReady: boolean,
  licenseLoading: boolean,
  activationAttempt: number,
) {
  const [stage, setStage] = useState<CardRevealStage>(() =>
    active || sessionRevealed ? "done" : "draft",
  );
  const [isUserActivationReveal, setIsUserActivationReveal] = useState(false);
  const timersRef = useRef<number[]>([]);
  const wipeStartedAtRef = useRef<number | null>(null);
  const sequenceStartedRef = useRef(false);
  const revealScheduledRef = useRef(false);
  const prevActiveRef = useRef(active);
  const userActivatedRef = useRef(false);
  const lastAttemptRef = useRef(0);
  const headlineRef = useRef(headlineText);

  headlineRef.current = headlineText;

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  }, []);

  const schedule = useCallback((fn: () => void, delayMs: number) => {
    timersRef.current.push(
      window.setTimeout(() => {
        fn();
      }, delayMs),
    );
  }, []);

  const beginUserReveal = useCallback(() => {
    clearTimers();
    sequenceStartedRef.current = true;
    revealScheduledRef.current = false;
    wipeStartedAtRef.current = Date.now();
    setIsUserActivationReveal(true);
    setStage("wiping");
  }, [clearTimers]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  useEffect(() => {
    if (
      activationAttempt <= 0 ||
      activationAttempt === lastAttemptRef.current
    ) {
      return;
    }

    lastAttemptRef.current = activationAttempt;
    userActivatedRef.current = true;
  }, [activationAttempt]);

  useEffect(() => {
    if (activating) {
      userActivatedRef.current = true;
    }
  }, [activating]);

  useLayoutEffect(() => {
    if (licenseLoading) return;

    if (active && stage === "draft" && !userActivatedRef.current) {
      sequenceStartedRef.current = true;
      revealScheduledRef.current = true;
      setIsUserActivationReveal(false);
      setStage("done");
    }
  }, [active, licenseLoading, stage]);

  useEffect(() => {
    if (active && stage === "done") sessionRevealed = true;
  }, [active, stage]);

  useEffect(() => {
    const wasActive = prevActiveRef.current;
    const becameActive = active && !wasActive;
    const becameInactive = !active && wasActive;
    prevActiveRef.current = active;

    // A refetch in flight is not a deactivation; dropping to draft here is
    // what made the details animate back in.
    if (licenseLoading && !activating) return;

    if (!activating && !active) {
      sessionRevealed = false;
      clearTimers();
      sequenceStartedRef.current = false;
      revealScheduledRef.current = false;
      wipeStartedAtRef.current = null;
      if (becameInactive || activationAttempt <= 0) {
        userActivatedRef.current = false;
      }
      setIsUserActivationReveal(false);
      setStage("draft");
      return;
    }

    if (becameActive && !sequenceStartedRef.current) {
      if (!userActivatedRef.current) {
        sequenceStartedRef.current = true;
        revealScheduledRef.current = true;
        setIsUserActivationReveal(false);
        setStage("done");
        return;
      }

      beginUserReveal();
      return;
    }

    if (
      (activating || (active && userActivatedRef.current)) &&
      !sequenceStartedRef.current
    ) {
      beginUserReveal();
    }
  }, [
    activating,
    active,
    activationAttempt,
    beginUserReveal,
    clearTimers,
    licenseLoading,
  ]);

  useEffect(() => {
    if (
      !active ||
      stage !== "wiping" ||
      revealScheduledRef.current ||
      !licenseReady
    ) {
      return;
    }

    revealScheduledRef.current = true;

    const wipeStart = wipeStartedAtRef.current ?? Date.now();
    const untilStamp = Math.max(0, WIPE_MS - (Date.now() - wipeStart));
    const text = headlineRef.current ?? "";
    const nameTypeMs = text
      ? estimateTypewriterMs(text, REVEAL_NAME_SPEED_MS)
      : 480;

    let cursor = untilStamp;

    schedule(() => setStage("stamp"), cursor);
    cursor += STAMP_HOLD_MS + PAUSE_AFTER_STAMP_MS;

    schedule(() => setStage("name"), cursor);
    cursor += nameTypeMs + PAUSE_AFTER_NAME_MS;

    schedule(() => setStage("email"), cursor);
    cursor += PAUSE_AFTER_EMAIL_MS + 420;

    schedule(() => setStage("details"), cursor);
    cursor += DETAILS_HOLD_MS + PAUSE_BEFORE_COVERAGE_MS;

    schedule(() => setStage("coverage"), cursor);

    const totalElapsed = Date.now() - wipeStart;
    schedule(
      () => setStage("done"),
      Math.max(REVEAL_FLOOR_MS - totalElapsed, cursor + 900),
    );
  }, [active, stage, licenseReady, schedule]);

  const cinematic = stage !== "draft" && stage !== "done";
  const typingReveal = cinematic;
  const showTierPicker = stage === "draft";
  const showStamp = active && stage !== "draft" && stage !== "wiping";
  const showName =
    active && ["name", "email", "details", "coverage", "done"].includes(stage);
  const showEmail =
    active && ["email", "details", "coverage", "done"].includes(stage);
  const showDetails = active && ["details", "coverage", "done"].includes(stage);
  const showCoverage = active && ["coverage", "done"].includes(stage);
  const stampSlam = stage === "stamp";

  return {
    stage,
    cinematic,
    typingReveal,
    isUserActivationReveal,
    showTierPicker,
    showStamp,
    showName,
    showEmail,
    showDetails,
    showCoverage,
    stampSlam,
  };
}
