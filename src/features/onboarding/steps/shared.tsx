import type { ReactNode } from "react";
import { motion, type Variants, type Easing } from "framer-motion";

export { GlimpseLogo } from "../../../shared/ui/GlimpseLogo";

export type StepMotionProps = {
  custom: 1 | -1;
  variants: Variants;
  animate: string;
  exit: string;
  transition: { duration: number; ease: Easing };
};

export function OnboardingStep({
  stepKey,
  motionProps,
  initial = "enter",
  widthClass = "max-w-md",
  align = "top",
  footer,
  children,
}: {
  stepKey: string;
  motionProps: StepMotionProps;
  initial?: string | false;
  widthClass?: string;
  align?: "top" | "center";
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <motion.div
      key={stepKey}
      {...motionProps}
      initial={initial}
      className={`flex min-h-full w-full ${widthClass} flex-col items-center text-center ${
        align === "center" ? "justify-center" : "justify-start pt-10"
      }`}
    >
      {children}
      {footer ? (
        <div className="mt-9 flex w-full flex-col items-center gap-2.5">
          {footer}
        </div>
      ) : null}
    </motion.div>
  );
}

export function OnboardingHeader({
  title,
  subtitle,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div className="mb-8 flex max-w-md flex-col items-center text-center">
      <h2 className="ui-text-title-lg font-semibold text-content-primary text-balance">
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-2 ui-text-body-lg text-content-muted text-pretty">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

export const StepIndicator = ({
  currentStep,
  total,
}: {
  currentStep: number;
  total: number;
}) => (
  <div className="flex items-center gap-1.5">
    {Array.from({ length: total }).map((_, i) => (
      <motion.div
        key={i}
        className="h-1.5 rounded-full bg-content-primary"
        animate={{
          width: i === currentStep ? 20 : 6,
          opacity: i <= currentStep ? 1 : 0.25,
        }}
        transition={{ duration: 0.25 }}
      />
    ))}
  </div>
);

export const PRIMARY_BUTTON_CLASS =
  "flex min-w-[160px] items-center justify-center gap-2 rounded-lg bg-content-primary px-6 py-2.5 ui-text-body-lg font-semibold text-surface-secondary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export function ShortcutKeys({
  parts,
  highlighted = false,
  waiting = false,
  size = "md",
}: {
  parts: string[];
  highlighted?: boolean;
  waiting?: boolean;
  size?: "md" | "sm";
}) {
  return (
    <motion.span
      className="flex items-center justify-center gap-1.5"
      animate={{ opacity: waiting ? [1, 0.55, 1] : 1 }}
      transition={
        waiting
          ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" }
          : { duration: 0.15 }
      }
    >
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="flex items-center gap-1.5">
          {index > 0 ? (
            <span className="ui-text-body-sm text-content-disabled">+</span>
          ) : null}
          <kbd
            className={`ui-keycap ui-keycap-${size}${
              highlighted ? " ui-keycap-active" : ""
            }`}
          >
            {part}
          </kbd>
        </span>
      ))}
    </motion.span>
  );
}
