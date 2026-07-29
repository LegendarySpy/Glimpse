import { useLingui } from "@lingui/react/macro";
import ToggleSwitch from "../../../shared/ui/ToggleSwitch";
import {
  CLOUD_SPEECH_PROVIDERS,
  getSpeechProviderPreset,
  LOCAL_SPEECH_PROVIDERS,
  supportsSpeechProviderModelDiscovery,
} from "../../../shared/lib/speechProviders";
import { Dropdown } from "../../../shared/ui/Dropdown";
import type { RemoteSpeechProvider } from "../../../types";

type SpeechModelPanelProps = {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  provider: RemoteSpeechProvider;
  setProvider: (value: RemoteSpeechProvider) => void;
  endpoint: string;
  setEndpoint: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  availableModels: string[];
  fetchAvailableModels: () => void;
};

const SpeechModelPanel = ({
  enabled,
  setEnabled,
  provider,
  setProvider,
  endpoint,
  setEndpoint,
  apiKey,
  setApiKey,
  model,
  setModel,
  availableModels,
  fetchAvailableModels,
}: SpeechModelPanelProps) => {
  const { t } = useLingui();
  const providerPreset = getSpeechProviderPreset(provider);
  const hasSelectedProvider = Boolean(providerPreset);
  const canDiscoverModels = supportsSpeechProviderModelDiscovery(provider);
  const uniqueModels = Array.from(
    new Set(availableModels.map((model) => model.trim()).filter(Boolean)),
  );
  const modelValue = model || "auto";

  return (
    <div className="grid row-span-4 [grid-template-rows:subgrid] gap-3 rounded-lg bg-surface-surface p-2.5">
      <div className="px-2 py-1.5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="ui-text-label-strong ui-color-primary">
              {t({
                id: "settings.speech_model.title",
                message: "Remote Speech Provider",
              })}
            </h3>
            <p className="mt-0.5 ui-text-meta ui-color-muted">
              {t({
                id: "settings.speech_model.description",
                message:
                  "Transcribe recordings through OpenAI-compatible cloud or self-hosted APIs.",
              })}
            </p>
          </div>
          <div className="flex shrink-0 items-center">
            <ToggleSwitch
              enabled={enabled}
              onToggle={() => setEnabled(!enabled)}
              ariaLabel={t({
                id: "settings.speech_model.toggle",
                message: "Use this provider for speech-to-text",
              })}
              size="md"
            />
          </div>
        </div>
      </div>

      <div className="px-2">
        <label className="ui-text-label-strong ui-color-primary block">
          {t({
            id: "settings.speech_model.provider",
            message: "Provider",
          })}
        </label>
        <Dropdown
          value={provider}
          onChange={(val) => {
            setProvider(val);
            const preset = getSpeechProviderPreset(val);
            if (preset) {
              setEndpoint(preset.endpoint);
              setModel("auto");
            }
          }}
          editableInput={
            provider === "custom"
              ? {
                  value: endpoint,
                  onChange: setEndpoint,
                  placeholder: t({
                    id: "settings.speech_model.endpoint.placeholder",
                    message: "https://your-speech-endpoint.com",
                  }),
                  ariaLabel: t({
                    id: "settings.speech_model.endpoint.aria",
                    message: "Remote speech endpoint URL",
                  }),
                }
              : undefined
          }
          options={[
            {
              value: "custom" as RemoteSpeechProvider,
              label: t({
                id: "settings.speech_model.provider.custom",
                message: "Custom",
              }),
              description: t({
                id: "settings.speech_model.provider.custom.description",
                message: "Enter your own endpoint URL",
              }),
            },
            {
              value: "_local_header" as RemoteSpeechProvider,
              label: t({
                id: "settings.speech_model.provider.local",
                message: "Local",
              }),
              isHeader: true,
            },
            ...LOCAL_SPEECH_PROVIDERS.map((provider) => ({
              value: provider.id,
              label: provider.label,
              description: provider.endpoint,
            })),
            {
              value: "_cloud_header" as RemoteSpeechProvider,
              label: t({
                id: "settings.speech_model.provider.cloud",
                message: "Cloud (API Key)",
              }),
              isHeader: true,
            },
            ...CLOUD_SPEECH_PROVIDERS.map((provider) => ({
              value: provider.id,
              label: provider.label,
              description: provider.endpoint,
            })),
          ]}
          placeholder={t({
            id: "settings.speech_model.provider.select",
            message: "Select provider...",
          })}
          searchable
          searchPlaceholder={t({
            id: "settings.speech_model.provider.search",
            message: "Search speech providers...",
          })}
          className="mt-2"
          buttonClassName="!rounded-none !border-0 !border-b !border-border-secondary !bg-transparent !px-0.5 !py-1 ui-text-body-sm hover:!border-content-primary focus:!border-content-primary"
          menuClassName="min-w-[240px]"
        />
      </div>

      <div className="px-2">
        <span className="ui-text-label-strong ui-color-primary block">
          {t({
            id: "settings.speech_model.api_key",
            message: "API Key",
          })}{" "}
          {!providerPreset?.apiKeyRequired && (
            <span className="ui-color-disabled">
              {t({
                id: "settings.speech_model.api_key.optional_hint",
                message: "(if required)",
              })}
            </span>
          )}
        </span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            providerPreset?.apiKeyRequired
              ? t({
                  id: "settings.speech_model.api_key.required",
                  message: "Required",
                })
              : t({
                  id: "settings.speech_model.api_key.optional",
                  message: "Optional",
                })
          }
          aria-label={t({
            id: "settings.speech_model.api_key.aria",
            message: "Remote speech API key",
          })}
          className="mt-2 w-full border-b border-border-secondary bg-transparent px-0.5 py-1 ui-text-body-sm ui-color-primary placeholder-content-disabled focus:outline-none focus:border-content-primary transition-colors"
        />
      </div>

      <div className="px-2 pb-1">
        <span className="ui-text-label-strong ui-color-primary block">
          {t({
            id: "settings.speech_model.model",
            message: "Model",
          })}
        </span>
        <Dropdown
          value={modelValue}
          onChange={(val) => setModel(val)}
          onOpen={
            hasSelectedProvider && canDiscoverModels
              ? fetchAvailableModels
              : undefined
          }
          options={[
            {
              value: "auto",
              label: t({
                id: "settings.speech_model.model.automatic",
                message: `Automatic (${providerPreset?.defaultModel || "provider default"})`,
              }),
            },
            ...uniqueModels.map((model) => ({
              value: model,
              label: model,
            })),
            ...(modelValue !== "auto" && !uniqueModels.includes(modelValue)
              ? [{ value: modelValue, label: modelValue }]
              : []),
          ]}
          placeholder={t({
            id: "settings.speech_model.model.placeholder",
            message: `Model (default: ${providerPreset?.defaultModel || "auto"})`,
          })}
          searchable
          searchPlaceholder={t({
            id: "settings.speech_model.model.search",
            message: "Search available speech models...",
          })}
          className="mt-2"
          buttonClassName="!rounded-none !border-0 !border-b !border-border-secondary !bg-transparent !px-0.5 !py-1 ui-text-body-sm hover:!border-content-primary focus:!border-content-primary"
          menuClassName="min-w-[260px]"
        />
      </div>
    </div>
  );
};

export default SpeechModelPanel;
