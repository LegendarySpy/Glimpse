import { useLingui } from "@lingui/react/macro";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleNotch as Loader2, ArrowRight, X } from "@phosphor-icons/react";
import MemberCard from "../../license/components/MemberCard";
import CustomerPortalLink from "../../license/components/CustomerPortalLink";
import { looksLikeDiscountCode } from "../../license/licenseKeyShape";
import type { LicenseState } from "../../license/api";
import type { PurchaseTier } from "../../license/purchaseConfig";

const PERSONAL_INFO_URL = "https://tryglimpse.cc/personal";

const softEase = [0.22, 1, 0.36, 1] as const;
const layoutTransition = {
  layout: { duration: 0.34, ease: softEase },
} as const;

interface LicenseModalProps {
  licenseState: LicenseState | null;
  licenseLoading: boolean;
  activating: boolean;
  openingTarget: PurchaseTier | null;
  openError: string | null;
  activationError: string | null;
  onOpenCheckout: (tier: PurchaseTier) => void;
  onActivateLicense: (key: string) => void;
  onClose: () => void;
}

export function LicenseModal({
  licenseState,
  licenseLoading,
  activating,
  openingTarget,
  openError,
  activationError,
  onOpenCheckout,
  onActivateLicense,
  onClose,
}: LicenseModalProps) {
  const { t } = useLingui();
  const [licenseKey, setLicenseKey] = useState("");
  const [attemptedKey, setAttemptedKey] = useState("");
  const [activationAttempt, setActivationAttempt] = useState(0);
  const isActive = licenseState?.status === "active";
  const dismissTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
    },
    [],
  );

  const handleRevealComplete = () => {
    if (dismissTimerRef.current !== null) return;
    dismissTimerRef.current = window.setTimeout(() => {
      onClose();
    }, 1500);
  };

  const submitActivation = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = licenseKey.trim();
    if (trimmed.length === 0) return;
    setAttemptedKey(trimmed);
    setActivationAttempt((attempt) => attempt + 1);
    onActivateLicense(trimmed);
  };

  const errorText =
    activationError && looksLikeDiscountCode(attemptedKey)
      ? t({
          id: "onboarding.license.discount_code_error",
          message:
            "That looks like a discount code. Enter it at checkout, then paste the license key from your receipt.",
        })
      : (activationError ?? openError);

  return createPortal(
    <motion.div
      key="license-modal"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.45, ease: softEase } }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/88 px-6 backdrop-blur-2xl"
      onClick={onClose}
    >
      <motion.div
        layout
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{
          scale: 0.97,
          opacity: 0,
          y: -6,
          transition: { duration: 0.42, ease: softEase },
        }}
        transition={{
          duration: 0.18,
          layout: { duration: 0.34, ease: softEase },
        }}
        className="relative flex w-full max-w-[400px] flex-col items-center gap-4"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t({
          id: "onboarding.license.dialog_aria",
          message: "License",
        })}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t({ id: "onboarding.license.close", message: "Close" })}
          className="absolute -right-1 -top-1 z-10 flex h-7 w-7 items-center justify-center rounded-full text-white/65 transition-colors hover:text-white"
        >
          <X size={14} />
        </button>

        <AnimatePresence mode="popLayout">
          {!isActive ? (
            <motion.div
              key="license-intro"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="max-w-[340px] text-center"
            >
              <p className="ui-text-body-lg-strong text-white">
                {t({
                  id: "onboarding.license.free_title",
                  message: "Dictation is free forever",
                })}
              </p>
              <p className="mt-1 ui-text-body-sm text-white/70 text-pretty">
                {t({
                  id: "onboarding.license.free_body",
                  message:
                    "Unlock AI cleanup, voice editing, per-app personalities, audio and video transcription, and more.",
                })}
              </p>
              <button
                type="button"
                onClick={() => void openUrl(PERSONAL_INFO_URL).catch(() => {})}
                className="mt-2 ui-text-meta text-[#fbbf24] underline-offset-4 transition-opacity hover:underline"
              >
                {t({
                  id: "onboarding.license.why_paid",
                  message: "Why is there paid stuff?",
                })}
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <motion.div layout transition={layoutTransition}>
          <MemberCard
            active={isActive}
            activating={activating}
            activationAttempt={activationAttempt}
            licenseLoading={licenseLoading}
            licenseState={licenseState}
            openingTarget={openingTarget}
            checkoutDisabled={openingTarget !== null}
            onOpenCheckout={onOpenCheckout}
            onRevealComplete={handleRevealComplete}
          />
        </motion.div>

        <AnimatePresence mode="popLayout">
          {!isActive ? (
            <motion.div
              key="activate-form"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-[340px]"
            >
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-white/12" />
                <span className="ui-text-meta text-white/45">
                  {t({
                    id: "onboarding.license.already_bought",
                    message: "Already bought?",
                  })}
                </span>
                <span className="h-px flex-1 bg-white/12" />
              </div>

              <form
                onSubmit={submitActivation}
                className="mt-3 flex items-center gap-2 border-b border-white/15 transition-colors focus-within:border-white/40"
              >
                <input
                  value={licenseKey}
                  onChange={(event) => setLicenseKey(event.target.value)}
                  placeholder={t({
                    id: "onboarding.license.placeholder",
                    message: "GLIMPSE_…",
                  })}
                  aria-label={t({
                    id: "onboarding.license.input_aria",
                    message: "License key",
                  })}
                  className="min-w-0 flex-1 bg-transparent px-0.5 py-2 font-mono ui-text-body-sm text-white placeholder-white/35 outline-none"
                />
                <button
                  type="submit"
                  disabled={activating || licenseKey.trim().length === 0}
                  className="inline-flex h-7 items-center gap-1 px-1 ui-text-button-sm text-white/65 transition-colors hover:text-white disabled:opacity-40"
                >
                  {activating ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : null}
                  {t({
                    id: "onboarding.license.activate",
                    message: "Activate",
                  })}
                  {!activating && <ArrowRight size={12} aria-hidden="true" />}
                </button>
              </form>

              <p className="mt-2 min-h-10 ui-text-meta text-red-400 text-pretty">
                {errorText}
              </p>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <motion.div layout transition={layoutTransition}>
          <CustomerPortalLink
            source="onboarding"
            className="inline-flex items-center gap-1.5 ui-text-meta text-white/65 transition-colors hover:text-white"
          />
        </motion.div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
