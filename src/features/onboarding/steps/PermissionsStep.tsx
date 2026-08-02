import { useLingui } from "@lingui/react/macro";
import { motion } from "framer-motion";
import { Check, SpinnerGap as Loader2 } from "@phosphor-icons/react";
import {
  OnboardingHeader,
  OnboardingStep,
  PRIMARY_BUTTON_CLASS,
  type StepMotionProps,
} from "./shared";

interface PermissionsStepProps {
  stepMotionProps: StepMotionProps;
  requiresMicrophone: boolean;
  requiresAccessibility: boolean;
  micPermission: boolean;
  accessibilityPermission: boolean;
  isCheckingMic: boolean;
  isCheckingAccessibility: boolean;
  onRequestMic: () => void;
  onRequestAccessibility: () => void;
  onNext: () => void;
}

export function PermissionsStep({
  stepMotionProps,
  requiresMicrophone,
  requiresAccessibility,
  micPermission,
  accessibilityPermission,
  isCheckingMic,
  isCheckingAccessibility,
  onRequestMic,
  onRequestAccessibility,
  onNext,
}: PermissionsStepProps) {
  const { t } = useLingui();
  const allGranted =
    (!requiresMicrophone || micPermission) &&
    (!requiresAccessibility || accessibilityPermission);

  return (
    <OnboardingStep
      stepKey="permissions"
      motionProps={stepMotionProps}
      footer={
        <>
          <button
            type="button"
            onClick={onNext}
            disabled={!allGranted}
            className={PRIMARY_BUTTON_CLASS}
          >
            {t({
              id: "onboarding.permissions.continue",
              message: "Continue",
            })}
          </button>
          <button
            type="button"
            onClick={onNext}
            className="ui-text-body-sm text-content-muted transition-colors hover:text-content-primary"
          >
            {t({ id: "onboarding.permissions.skip", message: "Skip" })}
          </button>
        </>
      }
    >
      <OnboardingHeader
        title={t({
          id: "onboarding.permissions.title",
          message: "Permissions",
        })}
        subtitle={t({
          id: "onboarding.permissions.subtitle",
          message: "Glimpse needs these to hear you and type for you.",
        })}
      />

      <div className="w-full divide-y divide-border-secondary">
        {requiresMicrophone && (
          <PermissionRow
            title={t({
              id: "onboarding.microphone.title",
              message: "Microphone",
            })}
            body={t({
              id: "onboarding.microphone.subtitle",
              message: "Hears your voice.",
            })}
            granted={micPermission}
            checking={isCheckingMic}
            actionLabel={t({
              id: "onboarding.microphone.grant",
              message: "Grant Access",
            })}
            onRequest={onRequestMic}
          />
        )}

        {requiresAccessibility && (
          <PermissionRow
            title={t({
              id: "onboarding.accessibility.title",
              message: "Accessibility",
            })}
            body={t({
              id: "onboarding.accessibility.subtitle",
              message: "Types text into any app.",
            })}
            granted={accessibilityPermission}
            checking={isCheckingAccessibility}
            actionLabel={t({
              id: "onboarding.accessibility.enable",
              message: "Enable in Settings",
            })}
            onRequest={onRequestAccessibility}
          />
        )}
      </div>
    </OnboardingStep>
  );
}

function PermissionRow({
  title,
  body,
  granted,
  checking,
  actionLabel,
  onRequest,
}: {
  title: string;
  body: string;
  granted: boolean;
  checking: boolean;
  actionLabel: string;
  onRequest: () => void;
}) {
  return (
    <div className="flex items-center gap-4 py-4 text-left">
      <StatusDot granted={granted} checking={checking} />

      <div className="min-w-0 flex-1">
        <h3 className="ui-text-body-lg-strong text-content-primary">{title}</h3>
        <p className="mt-0.5 ui-text-body-sm text-content-muted">{body}</p>
      </div>

      {!granted && (
        <button
          type="button"
          onClick={onRequest}
          disabled={checking}
          className="shrink-0 ui-text-body-sm-strong text-cloud underline-offset-4 transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function StatusDot({
  granted,
  checking,
}: {
  granted: boolean;
  checking: boolean;
}) {
  return (
    <div
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors ${
        granted ? "bg-emerald-500 text-white" : "border border-border-secondary"
      }`}
    >
      {checking ? (
        <Loader2 size={13} className="animate-spin text-content-muted" />
      ) : granted ? (
        <motion.span
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
        >
          <Check size={14} weight="bold" />
        </motion.span>
      ) : null}
    </div>
  );
}
