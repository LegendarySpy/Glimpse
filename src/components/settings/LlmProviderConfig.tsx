import { useState } from "react";
import { Server, Key, Cpu } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Dropdown } from "../Dropdown";

export type LlmProvider = "none" | "lmstudio" | "ollama" | "openai" | "anthropic" | "google" | "xai" | "groq" | "cerebras" | "sambanova" | "together" | "openrouter" | "perplexity" | "deepseek" | "fireworks" | "mistral" | "custom";

export type LlmProviderPreset = {
    id: LlmProvider;
    label: string;
    endpoint: string;
    defaultModel: string;
    apiKeyRequired: boolean;
};


// To add another provider, add the provider here, but also add it at about line ~140 in settings.rs
export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
    { id: "lmstudio", label: "LM Studio", endpoint: "http://localhost:1234", defaultModel: "local-model", apiKeyRequired: false },
    { id: "ollama", label: "Ollama", endpoint: "http://localhost:11434", defaultModel: "llama3.2", apiKeyRequired: false },
    { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com", defaultModel: "gpt-4o-mini", apiKeyRequired: true },
    { id: "anthropic", label: "Anthropic", endpoint: "https://api.anthropic.com", defaultModel: "claude-3-5-sonnet-20241022", apiKeyRequired: true },
    { id: "google", label: "Google Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-1.5-flash", apiKeyRequired: true },
    { id: "xai", label: "xAI (Grok)", endpoint: "https://api.x.ai", defaultModel: "grok-beta", apiKeyRequired: true },
    { id: "groq", label: "Groq", endpoint: "https://api.groq.com/openai", defaultModel: "llama-3.3-70b-versatile", apiKeyRequired: true },
    { id: "cerebras", label: "Cerebras", endpoint: "https://api.cerebras.ai", defaultModel: "llama-3.3-70b", apiKeyRequired: true },
    { id: "sambanova", label: "SambaNova", endpoint: "https://api.sambanova.ai", defaultModel: "Meta-Llama-3.3-70B-Instruct", apiKeyRequired: true },
    { id: "together", label: "Together AI", endpoint: "https://api.together.xyz", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", apiKeyRequired: true },
    { id: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.ai/api", defaultModel: "openai/gpt-4o-mini", apiKeyRequired: true },
    { id: "perplexity", label: "Perplexity", endpoint: "https://api.perplexity.ai", defaultModel: "llama-3.1-sonar-large-128k-online", apiKeyRequired: true },
    { id: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com", defaultModel: "deepseek-chat", apiKeyRequired: true },
    { id: "fireworks", label: "Fireworks", endpoint: "https://api.fireworks.ai/inference", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct", apiKeyRequired: true },
    { id: "mistral", label: "Mistral", endpoint: "https://api.mistral.ai", defaultModel: "mistral-small-latest", apiKeyRequired: true },
];

type LlmProviderConfigProps = {
    provider: LlmProvider;
    setProvider: (p: LlmProvider) => void;
    endpoint: string;
    setEndpoint: (e: string) => void;
    apiKey: string;
    setApiKey: (k: string) => void;
    model: string;
    setModel: (m: string) => void;
    showModelDropdown?: boolean;
};

export function LlmProviderConfig({
    provider,
    setProvider,
    endpoint,
    setEndpoint,
    apiKey,
    setApiKey,
    model,
    setModel,
    showModelDropdown = true,
}: LlmProviderConfigProps) {
    const [availableModels, setAvailableModels] = useState<string[]>([]);

    const currentPreset = LLM_PROVIDER_PRESETS.find(p => p.id === provider);

    const fetchModels = async () => {
        if (!endpoint) return;
        try {
            const models = await invoke<string[]>("fetch_llm_models", {
                endpoint,
                provider,
                apiKey,
            });
            setAvailableModels(models);
        } catch {
            setAvailableModels([]);
        }
    };

    const handleProviderSelect = (presetId: string) => {
        const preset = LLM_PROVIDER_PRESETS.find(p => p.id === presetId);
        if (preset) {
            setProvider(preset.id);
            setEndpoint(preset.endpoint);
            setModel(preset.defaultModel);
        } else {
            setProvider(presetId as LlmProvider);
        }
    };

    return (
        <div className="space-y-3">
            <div className="space-y-1.5">
                <Dropdown
                    label="Provider"
                    value={provider}
                    onChange={handleProviderSelect}
                    options={LLM_PROVIDER_PRESETS.map(p => ({
                        value: p.id,
                        label: p.label,
                        description: p.apiKeyRequired ? "Requires API Key" : undefined
                    }))}
                    searchable
                    searchPlaceholder="Search providers..."
                    placeholder="Select a provider..."
                />
            </div>

            <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-content-muted ml-1 flex items-center gap-1.5">
                    <Server size={10} />
                    Endpoint
                </label>
                <input
                    type="text"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    placeholder={currentPreset?.endpoint ?? "https://your-llm-endpoint.com"}
                    className="w-full rounded-lg bg-surface-elevated border border-border-secondary py-2 px-3 text-[12px] text-content-primary placeholder-content-disabled focus:border-content-disabled focus:outline-none transition-colors"
                />
            </div>

            <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-content-muted ml-1 flex items-center gap-1.5">
                    <Key size={10} />
                    API Key {!currentPreset?.apiKeyRequired && <span className="text-content-disabled">(if required)</span>}
                </label>
                <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={currentPreset?.apiKeyRequired ? "Required" : "Optional"}
                    className="w-full rounded-lg bg-surface-elevated border border-border-secondary py-2 px-3 text-[12px] text-content-primary placeholder-content-disabled focus:border-content-disabled focus:outline-none transition-colors"
                />
            </div>

            {showModelDropdown ? (
                <div className="space-y-1.5">
                    <Dropdown
                        label="Model"
                        value={model}
                        onChange={(val) => setModel(val)}
                        onOpen={fetchModels}
                        options={[
                            {
                                value: "",
                                label: `Default (${currentPreset?.defaultModel || "None"})`
                            },
                            ...(model && !availableModels.includes(model) ? [{ value: model, label: model }] : []),
                            ...availableModels.map(m => ({ value: m, label: m }))
                        ]}
                        placeholder="Select a model"
                        searchable
                        searchPlaceholder="Search or type model..."
                        icon={<Cpu size={14} />}
                    />
                </div>
            ) : (
                <div className="space-y-1.5">
                    <label className="text-[11px] font-medium text-content-muted ml-1 flex items-center gap-1.5">
                        <Cpu size={10} />
                        Model <span className="text-content-disabled">(leave empty for default)</span>
                    </label>
                    <input
                        type="text"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder={currentPreset?.defaultModel || "model-name"}
                        className="w-full rounded-lg bg-surface-elevated border border-border-secondary py-2 px-3 text-[12px] text-content-primary placeholder-content-disabled focus:border-content-disabled focus:outline-none transition-colors"
                    />
                </div>
            )}
        </div>
    );
}
