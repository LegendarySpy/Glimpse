import { Lock, type Icon as PhosphorIcon } from "@phosphor-icons/react";

export interface SidebarItemProps {
  icon: PhosphorIcon;
  label: string;
  active?: boolean;
  collapsed: boolean;
  locked?: boolean;
  lockedHint?: string;
  onClick?: () => void;
}

const SidebarItem = ({
  icon: Icon,
  label,
  active,
  collapsed,
  locked,
  lockedHint,
  onClick,
}: SidebarItemProps) => (
  <button
    onClick={onClick}
    title={locked ? lockedHint : undefined}
    data-active={active ? "true" : "false"}
    className={`ui-nav-item group h-9 pl-[var(--sidebar-icon-pl,17px)] pr-3 mb-[2px] ${
      collapsed ? "gap-0" : "gap-3"
    } ${locked ? "opacity-45 hover:opacity-75" : ""}`}
  >
    <div className="flex items-center justify-center w-[20px] shrink-0">
      <Icon size={20} weight={active ? "fill" : "regular"} />
    </div>
    <span
      style={{ width: collapsed ? 0 : "auto", opacity: collapsed ? 0 : 1 }}
      className={`ui-text-nav-item whitespace-nowrap overflow-hidden transition-[width,opacity] duration-200 ease-out ${
        active ? "font-medium" : "font-normal"
      }`}
    >
      {label}
    </span>
    {locked && !collapsed ? (
      <Lock size={12} className="ml-auto shrink-0" aria-hidden="true" />
    ) : null}
  </button>
);

export default SidebarItem;
