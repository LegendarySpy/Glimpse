import { useLingui } from "@lingui/react/macro";
import { useLicenseState } from "../queries";

interface AccountPillProps {
  onClick: () => void;
}

const AccountPill = ({ onClick }: AccountPillProps) => {
  const { t } = useLingui();
  const { data: license } = useLicenseState();

  const holder =
    license?.customerName?.trim() ||
    license?.customerEmail?.split("@")[0].trim() ||
    "";

  const label =
    holder || t({ id: "home.account.fallback", message: "Account" });

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-full items-center rounded-r-full pl-2.5 pr-3 ui-text-meta ui-color-secondary transition-colors hover:bg-[var(--surface-interactive)] hover:text-content-primary"
    >
      <span className="max-w-[110px] truncate">{label}</span>
    </button>
  );
};

export default AccountPill;
