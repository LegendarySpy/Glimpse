import type { RemoteSpeechProvider } from "../../types";

export type { RemoteSpeechProvider };

export type SpeechProviderCompatibility =
  | "direct-openai-compatible"
  | "openai-compatible-proxy"
  | "openai-compatible-self-hosted";

export type SpeechProviderPreset = {
  id: RemoteSpeechProvider;
  label: string;
  endpoint: string;
  defaultModel: string;
  apiKeyRequired: boolean;
  compatibility: SpeechProviderCompatibility;
  supportsModelDiscovery: boolean;
  notes?: string;
};

const SPEECH_PROVIDER_PRESETS: SpeechProviderPreset[] = [
  {
    id: "custom",
    label: "Custom",
    endpoint: "",
    defaultModel: "auto",
    apiKeyRequired: false,
    compatibility: "direct-openai-compatible",
    supportsModelDiscovery: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini-transcribe",
    apiKeyRequired: true,
    compatibility: "direct-openai-compatible",
    supportsModelDiscovery: true,
  },
  {
    id: "groq",
    label: "Groq",
    endpoint: "https://api.groq.com/openai/v1",
    defaultModel: "whisper-large-v3-turbo",
    apiKeyRequired: true,
    compatibility: "direct-openai-compatible",
    supportsModelDiscovery: true,
  },
  {
    id: "mistral",
    label: "Mistral",
    endpoint: "https://api.mistral.ai/v1",
    defaultModel: "voxtral-mini-latest",
    apiKeyRequired: true,
    compatibility: "direct-openai-compatible",
    supportsModelDiscovery: true,
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    endpoint: "https://audio-prod.api.fireworks.ai/v1",
    defaultModel: "whisper-v3",
    apiKeyRequired: true,
    compatibility: "direct-openai-compatible",
    supportsModelDiscovery: true,
    notes: "Uses the Fireworks audio API base, not the normal inference base.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    defaultModel: "openai/whisper-1",
    apiKeyRequired: true,
    compatibility: "direct-openai-compatible",
    supportsModelDiscovery: true,
  },
  {
    id: "deepgram",
    label: "Deepgram",
    endpoint: "http://localhost:4000/v1",
    defaultModel: "nova-3",
    apiKeyRequired: true,
    compatibility: "openai-compatible-proxy",
    supportsModelDiscovery: true,
    notes: "Use through an OpenAI-compatible gateway or proxy.",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    endpoint: "http://localhost:4000/v1",
    defaultModel: "scribe_v1",
    apiKeyRequired: true,
    compatibility: "openai-compatible-proxy",
    supportsModelDiscovery: true,
    notes: "Use through an OpenAI-compatible gateway or proxy.",
  },
  {
    id: "vllm",
    label: "vLLM",
    endpoint: "http://localhost:8000/v1",
    defaultModel: "openai/whisper-large-v3-turbo",
    apiKeyRequired: false,
    compatibility: "openai-compatible-self-hosted",
    supportsModelDiscovery: true,
  },
  {
    id: "localai",
    label: "LocalAI",
    endpoint: "http://localhost:8080/v1",
    defaultModel: "whisper-1",
    apiKeyRequired: false,
    compatibility: "openai-compatible-self-hosted",
    supportsModelDiscovery: true,
  },
  {
    id: "whisper-cpp",
    label: "whisper.cpp",
    endpoint: "http://127.0.0.1:8080/v1",
    defaultModel: "whisper-1",
    apiKeyRequired: false,
    compatibility: "openai-compatible-self-hosted",
    supportsModelDiscovery: false,
  },
  {
    id: "llamaedge",
    label: "LlamaEdge Whisper",
    endpoint: "http://localhost:8080/v1",
    defaultModel: "whisper-1",
    apiKeyRequired: false,
    compatibility: "openai-compatible-self-hosted",
    supportsModelDiscovery: false,
  },
  {
    id: "litellm",
    label: "LiteLLM Proxy",
    endpoint: "http://localhost:4000/v1",
    defaultModel: "whisper-1",
    apiKeyRequired: false,
    compatibility: "openai-compatible-proxy",
    supportsModelDiscovery: true,
  },
];

export const SPEECH_PROVIDERS = SPEECH_PROVIDER_PRESETS.filter(
  (provider) => provider.id !== "custom",
);

export const LOCAL_SPEECH_PROVIDERS = SPEECH_PROVIDERS.filter(
  (p) => !p.apiKeyRequired,
);
export const CLOUD_SPEECH_PROVIDERS = SPEECH_PROVIDERS.filter(
  (p) => p.apiKeyRequired,
);

export function getSpeechProviderPreset(
  id: RemoteSpeechProvider,
): SpeechProviderPreset | undefined {
  return SPEECH_PROVIDER_PRESETS.find((provider) => provider.id === id);
}

export function supportsSpeechProviderModelDiscovery(
  id: RemoteSpeechProvider,
): boolean {
  return getSpeechProviderPreset(id)?.supportsModelDiscovery ?? false;
}

export function resolvedSpeechEndpoint(
  provider: RemoteSpeechProvider,
  endpoint: string,
): string {
  const trimmed = endpoint.trim();
  if (trimmed) {
    return trimmed;
  }
  return getSpeechProviderPreset(provider)?.endpoint ?? "";
}

export function resolvedSpeechModel(
  provider: RemoteSpeechProvider,
  model: string,
): string | undefined {
  const trimmed = model.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") {
    const defaultModel = getSpeechProviderPreset(provider)?.defaultModel;
    if (!defaultModel || defaultModel.toLowerCase() === "auto") {
      return undefined;
    }
    return defaultModel;
  }
  return trimmed;
}

export function isRemoteSpeechConfigured(args: {
  enabled: boolean;
  provider: RemoteSpeechProvider;
  endpoint: string;
  model: string;
}): boolean {
  if (!args.enabled) {
    return false;
  }
  return (
    resolvedSpeechEndpoint(args.provider, args.endpoint).length > 0 &&
    resolvedSpeechModel(args.provider, args.model) !== undefined
  );
}

const REMOTE_SPEECH_MODEL_PREFIX = "remote:";

function formatSpeechProviderModelLabel(
  providerId: string,
  model: string,
): string {
  const label =
    getSpeechProviderPreset(providerId as RemoteSpeechProvider)?.label ??
    providerId;
  const trimmedModel = model.trim();
  return trimmedModel ? `${label} · ${trimmedModel}` : label;
}

function inferSpeechProviderFromModel(
  model: string,
): SpeechProviderPreset | undefined {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return SPEECH_PROVIDER_PRESETS.find(
    (preset) => preset.defaultModel.trim().toLowerCase() === normalized,
  );
}

export function formatTranscriptionSpeechModel(stored: string): string | null {
  const trimmed = stored.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith(REMOTE_SPEECH_MODEL_PREFIX)) {
    const payload = trimmed.slice(REMOTE_SPEECH_MODEL_PREFIX.length);
    const splitAt = payload.indexOf(":");
    if (splitAt > 0) {
      return formatSpeechProviderModelLabel(
        payload.slice(0, splitAt),
        payload.slice(splitAt + 1),
      );
    }
    const preset = getSpeechProviderPreset(payload as RemoteSpeechProvider);
    const fallbackModel =
      preset?.defaultModel && preset.defaultModel !== "auto"
        ? preset.defaultModel
        : "";
    return formatSpeechProviderModelLabel(payload, fallbackModel);
  }

  const legacyRemote = trimmed.match(/^remote\s*\((.+)\)\s*$/i);
  if (legacyRemote) {
    const model = legacyRemote[1].trim();
    const preset = inferSpeechProviderFromModel(model);
    if (preset) {
      return formatSpeechProviderModelLabel(preset.id, model);
    }
    return model;
  }

  return trimmed;
}

export function isRemoteTranscriptionSpeechModel(stored: string): boolean {
  const trimmed = stored.trim();
  return (
    trimmed.startsWith(REMOTE_SPEECH_MODEL_PREFIX) ||
    /^remote\s*\(/i.test(trimmed)
  );
}
