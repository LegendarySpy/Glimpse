import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, ChevronDown, Server, Key, Cpu } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

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
    const [providerDropdownOpen, setProviderDropdownOpen] = useState(false);
    const [providerSearch, setProviderSearch] = useState("");
    const providerDropdownRef = useRef<HTMLDivElement>(null);

    const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const modelDropdownRef = useRef<HTMLDivElement>(null);

    const currentPreset = LLM_PROVIDER_PRESETS.find(p => p.id === provider);

    useEffect(() => {
        if (!providerDropdownOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (providerDropdownRef.current && !providerDropdownRef.current.contains(event.target as Node)) {
                setProviderDropdownOpen(false);
                setProviderSearch("");
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setProviderDropdownOpen(false);
                setProviderSearch("");
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEscape);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [providerDropdownOpen]);

    useEffect(() => {
        if (!modelDropdownOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
                setModelDropdownOpen(false);
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setModelDropdownOpen(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEscape);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [modelDropdownOpen]);

    const fetchModels = async () => {
        if (!endpoint) return;
        setModelsLoading(true);
        try {
            const models = await invoke<string[]>("fetch_llm_models", {
                endpoint,
                provider,
                apiKey,
            });
            setAvailableModels(models);
        } catch {
            setAvailableModels([]);
        } finally {
            setModelsLoading(false);
        }
    };

    useEffect(() => {
        if (modelDropdownOpen) {
            fetchModels();
        }
    }, [modelDropdownOpen]);

    const handleProviderSelect = (preset: LlmProviderPreset) => {
        setProvider(preset.id);
        setEndpoint(preset.endpoint);
        setModel(preset.defaultModel);
        setProviderDropdownOpen(false);
        setProviderSearch("");
    };

    return (
        <div className="space-y-3">
            <div className="space-y-1.5" ref={providerDropdownRef}>
                <label className="text-[11px] font-medium text-content-muted ml-1">Provider</label>
                <div className="relative">
                    <button
                        type="button"
                        onClick={() => setProviderDropdownOpen(!providerDropdownOpen)}
                        className="w-full flex items-center justify-between rounded-lg bg-surface-elevated border border-border-secondary py-2 px-3 text-[12px] text-left hover:border-border-hover focus:border-content-disabled focus:outline-none transition-colors"
                    >
                        <div className="flex items-center gap-2">
                            <Search size={12} className="text-content-muted" />
                            <span className={provider !== "none" && provider !== "custom" ? "text-content-primary" : "text-content-muted"}>
                                {provider === "none" || provider === "custom"
                                    ? "Select a provider..."
                                    : currentPreset?.label ?? provider}
                            </span>
                        </div>
                        <ChevronDown
                            size={14}
                            className={`text-content-muted transition-transform duration-200 ${providerDropdownOpen ? "rotate-180" : ""}`}
                        />
                    </button>
                    <AnimatePresence>
                        {providerDropdownOpen && (
                            <motion.div
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -4 }}
                                transition={{ duration: 0.15 }}
                                className="absolute left-0 right-0 top-full mt-1 z-[9999] rounded-lg border border-border-secondary bg-surface-surface shadow-xl shadow-black/40 overflow-hidden"
                            >
                                <div className="p-2 border-b border-border-secondary">
                                    <div className="relative">
                                        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-content-disabled" />
                                        <input
                                            type="text"
                                            value={providerSearch}
                                            onChange={(e) => setProviderSearch(e.target.value)}
                                            placeholder="Search providers..."
                                            autoFocus
                                            className="w-full rounded-md bg-surface-elevated border border-border-secondary py-1.5 pl-7 pr-2.5 text-[11px] text-content-primary placeholder-content-disabled focus:border-content-disabled focus:outline-none transition-colors"
                                            onClick={(e) => e.stopPropagation()}
                                        />
                                    </div>
                                </div>
                                <div className="overflow-y-auto" style={{ maxHeight: "200px" }}>
                                    {LLM_PROVIDER_PRESETS
                                        .filter(p => p.label.toLowerCase().includes(providerSearch.toLowerCase()))
                                        .map((preset) => (
                                            <button
                                                key={preset.id}
                                                type="button"
                                                onClick={() => handleProviderSelect(preset)}
                                                className={`w-full text-left px-3 py-2.5 transition-colors flex items-center justify-between ${provider === preset.id
                                                    ? "bg-amber-400/10 text-amber-400"
                                                    : "text-content-secondary hover:bg-surface-elevated hover:text-content-primary"
                                                    }`}
                                            >
                                                <span className="text-[12px] font-medium">{preset.label}</span>
                                                {preset.apiKeyRequired && (
                                                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-border-secondary text-content-muted">
                                                        API Key
                                                    </span>
                                                )}
                                            </button>
                                        ))}
                                    {LLM_PROVIDER_PRESETS.filter(p => p.label.toLowerCase().includes(providerSearch.toLowerCase())).length === 0 && (
                                        <div className="px-3 py-4 text-[11px] text-content-muted text-center">
                                            No matching providers
                                        </div>
                                    )}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
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
                <div className="space-y-1.5" ref={modelDropdownRef}>
                    <label className="text-[11px] font-medium text-content-muted ml-1 flex items-center gap-1.5">
                        <Cpu size={10} />
                        Model <span className="text-content-disabled">(leave empty for default)</span>
                    </label>
                    <div className="relative">
                        <button
                            type="button"
                            onClick={() => {
                                if (!modelDropdownOpen) {
                                    setModelsLoading(true);
                                }
                                setModelDropdownOpen(!modelDropdownOpen);
                            }}
                            className="w-full flex items-center justify-between rounded-lg bg-surface-elevated border border-border-secondary py-2 px-3 text-[12px] text-left hover:border-border-hover focus:border-content-disabled focus:outline-none transition-colors"
                        >
                            <span className={model ? "text-content-primary" : "text-content-disabled"}>
                                {model || currentPreset?.defaultModel || "Select a model"}
                            </span>
                            <ChevronDown
                                size={14}
                                className={`text-content-muted transition-transform duration-200 ${modelDropdownOpen ? "rotate-180" : ""}`}
                            />
                        </button>
                        <AnimatePresence>
                            {modelDropdownOpen && (
                                <motion.div
                                    initial={{ opacity: 0, y: -4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -4 }}
                                    transition={{ duration: 0.15 }}
                                    className="absolute left-0 right-0 top-full mt-1 z-[9999] rounded-lg border border-border-secondary bg-surface-surface shadow-xl shadow-black/40 overflow-hidden"
                                    style={{ maxHeight: "280px" }}
                                >
                                    <div className="p-2 border-b border-border-secondary">
                                        <input
                                            type="text"
                                            value={model}
                                            onChange={(e) => setModel(e.target.value)}
                                            placeholder="Type or select a model..."
                                            autoFocus
                                            className="w-full rounded-md bg-surface-elevated border border-border-secondary py-1.5 px-2.5 text-[11px] text-content-primary placeholder-content-disabled focus:border-content-disabled focus:outline-none transition-colors"
                                            onClick={(e) => e.stopPropagation()}
                                        />
                                    </div>
                                    <div className="overflow-y-auto" style={{ maxHeight: "200px" }}>
                                        {modelsLoading ? (
                                            <div className="px-3 py-4 text-[11px] text-content-muted text-center">
                                                Loading models...
                                            </div>
                                        ) : availableModels.length > 0 ? (
                                            availableModels.map((m) => (
                                                <button
                                                    key={m}
                                                    type="button"
                                                    onClick={() => {
                                                        setModel(m);
                                                        setModelDropdownOpen(false);
                                                    }}
                                                    className={`w-full text-left px-3 py-2 text-[11px] transition-colors ${model === m
                                                        ? "bg-amber-400/10 text-amber-400"
                                                        : "text-content-secondary hover:bg-surface-elevated hover:text-content-primary"
                                                        }`}
                                                >
                                                    {m}
                                                </button>
                                            ))
                                        ) : (
                                            <div className="px-3 py-4 text-[11px] text-content-muted text-center">
                                                Type a model name above
                                            </div>
                                        )}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
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
