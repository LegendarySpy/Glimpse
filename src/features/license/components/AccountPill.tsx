import { useLingui } from "@lingui/react/macro";
import { User } from "@phosphor-icons/react";
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

  const label = holder || t({ id: "home.account.fallback", message: "Account" });

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 items-center gap-2 rounded-full border border-border-primary bg-surface-surface pl-1.5 pr-3 shadow-[var(--shadow-sm)] transition-colors hover:border-border-secondary hover:bg-[var(--surface-interactive)]"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border-secondary bg-surface-elevated">
        <User size={14} className="text-content-muted" aria-hidden="true" />
      </span>
      <span className="ui-text-meta ui-color-secondary max-w-[110px] truncate">
        {label}
      </span>
    </button>
  );
};

export default AccountPill;
