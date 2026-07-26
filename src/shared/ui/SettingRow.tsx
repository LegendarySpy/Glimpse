import type { ReactNode } from "react";
import ToggleSwitch from "./ToggleSwitch";

const SettingRow = ({
  icon,
  title,
  inlineDescription,
  control,
  description,
  footer,
  children,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  inlineDescription?: ReactNode;
  control?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}) =>
  icon != null ? (
    <div className={`flex flex-col justify-center px-3.5 py-2.5 ${className}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center ui-color-muted">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div className="min-w-[55%] flex-1 break-words ui-text-label-strong ui-color-primary">
              {title}
            </div>
            {control != null && (
              <div className="ms-auto flex shrink-0 items-center">
                {control}
              </div>
            )}
          </div>
          {description != null && (
            <div className="mt-1 break-words ui-text-meta ui-color-disabled">
              {description}
            </div>
          )}
          {footer != null && (
            <div className="mt-2 flex min-h-6 items-center justify-start">
              {footer}
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  ) : (
    <div className={`flex flex-col justify-center px-2 py-1.5 ${className}`}>
      <div
        className={`flex flex-wrap ${
          inlineDescription ? "items-start" : "items-center"
        } gap-x-2 gap-y-1`}
      >
        <div className="flex min-w-[55%] flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="ui-text-label-strong ui-color-primary">{title}</span>
          {inlineDescription != null && (
            <span className="min-w-0 ui-text-meta ui-color-disabled">
              {inlineDescription}
            </span>
          )}
        </div>
        {control != null && (
          <div className="ms-auto flex shrink-0 items-center">{control}</div>
        )}
      </div>
      {description != null && (
        <span className="ui-text-micro ui-color-disabled mt-1 block">
          {description}
        </span>
      )}
      {footer != null && (
        <div className="mt-2 flex min-h-6 items-center justify-start">
          {footer}
        </div>
      )}
      {children}
    </div>
  );

export const ToggleRow = ({
  title,
  description,
  enabled,
  onToggle,
  ariaLabel,
  disabled,
  size,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  enabled: boolean;
  onToggle: () => void;
  ariaLabel: string;
  disabled?: boolean;
  size?: "xs" | "sm" | "md";
  children?: ReactNode;
  className?: string;
}) => (
  <SettingRow
    title={title}
    description={description}
    className={className}
    control={
      <ToggleSwitch
        enabled={enabled}
        onToggle={onToggle}
        ariaLabel={ariaLabel}
        disabled={disabled}
        size={size}
      />
    }
  >
    {children}
  </SettingRow>
);

export default SettingRow;
