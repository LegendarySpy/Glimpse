import { useLingui } from "@lingui/react/macro";
import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { useCopyToClipboard } from "../../../../shared/hooks/useCopyToClipboard";
import { motion, type Variants } from "framer-motion";
import ToggleSwitch from "../../../../shared/ui/ToggleSwitch";
import { Dropdown } from "../../../../shared/ui/Dropdown";
import DotMatrix from "../../../../shared/ui/DotMatrix";
import ActivityDots from "../../../../shared/ui/ActivityDots";
import SectionLabel from "../../../../shared/ui/SectionLabel";
import type { LocalApiStatus, ModelInfo, ModelStatus } from "../../../../types";

type LocalApiTabProps = {
  variants: Variants;
  modelCatalog: ModelInfo[];
  modelStatus: Record<string, ModelStatus>;
  apiKey: string;
  setApiKey: (value: string) => void;
  port: number;
  setPort: (value: number) => void;
  model: string;
  setModel: (value: string) => void;
  host: string;
  setHost: (value: string) => void;
  startOnLaunch: boolean;
  setStartOnLaunch: (value: boolean) => void;
  cors: boolean;
  setCors: (value: boolean) => void;
  status: LocalApiStatus | null;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onClearLogs: () => void;
};

const LocalApiTab = ({
  variants,
  modelCatalog,
  modelStatus,
  apiKey,
  setApiKey,
  port,
  setPort,
  model,
  setModel,
  host,
  setHost,
  startOnLaunch,
  setStartOnLaunch,
  cors,
  setCors,
  status,
  busy,
  onStart,
  onStop,
  onRestart,
  onClearLogs,
}: LocalApiTabProps) => {
  const { t } = useLingui();
  const { copied, copy: copyUrl } = useCopyToClipboard(1200);
  const { copied: logsCopied, copy: copyLogsText } = useCopyToClipboard(1200);
  const [runningApiKeySnapshot, setRunningApiKeySnapshot] = useState<{
    configId: number;
    value: string;
  } | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const installedModels = modelCatalog.filter(
    (entry) => modelStatus[entry.key]?.installed,
  );
  const running = status?.running ?? false;
  const logs = status?.logs ?? [];
  const effectiveHost = running ? (status?.host ?? host) : host;
  const effectivePort = running ? (status?.port ?? port) : port;
  const baseUrl = `http://${effectiveHost}:${effectivePort}/v1`;
  const requireApiKey = apiKey.trim().length > 0;
  const configuredApiKey = requireApiKey ? apiKey.trim() : "";
  const lanEnabled = host === "0.0.0.0";
  const lanRequiresApiKey = lanEnabled && !requireApiKey;
  const runningConfigId = status?.config_id ?? null;
  const runningApiKey =
    runningApiKeySnapshot?.configId === runningConfigId
      ? runningApiKeySnapshot.value
      : configuredApiKey;
  const restartRequired =
    running &&
    ((status?.host ?? host) !== host ||
      (status?.port ?? port) !== port ||
      (status?.model ?? model) !== model ||
      (status?.api_key_required ?? requireApiKey) !== requireApiKey ||
      runningApiKey !== configuredApiKey ||
      (status?.cors ?? cors) !== cors);

  const modelOptions = useMemo(() => {
    return [
      {
        value: "auto",
        label: t({
          id: "settings.local_api.model.none",
          message: "None",
        }),
      },
      ...installedModels.map((entry) => ({
        value: entry.key,
        label: entry.label,
      })),
    ];
  }, [installedModels, t]);

  const modelLabelByKey = useMemo(() => {
    const map = new Map(modelCatalog.map((entry) => [entry.key, entry.label]));
    map.set(
      "auto",
      t({
        id: "settings.local_api.model.none",
        message: "None",
      }),
    );
    return map;
  }, [modelCatalog, t]);

  const loadedModelLabel = status?.loaded_model
    ? (modelLabelByKey.get(status.loaded_model) ?? status.loaded_model)
    : t({
        id: "settings.local_api.model.none",
        message: "None",
      });

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  useEffect(() => {
    if (!running || runningConfigId === null) {
      setRunningApiKeySnapshot(null);
      return;
    }

    setRunningApiKeySnapshot((current) =>
      current?.configId === runningConfigId
        ? current
        : { configId: runningConfigId, value: configuredApiKey },
    );
  }, [configuredApiKey, running, runningConfigId]);

  const copyBaseUrl = () => copyUrl(baseUrl);

  const copyLogs = useCallback(() => {
    if (logs.length === 0) return;
    const text = logs
      .map((entry) => `[${entry.level}] ${entry.message}`)
      .join("\n");
    copyLogsText(text);
  }, [logs, copyLogsText]);

  return (
    <motion.div
      key="local-api"
      variants={variants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="flex h-full flex-col gap-6"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            {running ? (
              <span className="opacity-80">
                <ActivityDots
                  dotSize={3}
                  gap={2}
                  color="var(--color-text-muted)"
                />
              </span>
            ) : (
              <DotMatrix
                rows={2}
                cols={2}
                activeDots={[]}
                dotSize={3}
                gap={2}
                color="var(--color-text-muted)"
                className="opacity-40"
                aria-hidden="true"
              />
            )}
            <h2 className="ui-text-title-lg font-medium ui-color-primary">
              {running
                ? t({
                    id: "settings.local_api.status.running",
                    message: "Running",
                  })
                : t({
                    id: "settings.local_api.status.stopped",
                    message: "Stopped",
                  })}
            </h2>
          </div>
          <button
            className="mt-1 ui-text-body-sm ui-color-muted hover:ui-color-primary transition-colors inline-flex items-center gap-1.5 group"
            onClick={copyBaseUrl}
            type="button"
          >
            <span>
              {copied
                ? t({
                    id: "settings.local_api.copy.copied_exclaim",
                    message: "Copied!",
                  })
                : baseUrl}
            </span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="opacity-60 group-hover:opacity-100 transition-opacity"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onRestart}
            disabled={busy || !restartRequired || !running || lanRequiresApiKey}
            className={`mt-0.5 ui-text-label ui-color-warning flex items-center gap-1 hover:brightness-110 transition-opacity duration-200 group ${restartRequired ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          >
            <span>
              {t({
                id: "settings.local_api.restart_required",
                message: "Restart to apply changes",
              })}
            </span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-transform duration-200 group-hover:scale-110"
              aria-hidden="true"
            >
              <path d="M12 2v10" />
              <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
            </svg>
          </button>
        </div>

        {running ? (
          <button
            className="ml-6 min-w-[92px] shrink-0 whitespace-nowrap px-5 py-1.5 rounded-md bg-red-500 hover:bg-red-400 text-white ui-text-button-sm font-semibold transition-all shadow-[0_3px_0_-1px_rgba(248,113,113,0.35),inset_0_1px_0_0_rgba(255,255,255,0.15)] active:translate-y-[1px] active:shadow-none"
            onClick={onStop}
            disabled={busy}
          >
            {t({
              id: "settings.local_api.stop",
              message: "Stop API",
            })}
          </button>
        ) : (
          <button
            className="ml-6 min-w-[92px] shrink-0 whitespace-nowrap px-5 py-1.5 rounded-md bg-content-primary hover:bg-content-secondary text-surface-secondary ui-text-button-sm font-semibold transition-all shadow-[0_3px_0_-1px_rgba(255,255,255,0.25),inset_0_1px_0_0_rgba(255,255,255,0.1)] active:translate-y-[1px] active:shadow-none"
            onClick={onStart}
            disabled={busy || lanRequiresApiKey}
          >
            {t({
              id: "settings.local_api.start",
              message: "Start API",
            })}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 items-stretch">
        <div className="space-y-2 flex flex-col">
          <SectionLabel className="shrink-0">
            {t({
              id: "settings.local_api.configuration",
              message: "Configuration",
            })}
          </SectionLabel>

          <div className="flex-1 rounded-lg bg-surface-surface p-2.5 space-y-6">
            <div className="px-2 py-1.5 flex gap-5">
              <label className="shrink-0">
                <span className="ui-text-label-strong ui-color-primary block">
                  {t({
                    id: "settings.local_api.port",
                    message: "Port",
                  })}
                </span>
                <input
                  className="mt-1.5 w-[46px] border-b border-border-secondary bg-transparent px-0.5 py-1 ui-text-body-sm ui-color-primary focus:outline-none focus:border-content-primary transition-colors tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(event) => {
                    const value = Number(event.target.value) || 11435;
                    setPort(Math.min(65535, Math.max(1, value)));
                  }}
                />
              </label>
              <div className="flex-1 min-w-0 relative">
                <span className="ui-text-label-strong ui-color-primary block">
                  {t({
                    id: "settings.local_api.api_key",
                    message: "API key",
                  })}
                </span>
                <input
                  className="mt-1.5 w-full border-b border-border-secondary bg-transparent px-0.5 py-1 ui-text-body-sm ui-color-primary focus:outline-none focus:border-content-primary transition-colors"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={
                    lanEnabled
                      ? t({
                          id: "settings.local_api.api_key.placeholder_required",
                          message: "Required for LAN access",
                        })
                      : t({
                          id: "settings.local_api.api_key.placeholder_optional",
                          message: "Optional - blank to disable",
                        })
                  }
                />
                <span
                  className={`absolute left-0 top-full mt-1 ui-text-micro ui-color-warning transition-opacity duration-200 ${lanRequiresApiKey ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                  aria-hidden={!lanRequiresApiKey}
                >
                  {t({
                    id: "settings.local_api.api_key.lan_required",
                    message: "Required when listening on LAN",
                  })}
                </span>
              </div>
            </div>

            <div className="px-2 py-1.5">
              <span className="ui-text-label-strong ui-color-primary block">
                {t({
                  id: "settings.local_api.preloaded_model",
                  message: "Preloaded model",
                })}
              </span>
              <div className="mt-1.5 relative z-10">
                <Dropdown
                  value={model}
                  onChange={setModel}
                  options={modelOptions}
                  buttonClassName="!rounded-none !border-0 !border-b !border-border-secondary !bg-transparent !px-0.5 !py-1 ui-text-body-sm hover:!border-content-primary focus:!border-content-primary"
                  truncate={false}
                />
              </div>
              <span className="ui-text-micro ui-color-disabled block mt-1">
                {model === "auto"
                  ? running && status?.loaded_model
                    ? t({
                        id: "settings.local_api.model.currently_loaded",
                        message: `currently loaded: ${loadedModelLabel}`,
                      })
                    : t({
                        id: "settings.local_api.model.none_held",
                        message: "no model held in memory between requests",
                      })
                  : t({
                      id: "settings.local_api.model.kept_warm",
                      message: "kept warm in memory for fast responses",
                    })}
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-2 flex flex-col">
          <SectionLabel className="shrink-0">
            {t({
              id: "settings.local_api.behavior",
              message: "Behavior",
            })}
          </SectionLabel>

          <div className="flex-1 rounded-lg bg-surface-surface p-2.5 space-y-6">
            <div className="px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="ui-text-label-strong ui-color-primary">
                  {t({
                    id: "settings.local_api.listen_on_lan",
                    message: "Listen on LAN",
                  })}
                </span>
                <ToggleSwitch
                  enabled={lanEnabled}
                  onToggle={() => setHost(lanEnabled ? "127.0.0.1" : "0.0.0.0")}
                  ariaLabel={t({
                    id: "settings.local_api.listen_on_lan_aria",
                    message: "Listen on LAN",
                  })}
                />
              </div>
              <span className="ui-text-micro ui-color-disabled block mt-0.5">
                {t({
                  id: "settings.local_api.listen_on_lan_help",
                  message: "expose to other devices on your network",
                })}
              </span>
            </div>

            <div className="px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="ui-text-label-strong ui-color-primary">
                  {t({
                    id: "settings.local_api.start_on_launch",
                    message: "Start on launch",
                  })}
                </span>
                <ToggleSwitch
                  enabled={startOnLaunch}
                  onToggle={() => setStartOnLaunch(!startOnLaunch)}
                  ariaLabel={t({
                    id: "settings.local_api.start_on_launch_aria",
                    message: "Start local API when Glimpse opens",
                  })}
                />
              </div>
              <span className="ui-text-micro ui-color-disabled block mt-0.5">
                {t({
                  id: "settings.local_api.start_on_launch_help",
                  message: "automatically start when Glimpse opens",
                })}
              </span>
            </div>

            <div className="px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="ui-text-label-strong ui-color-primary">
                  {t({
                    id: "settings.local_api.allow_browser_requests",
                    message: "Allow browser requests",
                  })}
                </span>
                <ToggleSwitch
                  enabled={cors}
                  onToggle={() => setCors(!cors)}
                  ariaLabel={t({
                    id: "settings.local_api.allow_browser_requests_aria",
                    message: "Allow cross-origin browser requests",
                  })}
                />
              </div>
              <span className="ui-text-micro ui-color-disabled block mt-0.5">
                {t({
                  id: "settings.local_api.allow_browser_requests_help",
                  message: "send CORS headers so web apps can call the API",
                })}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <SectionLabel className="flex-1">
            {t({
              id: "settings.local_api.logs",
              message: "Logs",
            })}
          </SectionLabel>
          <div
            className={`flex shrink-0 items-center gap-3 transition-opacity ${logs.length > 0 ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          >
            <button
              className="ui-text-meta ui-color-muted hover:ui-color-primary transition-colors inline-flex items-center gap-1"
              onClick={copyLogs}
              type="button"
              aria-label={t({
                id: "settings.local_api.logs.copy_aria",
                message: "Copy logs",
              })}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span className="inline-block text-left min-w-[2.75rem]">
                {logsCopied
                  ? t({
                      id: "settings.local_api.logs.copied",
                      message: "Copied",
                    })
                  : t({
                      id: "settings.local_api.logs.copy",
                      message: "Copy",
                    })}
              </span>
            </button>
            <button
              className="ui-text-meta ui-color-muted hover:text-red-400 transition-colors"
              onClick={onClearLogs}
              type="button"
            >
              {t({
                id: "settings.local_api.logs.clear",
                message: "Clear",
              })}
            </button>
          </div>
        </div>

        <div className="h-[210px] overflow-y-auto">
          {logs.length === 0 ? (
            <p className="ui-text-label ui-color-disabled">
              {t({
                id: "settings.local_api.logs.empty",
                message: "No logs yet.",
              })}
            </p>
          ) : (
            <div className="space-y-px selectable">
              {logs.map((entry) => (
                <div
                  key={entry.id}
                  className="ui-text-meta ui-color-api-log font-mono leading-relaxed py-0.5"
                >
                  <span className="ui-color-api-log-level">
                    [{entry.level}]
                  </span>{" "}
                  {entry.message}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};

export default LocalApiTab;
