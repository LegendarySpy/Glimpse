import { useLingui } from "@lingui/react/macro";
import {
  CircleNotch as Loader2,
  SignOut as LogOut,
  ArrowRight,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import CustomerPortalLink from "../../license/components/CustomerPortalLink";
import MemberCard from "../../license/components/MemberCard";
import type { LicenseState } from "../../license/api";
import type { PurchaseTier } from "../../license/purchaseConfig";

type AccountOpeningTarget = PurchaseTier | null;

type AccountViewProps = {
  licenseState: LicenseState | null;
  licenseLoading: boolean;
  activating: boolean;
  deactivating: boolean;
  openingTarget: AccountOpeningTarget;
  openError: string | null;
  activationError: string | null;
  deactivationError: string | null;
  onOpenCheckout: (tier: PurchaseTier) => void;
  onActivateLicense: (key: string) => void;
  onDeactivateLicense: () => void;
};

const TRIAL_TOTAL_DAYS = 14;

const portalLinkClassName =
  "inline-flex shrink-0 items-center gap-1 ui-text-meta ui-color-muted transition-colors hover:ui-color-secondary";

const AccountView = ({
  licenseState,
  licenseLoading,
  activating,
  deactivating,
  openingTarget,
  openError,
  activationError,
  deactivationError,
  onOpenCheckout,
  onActivateLicense,
  onDeactivateLicense,
}: AccountViewProps) => {
  const { t } = useLingui();
  const [licenseKey, setLicenseKey] = useState("");
  const [activationAttempt, setActivationAttempt] = useState(0);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const confirmTimeoutRef = useRef<number | null>(null);

  const isActive = licenseState?.status === "active";
  const isTrialing = !isActive && (licenseState?.trialActive ?? false);
  const renewsAt =
    isActive && licenseState?.expiresAt
      ? formatDate(licenseState.expiresAt)
      : null;
  const renewsText = renewsAt ? t`Renews ${renewsAt}` : null;

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current !== null) {
        window.clearTimeout(confirmTimeoutRef.current);
      }
    };
  }, []);

  const submitActivation = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedKey = licenseKey.trim();
    if (trimmedKey.length === 0) return;
    setActivationAttempt((attempt) => attempt + 1);
    onActivateLicense(trimmedKey);
  };

  const handleDeactivateClick = () => {
    if (confirmDeactivate) {
      if (confirmTimeoutRef.current !== null) {
        window.clearTimeout(confirmTimeoutRef.current);
        confirmTimeoutRef.current = null;
      }
      setConfirmDeactivate(false);
      onDeactivateLicense();
      return;
    }
    setConfirmDeactivate(true);
    confirmTimeoutRef.current = window.setTimeout(() => {
      setConfirmDeactivate(false);
      confirmTimeoutRef.current = null;
    }, 3000);
  };

  const handleCancelDeactivate = () => {
    if (confirmTimeoutRef.current !== null) {
      window.clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    setConfirmDeactivate(false);
  };

  const trialDaysRemaining = licenseState?.trialDaysRemaining ?? 0;
  const trialEndsAt = licenseState?.trialEndsAt ?? null;
  const trialStatusText = (() => {
    if (licenseLoading) return "\u00a0";

    if (isTrialing) {
      if (trialDaysRemaining === 1) {
        return t({
          id: "settings.account.trial.text_one",
          message: "Trial · 1 day left",
        });
      }
      return t`Trial · ${trialDaysRemaining} of ${TRIAL_TOTAL_DAYS} days left`;
    }

    if (trialEndsAt) {
      const formattedDate = formatDate(trialEndsAt) ?? "-";
      const prefix = t({
        id: "settings.account.trial.text_ended_on",
        message: "Your trial ended on",
      });
      return `${prefix} ${formattedDate}`;
    }

    return t({
      id: "settings.account.trial.text_ended",
      message: "Your trial has ended",
    });
  })();

  return (
    <div className="mx-auto w-full max-w-[460px] space-y-6">
      <div className="flex flex-col items-center gap-3">
        <MemberCard
          active={isActive}
          activating={activating}
          activationAttempt={activationAttempt}
          licenseLoading={licenseLoading}
          licenseState={licenseState}
          openingTarget={openingTarget}
          checkoutDisabled={openingTarget !== null}
          onOpenCheckout={onOpenCheckout}
        />

        <div className="flex w-full max-w-[400px] items-center justify-between gap-3">
          {isActive ? (
            <div className="flex min-w-0 flex-col gap-0.5">
              {renewsText ? (
                <p className="truncate ui-text-meta ui-color-muted">
                  {renewsText}
                </p>
              ) : null}
              <CustomerPortalLink
                source="settings_account"
                className={portalLinkClassName}
              />
            </div>
          ) : (
            <p
              className="min-w-0 truncate ui-text-meta"
              style={{
                color: isTrialing
                  ? "var(--color-cloud)"
                  : "var(--color-text-muted)",
              }}
            >
              {trialStatusText}
            </p>
          )}

          {isActive ? (
            confirmDeactivate ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleCancelDeactivate}
                  disabled={deactivating}
                  className="inline-flex h-7 min-w-[52px] items-center justify-center rounded-md px-2 ui-text-button-sm ui-color-muted transition-colors hover:bg-surface-elevated hover:text-content-primary disabled:opacity-50"
                >
                  {t({
                    id: "settings.account.action.deactivate_cancel",
                    message: "Cancel",
                  })}
                </button>
                <button
                  type="button"
                  onClick={handleDeactivateClick}
                  disabled={deactivating}
                  className="inline-flex h-7 min-w-[72px] items-center justify-center gap-1 rounded-md px-2 ui-text-button-sm ui-color-error transition-colors hover:bg-surface-elevated disabled:opacity-50"
                >
                  {deactivating ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <LogOut size={11} />
                  )}
                  {t({
                    id: "settings.account.action.deactivate_confirm_short",
                    message: "Deactivate",
                  })}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleDeactivateClick}
                disabled={deactivating}
                className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 ui-text-button-sm ui-color-muted transition-colors hover:bg-surface-elevated hover:text-content-primary disabled:opacity-50"
              >
                {deactivating ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <LogOut size={12} />
                )}
                {t({
                  id: "settings.account.action.deactivate",
                  message: "Deactivate this device",
                })}
              </button>
            )
          ) : (
            <CustomerPortalLink
              source="settings_account"
              className={portalLinkClassName}
            />
          )}
        </div>

        {deactivationError ? (
          <p className="w-full max-w-[400px] ui-text-meta text-error">
            {deactivationError}
          </p>
        ) : null}

        {openError ? (
          <p className="w-full max-w-[400px] ui-text-meta text-error">
            {openError}
          </p>
        ) : null}
      </div>

      {!isActive && (
        <section className="mx-auto max-w-[400px] border-t border-border-primary pt-5">
          <h2 className="ui-text-label-strong ui-color-primary">
            {t({
              id: "settings.account.section.activate",
              message: "Already bought?",
            })}
          </h2>
          <form
            onSubmit={submitActivation}
            className="mt-3 flex items-center gap-2 border-b border-border-secondary transition-colors focus-within:border-content-primary"
          >
            <input
              value={licenseKey}
              onChange={(event) => setLicenseKey(event.target.value)}
              placeholder={t({
                id: "settings.account.activate.placeholder",
                message: "GLIMPSE_…",
              })}
              aria-label={t({
                id: "settings.account.activate.input_aria",
                message: "Activation code",
              })}
              className="min-w-0 flex-1 bg-transparent px-0.5 py-2 font-mono ui-text-body-sm ui-color-primary placeholder-content-disabled outline-none"
            />
            <button
              type="submit"
              disabled={activating || licenseKey.trim().length === 0}
              className="inline-flex h-7 items-center gap-1 px-1 ui-text-button-sm ui-color-secondary transition-colors hover:text-content-primary disabled:opacity-40"
            >
              {activating ? (
                <Loader2 size={12} className="animate-spin" />
              ) : null}
              {t({
                id: "settings.account.activate.submit",
                message: "Activate",
              })}
              {!activating && <ArrowRight size={12} aria-hidden="true" />}
            </button>
          </form>
          {activationError && (
            <p className="mt-2 ui-text-meta text-error">{activationError}</p>
          )}
        </section>
      )}
    </div>
  );
};

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default AccountView;
