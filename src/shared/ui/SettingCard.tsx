import type { ReactNode } from "react";

const SettingCard = ({
  children,
  equalizeRows = false,
  flush = false,
  className = "",
}: {
  children: ReactNode;
  equalizeRows?: boolean;
  flush?: boolean;
  className?: string;
}) => (
  <div
    className={`rounded-lg bg-surface-surface ${flush ? "" : "p-2.5"} ${
      equalizeRows ? "grid auto-rows-fr" : ""
    } ${className}`}
  >
    {children}
  </div>
);

export default SettingCard;
