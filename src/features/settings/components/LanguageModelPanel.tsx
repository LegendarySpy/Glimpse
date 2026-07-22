import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLingui } from "@lingui/react/macro";
import ToggleSwitch from "../../../shared/ui/ToggleSwitch";
import {
  CLOUD_PROVIDERS,
  getProviderPreset,
  LOCAL_PROVIDERS,
} from "../../../shared/lib/llmProviders";
import type { LlmProvider } from "../../../types";
import { Dropdown } from "../../../shared/ui/Dropdown";
import { detectAppPlatform } from "../../../platform/service";

type AppleLlmAvailability =
  "available" | "not_enabled" | "not_ready" | "unsupported";

type LanguageModelPanelProps = {
  llmEnabled: boolean;
  setLlmEnabled: (value: boolean) => void;
  llmProvider: LlmProvider;
  setLlmProvider: (value: LlmProvider) => void;
  llmEndpoint: string;
  setLlmEndpoint: (value: string) => void;
  llmApiKey: string;
  setLlmApiKey: (value: string) => void;
  llmModel: string;
  setLlmModel: (value: string) => void;
  availableModels: string[];
  fetchAvailableModels: () => void;
};

const LanguageModelPanel = ({
  llmEnabled,
  setLlmEnabled,
  llmProvider,
  setLlmProvider,
  llmEndpoint,
  setLlmEndpoint,
  llmApiKey,
  setLlmApiKey,
  llmModel,
  setLlmModel,
  availableModels,
  fetchAvailableModels,
}: LanguageModelPanelProps) => {
  const { t } = useLingui();
  const providerPreset = getProviderPreset(llmProvider);
  const hasSelectedProvider = Boolean(providerPreset);
  const isOnDevice = Boolean(providerPreset?.onDevice);
  const isMac = detectAppPlatform() === "macos";
  const [appleAvailability, setAppleAvailability] =
    useState<AppleLlmAvailability | null>(null);
  const uniqueModels = Array.from(
    new Set(availableModels.map((model) => model.trim()).filter(Boolean)),
  );

  useEffect(() => {
    if (!isMac) {
      return;
    }
    let cancelled = false;
    invoke<AppleLlmAvailability>("apple_llm_availability")
      .then((value) => {
        if (!cancelled) setAppleAvailability(value);
      })
      .catch(() => {
        if (!cancelled) setAppleAvailability("unsupported");
      });
    return () => {
      cancelled = true;
    };
  }, [isMac]);

  // Backend probe hides this on Windows, Intel Macs, and macOS < 26.
  const showAppleProvider =
    isMac && appleAvailability !== null && appleAvailability !== "unsupported";

  const appleStatusText =
    appleAvailability === null
      ? " "
      : appleAvailability === "not_enabled"
        ? t({
            id: "settings.language_model.apple.not_enabled",
            message:
              "Turn on Apple Intelligence in System Settings to use this.",
          })
        : appleAvailability === "not_ready"
          ? t({
              id: "settings.language_model.apple.not_ready",
              message: "The Apple Intelligence model is still downloading.",
            })
          : appleAvailability === "unsupported"
            ? t({
                id: "settings.language_model.apple.unsupported",
                message: "Not supported on this Mac.",
              })
            : t({
                id: "settings.language_model.apple.ready",
                message: "Built into this Mac.",
              });

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface-surface p-2.5">
      <div className="px-2 py-1.5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="ui-text-label-strong ui-color-primary">
              {t({
                id: "settings.language_model.title",
                message: "Writing Model Provider",
              })}
            </h3>
            <p className="mt-0.5 ui-text-meta ui-color-muted">
              {t({
                id: "settings.language_model.description",
                message: "Used by Cleanup, Edit Mode, and Personalization.",
              })}
            </p>
          </div>
          <div className="flex shrink-0 items-center">
            <ToggleSwitch
              enabled={llmEnabled}
              onToggle={() => setLlmEnabled(!llmEnabled)}
              ariaLabel={t({
                id: "settings.language_model.toggle",
                message: "Use this provider for AI writing features",
              })}
              size="md"
            />
          </div>
        </div>
      </div>

      <div className="px-2">
        <label className="ui-text-label-strong ui-color-primary block">
          {t({
            id: "settings.language_model.provider",
            message: "Provider",
          })}
        </label>
        <Dropdown
          value={llmProvider}
          onChange={(val) => {
            setLlmProvider(val);
            const preset = getProviderPreset(val);
            if (preset) {
              setLlmEndpoint(preset.endpoint);
              setLlmModel(preset.defaultModel);
            }
          }}
          editableInput={
            llmProvider === "custom"
              ? {
                  value: llmEndpoint,
                  onChange: setLlmEndpoint,
                  placeholder: t({
                    id: "settings.language_model.endpoint.placeholder",
                    message: "https://your-llm-endpoint.com",
                  }),
                  ariaLabel: t({
                    id: "settings.language_model.endpoint.aria",
                    message: "LLM Endpoint URL",
                  }),
                }
              : undefined
          }
          options={[
            {
              value: "custom" as LlmProvider,
              label: t({
                id: "settings.language_model.provider.custom",
                message: "Custom",
              }),
              description: t({
                id: "settings.language_model.provider.custom.description",
                message: "Enter your own endpoint URL",
              }),
            },
            {
              value: "_local_header" as LlmProvider,
              label: t({
                id: "settings.language_model.provider.local",
                message: "Local",
              }),
              isHeader: true,
            },
            ...LOCAL_PROVIDERS.filter(
              (p) => p.id !== "custom" && (!p.onDevice || showAppleProvider),
            ).map((p) => ({
              value: p.id,
              label: p.label,
              description: p.onDevice
                ? t({
                    id: "settings.language_model.provider.on_device",
                    message: "On-device",
                  })
                : p.endpoint,
            })),
            {
              value: "_cloud_header" as LlmProvider,
              label: t({
                id: "settings.language_model.provider.cloud",
                message: "Cloud (API Key)",
              }),
              isHeader: true,
            },
            ...CLOUD_PROVIDERS.map((p) => ({
              value: p.id,
              label: p.label,
              description: p.endpoint,
            })),
          ]}
          placeholder={t({
            id: "settings.language_model.provider.select",
            message: "Select provider...",
          })}
          searchable
          searchPlaceholder={t({
            id: "settings.language_model.provider.search",
            message: "Search providers...",
          })}
          className="mt-2"
          buttonClassName="!rounded-none !border-0 !border-b !border-border-secondary !bg-transparent !px-0.5 !py-1 ui-text-body-sm hover:!border-content-primary focus:!border-content-primary"
          menuClassName="min-w-[240px]"
        />
      </div>

      {isOnDevice && (
        <div className="px-2 pb-1">
          <p className="ui-text-meta ui-color-muted">{appleStatusText}</p>
        </div>
      )}

      {!isOnDevice && (
        <div className="px-2">
          <span className="ui-text-label-strong ui-color-primary block">
            {t({
              id: "settings.language_model.api_key",
              message: "API Key",
            })}{" "}
            {!providerPreset?.apiKeyRequired && (
              <span className="ui-color-disabled">
                {t({
                  id: "settings.language_model.api_key.optional_hint",
                  message: "(if required)",
                })}
              </span>
            )}
          </span>
          <input
            type="password"
            value={llmApiKey}
            onChange={(e) => setLlmApiKey(e.target.value)}
            placeholder={
              providerPreset?.apiKeyRequired
                ? t({
                    id: "settings.language_model.api_key.required",
                    message: "Required",
                  })
                : t({
                    id: "settings.language_model.api_key.optional",
                    message: "Optional",
                  })
            }
            aria-label={t({
              id: "settings.language_model.api_key.aria",
              message: "LLM API Key",
            })}
            className="mt-2 w-full border-b border-border-secondary bg-transparent px-0.5 py-1 ui-text-body-sm ui-color-primary placeholder-content-disabled focus:outline-none focus:border-content-primary transition-colors"
          />
        </div>
      )}

      {!isOnDevice && (
        <div className="px-2 pb-1">
          <span className="ui-text-label-strong ui-color-primary block">
            {t({
              id: "settings.language_model.model",
              message: "Model",
            })}
          </span>
          <Dropdown
            value={llmModel}
            onChange={(val) => setLlmModel(val)}
            onOpen={hasSelectedProvider ? fetchAvailableModels : undefined}
            options={[
              ...uniqueModels.map((model) => ({
                value: model,
                label: model,
              })),
              ...(llmModel && !uniqueModels.includes(llmModel)
                ? [{ value: llmModel, label: llmModel }]
                : []),
            ]}
            placeholder={t({
              id: "settings.language_model.model.placeholder",
              message: `Model (default: ${providerPreset?.defaultModel || "none"})`,
            })}
            searchable
            searchPlaceholder={t({
              id: "settings.language_model.model.search",
              message: "Search available models...",
            })}
            className="mt-2"
            buttonClassName="!rounded-none !border-0 !border-b !border-border-secondary !bg-transparent !px-0.5 !py-1 ui-text-body-sm hover:!border-content-primary focus:!border-content-primary"
            menuClassName="min-w-[260px]"
          />
        </div>
      )}
    </div>
  );
};

export default LanguageModelPanel;
