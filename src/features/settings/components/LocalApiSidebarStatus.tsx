import { useLingui } from "@lingui/react/macro";
import { useCopyToClipboard } from "../../../shared/hooks/useCopyToClipboard";
import {
  ArrowsDownUp as ArrowUpDown,
  Check,
  Copy,
  GearSix as Settings2,
} from "@phosphor-icons/react";
import ActivityDots from "../../../shared/ui/ActivityDots";
import type { LocalApiStatus } from "../../../types";

const SIDEBAR_TRANSITION =
  "transition-[width,opacity,max-height] duration-200 ease-out";

const LocalApiSidebarStatus = ({
  collapsed,
  status,
  onOpenSettings,
}: {
  collapsed: boolean;
  status: LocalApiStatus;
  onOpenSettings: () => void;
}) => {
  const { t } = useLingui();
  const { copied, copy } = useCopyToClipboard(1200);

  const host = status.host || "127.0.0.1";
  const baseUrl = `http://${host}:${status.port}/v1`;
  const displayUrl = `${host}:${status.port}/v1`;
  const requests = status.requests_total ?? 0;

  const copyBaseUrl = () => copy(baseUrl);

  const runningLabel = t({
    id: "home.local_api.running",
    message: "Local API",
  });
  const requestsLabel = t({
    id: "home.local_api.requests",
    message: "Requests served",
  });
  const openSettingsLabel = t({
    id: "home.local_api.open_settings",
    message: "Open API server settings",
  });
  const statusHint = t({
    id: "home.local_api.status_hint",
    message: "Your API server is running in the background.",
  });
  const collapsedTitle = `${runningLabel}: ${statusHint} ${displayUrl} · ${requests} ${requestsLabel.toLowerCase()}. ${openSettingsLabel}.`;

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={onOpenSettings}
        title={collapsed ? collapsedTitle : openSettingsLabel}
        aria-label={`${runningLabel}. ${statusHint} ${openSettingsLabel}`}
        className={`group flex w-full items-center rounded-lg h-9 pl-[var(--sidebar-icon-pl,17px)] pr-3 text-left text-content-muted hover:bg-[var(--surface-interactive)] hover:text-content-secondary ${
          collapsed ? "gap-0" : "gap-3"
        }`}
      >
        <div className="flex w-[20px] shrink-0 items-center justify-center">
          <ActivityDots />
        </div>
        <div
          style={{
            width: collapsed ? 0 : "auto",
            opacity: collapsed ? 0 : 1,
          }}
          className={`flex min-w-0 flex-1 items-center justify-between gap-2 overflow-hidden whitespace-nowrap ${SIDEBAR_TRANSITION}`}
        >
          <span className="ui-text-nav-item ui-color-secondary group-hover:text-content-secondary">
            {runningLabel}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span
              title={requestsLabel}
              className="flex items-center gap-1 text-[11px] tabular-nums ui-color-muted group-hover:text-content-secondary"
            >
              <ArrowUpDown size={11} aria-hidden="true" />
              {requests}
            </span>
            <Settings2
              size={13}
              className="ui-color-disabled opacity-0 transition-opacity group-hover:opacity-100 group-hover:ui-color-muted"
              aria-hidden="true"
            />
          </span>
        </div>
      </button>

      <div
        aria-hidden={collapsed}
        className={`overflow-hidden ${SIDEBAR_TRANSITION} ${
          collapsed
            ? "max-h-0 opacity-0 pointer-events-none"
            : "max-h-6 opacity-100"
        }`}
      >
        <button
          type="button"
          onClick={copyBaseUrl}
          tabIndex={collapsed ? -1 : 0}
          className="group flex h-6 w-full items-center gap-1.5 pl-[var(--sidebar-icon-pl,17px)] pr-3 text-left"
          aria-label={t({
            id: "home.local_api.copy_url",
            message: "Copy base URL",
          })}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] ui-color-muted transition-colors group-hover:ui-color-secondary">
            {displayUrl}
          </span>
          {copied ? (
            <Check size={12} className="shrink-0 ui-color-secondary" />
          ) : (
            <Copy
              size={12}
              className="shrink-0 ui-color-disabled transition-colors group-hover:ui-color-muted"
            />
          )}
        </button>
      </div>
    </div>
  );
};

export default LocalApiSidebarStatus;
