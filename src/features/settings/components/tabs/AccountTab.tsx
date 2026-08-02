import { openUrl } from "@tauri-apps/plugin-opener";
import { motion, type Variants } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import {
  checkoutUrlFor,
  type PurchaseSource,
  type PurchaseTier,
} from "../../../license/purchaseConfig";
import {
  useActivateLicense,
  useDeactivateLicense,
  useLicenseState,
  useRefreshLicense,
} from "../../../license/queries";
import AccountView from "../AccountView";
import DictationStatsPanel from "../../../license/components/DictationStatsPanel";

type AccountTabProps = {
  variants: Variants;
  source?: PurchaseSource;
};

const AccountTab = ({
  variants,
  source = "settings_account",
}: AccountTabProps) => {
  const licenseQuery = useLicenseState();
  const activateLicense = useActivateLicense();
  const { mutate: refreshLicense, isPending: refreshLicensePending } =
    useRefreshLicense();
  const deactivateLicense = useDeactivateLicense();
  const [openingTarget, setOpeningTarget] = useState<PurchaseTier | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const refreshedIdentityForKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const licenseState = licenseQuery.data;
    if (!licenseState || licenseState.status !== "active") return;
    if (licenseState.customerName?.trim()) return;

    const identityKey =
      licenseState.displayKey ?? licenseState.customerEmail ?? "active-license";
    if (refreshedIdentityForKeyRef.current === identityKey) return;
    if (refreshLicensePending) return;

    refreshedIdentityForKeyRef.current = identityKey;
    refreshLicense();
  }, [licenseQuery.data, refreshLicense, refreshLicensePending]);

  const openCheckout = async (tier: PurchaseTier) => {
    setOpenError(null);
    setOpeningTarget(tier);
    try {
      const checkoutUrl = checkoutUrlFor(tier, source);
      if (!checkoutUrl) {
        throw new Error(
          `${tier === "commercial" ? "Commercial" : "Personal"} checkout link is not configured for this build.`,
        );
      }
      await openUrl(checkoutUrl);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningTarget(null);
    }
  };

  return (
    <motion.div
      key="account"
      variants={variants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="space-y-6"
    >
      <AccountView
        licenseState={licenseQuery.data ?? null}
        licenseLoading={licenseQuery.isLoading && !licenseQuery.data}
        activating={activateLicense.isPending}
        deactivating={deactivateLicense.isPending}
        openingTarget={openingTarget}
        openError={openError}
        activationError={
          activateLicense.error instanceof Error
            ? activateLicense.error.message
            : activateLicense.error
              ? String(activateLicense.error)
              : null
        }
        deactivationError={
          deactivateLicense.error instanceof Error
            ? deactivateLicense.error.message
            : deactivateLicense.error
              ? String(deactivateLicense.error)
              : null
        }
        onOpenCheckout={openCheckout}
        onActivateLicense={(key) => activateLicense.mutate(key)}
        onDeactivateLicense={() => deactivateLicense.mutate()}
      />
      <DictationStatsPanel />
    </motion.div>
  );
};

export default AccountTab;
