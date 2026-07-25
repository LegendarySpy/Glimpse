import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ACTION_CARD_BUTTON_ACCENTS,
  type ActionCardAccentPreset,
} from "./actionCardButtonAccents";

const HOLD_DURATION_MS = 2000;
const HOLD_RING_RADIUS = 10;
const HOLD_RING_CIRCUMFERENCE = 2 * Math.PI * HOLD_RING_RADIUS;

type HoldActionCardButtonProps = {
  title: string;
  description?: string;
  icon?: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  accentPreset?: ActionCardAccentPreset;
  ariaLabel?: string;
};

const joinClasses = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

const HoldActionCardButton = ({
  title,
  description,
  icon,
  onConfirm,
  disabled = false,
  accentPreset = "accent",
  ariaLabel,
}: HoldActionCardButtonProps) => {
  const [progress, setProgress] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const holdingRef = useRef(false);
  const readyRef = useRef(false);
  const startTimeRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  const presetAccent = ACTION_CARD_BUTTON_ACCENTS[accentPreset];
  const actionStyle = {
    "--action-card-border": presetAccent.borderColor,
    "--action-card-background": presetAccent.backgroundColor,
    "--action-card-hover-shadow": "var(--ui-action-card-hover-shadow)",
    "--action-card-rest-shadow": "var(--ui-action-card-rest-shadow)",
  } as CSSProperties;

  const resetVisuals = useCallback(() => {
    const button = buttonRef.current;
    if (button) {
      delete button.dataset.holding;
      delete button.dataset.ready;
    }
    setProgress(0);
  }, []);

  const cancelHold = useCallback(() => {
    holdingRef.current = false;
    readyRef.current = false;
    startTimeRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    resetVisuals();
  }, [resetVisuals]);

  const stepHold = useCallback((timestamp: number) => {
    if (!holdingRef.current || startTimeRef.current === null) return;

    const elapsed = timestamp - startTimeRef.current;
    const nextProgress = Math.min(1, elapsed / HOLD_DURATION_MS);
    setProgress(nextProgress);

    if (nextProgress >= 1) {
      readyRef.current = true;
      if (buttonRef.current) {
        buttonRef.current.dataset.ready = "true";
      }
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      return;
    }

    frameRef.current = requestAnimationFrame(stepHold);
  }, []);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.dataset.holding = "true";
    delete event.currentTarget.dataset.ready;
    holdingRef.current = true;
    readyRef.current = false;
    startTimeRef.current = performance.now();
    setProgress(0);
    frameRef.current = requestAnimationFrame(stepHold);
  };

  const handleKeyboardDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (disabled || (event.key !== "Enter" && event.key !== " ")) return;
    if (holdingRef.current) return;

    event.preventDefault();
    event.currentTarget.dataset.holding = "true";
    delete event.currentTarget.dataset.ready;
    holdingRef.current = true;
    readyRef.current = false;
    startTimeRef.current = performance.now();
    setProgress(0);
    frameRef.current = requestAnimationFrame(stepHold);
  };

  const handlePointerUp = () => {
    if (!holdingRef.current) return;

    if (readyRef.current) {
      onConfirm();
    }

    cancelHold();
  };

  const handleKeyboardUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handlePointerUp();
  };

  const handlePointerLeave = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!holdingRef.current) return;

    const related = event.relatedTarget as Node | null;
    if (related && event.currentTarget.contains(related)) return;

    cancelHold();
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={cancelHold}
      onKeyDown={handleKeyboardDown}
      onKeyUp={handleKeyboardUp}
      onBlur={cancelHold}
      style={actionStyle}
      className={joinClasses(
        "group relative w-full overflow-hidden rounded-lg border border-border-primary bg-surface-surface px-3 py-2.5 text-left outline-hidden select-none touch-none [box-shadow:var(--action-card-rest-shadow)] transition-[transform,box-shadow,border-color,background-color] duration-200 ease-out focus-visible:ring-2 focus-visible:ring-border-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:border-border-primary disabled:hover:bg-surface-surface disabled:hover:[box-shadow:var(--action-card-rest-shadow)]",
        "hover:border-[var(--action-card-border)] hover:bg-[var(--action-card-background)] hover:[box-shadow:var(--action-card-hover-shadow)]",
        "data-[holding=true]:border-[var(--action-card-border)] data-[holding=true]:bg-[var(--action-card-background)] data-[holding=true]:[box-shadow:none]",
        "data-[ready=true]:border-[var(--color-accent-50)] data-[ready=true]:bg-[var(--action-card-background)] data-[ready=true]:[box-shadow:0_0_0_1px_var(--color-accent-20)]",
      )}
    >
      <span
        aria-hidden="true"
        className={joinClasses(
          "pointer-events-none absolute inset-0 z-0 origin-left rounded-lg bg-[var(--action-card-background)] opacity-0 transition-opacity duration-200 group-data-[holding=true]:opacity-100",
          icon ? "hidden" : "block",
        )}
        style={{
          transform: `scaleX(${progress})`,
        }}
      />

      <span className="relative z-[1] flex items-center gap-2.5">
        {icon ? (
          <span
            aria-hidden="true"
            className="relative grid size-7 shrink-0 place-items-center leading-none ui-color-primary [&_svg]:block [&_svg]:shrink-0"
          >
            <svg
              className="pointer-events-none absolute left-1/2 top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-data-[holding=true]:opacity-100"
              viewBox="0 0 28 28"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="14"
                cy="14"
                r={HOLD_RING_RADIUS}
                stroke="var(--color-accent-20)"
                strokeWidth="1.5"
              />
              <circle
                cx="14"
                cy="14"
                r={HOLD_RING_RADIUS}
                stroke="var(--color-accent)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeDasharray={HOLD_RING_CIRCUMFERENCE}
                strokeDashoffset={HOLD_RING_CIRCUMFERENCE * (1 - progress)}
                transform="rotate(-90 14 14)"
              />
            </svg>
            {icon}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-col justify-center">
          <span className="ui-text-label-strong ui-color-primary block leading-tight">
            {title}
          </span>
          {description ? (
            <span className="ui-text-micro ui-color-disabled block leading-tight">
              {description}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
};

export default HoldActionCardButton;
