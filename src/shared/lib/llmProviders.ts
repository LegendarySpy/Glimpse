import type { LlmProvider } from "../../types";

export type { LlmProvider };

export type LlmProviderPreset = {
  id: LlmProvider;
  label: string;
  endpoint: string;
  defaultModel: string;
  apiKeyRequired: boolean;
  // Built-in on-device model: no endpoint, API key, or model choice.
  onDevice?: boolean;
};

const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: "custom",
    label: "Custom",
    endpoint: "",
    defaultModel: "",
    apiKeyRequired: false,
  },
  {
    id: "apple",
    label: "Apple Intelligence",
    endpoint: "",
    defaultModel: "",
    apiKeyRequired: false,
    onDevice: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    endpoint: "http://localhost:1234/v1",
    defaultModel: "",
    apiKeyRequired: false,
  },
  {
    id: "ollama",
    label: "Ollama",
    endpoint: "http://localhost:11434/v1",
    defaultModel: "",
    apiKeyRequired: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4-mini",
    apiKeyRequired: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    endpoint: "https://api.anthropic.com",
    defaultModel: "claude-haiku-4-5",
    apiKeyRequired: true,
  },
  {
    id: "google",
    label: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.1-flash-lite-preview",
    apiKeyRequired: true,
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    endpoint: "https://api.x.ai/v1",
    defaultModel: "grok-4-1-fast-reasoning",
    apiKeyRequired: true,
  },
  {
    id: "groq",
    label: "Groq",
    endpoint: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-20b",
    apiKeyRequired: true,
  },
  {
    id: "cerebras",
    label: "Cerebras",
    endpoint: "https://api.cerebras.ai/v1",
    defaultModel: "gpt-oss-120b",
    apiKeyRequired: true,
  },
  {
    id: "sambanova",
    label: "SambaNova",
    endpoint: "https://api.sambanova.ai/v1",
    defaultModel: "MiniMax-M2.5",
    apiKeyRequired: true,
  },
  {
    id: "together",
    label: "Together AI",
    endpoint: "https://api.together.xyz/v1",
    defaultModel: "openai/gpt-oss-20b",
    apiKeyRequired: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5.4-mini",
    apiKeyRequired: true,
  },
  {
    id: "perplexity",
    label: "Perplexity",
    endpoint: "https://api.perplexity.ai",
    defaultModel: "sonar-reasoning-pro",
    apiKeyRequired: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-reasoner",
    apiKeyRequired: true,
  },
  {
    id: "fireworks",
    label: "Fireworks",
    endpoint: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/gpt-oss-20b",
    apiKeyRequired: true,
  },
  {
    id: "mistral",
    label: "Mistral",
    endpoint: "https://api.mistral.ai/v1",
    defaultModel: "magistral-small-latest",
    apiKeyRequired: true,
  },
];

export const LOCAL_PROVIDERS = LLM_PROVIDER_PRESETS.filter(
  (p) => !p.apiKeyRequired,
);
export const CLOUD_PROVIDERS = LLM_PROVIDER_PRESETS.filter(
  (p) => p.apiKeyRequired,
);

export function getProviderPreset(
  id: LlmProvider,
): LlmProviderPreset | undefined {
  return LLM_PROVIDER_PRESETS.find((p) => p.id === id);
}

export function resolvedLlmEndpoint(
  provider: LlmProvider,
  endpoint: string,
): string {
  const trimmed = endpoint.trim();
  if (trimmed) {
    return trimmed;
  }
  return getProviderPreset(provider)?.endpoint ?? "";
}

export function formatTranscriptionLlmModel(stored: string): string | null {
  const trimmed = stored.trim();
  if (!trimmed) {
    return null;
  }

  const splitAt = trimmed.indexOf(":");
  if (splitAt > 0) {
    const providerId = trimmed.slice(0, splitAt) as LlmProvider;
    const model = trimmed.slice(splitAt + 1).trim();
    const providerLabel = getProviderPreset(providerId)?.label ?? providerId;
    return model ? `${providerLabel} · ${model}` : providerLabel;
  }

  const preset = getProviderPreset(trimmed as LlmProvider);
  if (preset) {
    return preset.label;
  }

  return trimmed;
}
