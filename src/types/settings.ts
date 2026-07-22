export type TranscriptionMode = "cloud" | "local";
export type MediaAction =
  "off" | "pause" | "duck10" | "duck25" | "duck50" | "duck75";
export type TextSizeMode = "small" | "default" | "large";
export type ThemeMode = "system" | "light" | "dark";
export type AppLocaleSetting = "system" | string;

export type RecordingPrunePolicy =
  "never" | "immediately" | "day" | "week" | "month" | "three_months" | "year";

export type AutoDeleteTarget = "audio" | "transcripts";

export type LlmProvider =
  | "none"
  | "apple"
  | "lmstudio"
  | "ollama"
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "groq"
  | "cerebras"
  | "sambanova"
  | "together"
  | "openrouter"
  | "perplexity"
  | "deepseek"
  | "fireworks"
  | "mistral"
  | "custom";

export type RemoteSpeechProvider =
  | "custom"
  | "openai"
  | "groq"
  | "mistral"
  | "fireworks"
  | "openrouter"
  | "deepgram"
  | "elevenlabs"
  | "vllm"
  | "localai"
  | "whisper-cpp"
  | "llamaedge"
  | "litellm";

export type Replacement = {
  from: string;
  to: string;
};

export type Personality = {
  id: string;
  name: string;
  enabled: boolean;
  apps: string[];
  websites: string[];
  instructions: string[];
};

export type ShortcutBinding = {
  shortcut: string;
  temporary: boolean;
  cleanup_enabled: boolean;
};

export type ShortcutBindings = {
  smart: ShortcutBinding[];
  hold: ShortcutBinding[];
  toggle: ShortcutBinding[];
};

export type StoredSettings = {
  onboarding_completed: boolean;
  smart_shortcut: string;
  smart_enabled: boolean;
  hold_shortcut: string;
  hold_enabled: boolean;
  toggle_shortcut: string;
  toggle_enabled: boolean;
  shortcut_bindings: ShortcutBindings;
  transcription_mode: TranscriptionMode;
  local_model: string;
  remote_speech_enabled: boolean;
  remote_speech_provider: RemoteSpeechProvider;
  remote_speech_endpoint: string;
  remote_speech_api_key: string;
  remote_speech_model: string;
  microphone_device: string | null;
  language: string;
  app_locale: AppLocaleSetting;
  theme_mode: ThemeMode;
  llm_enabled: boolean;
  cleanup_enabled: boolean;
  llm_provider: LlmProvider;
  llm_endpoint: string;
  llm_api_key: string;
  llm_model: string;
  dictionary: string[];
  auto_dictionary_enabled: boolean;
  auto_dictionary_ignored: string[];
  replacements: Replacement[];
  personalities: Personality[];
  edit_mode_enabled: boolean;
  media_action: MediaAction;
  auto_update_enabled: boolean;
  auto_launch_enabled: boolean;
  start_in_background: boolean;
  auto_delete_target: AutoDeleteTarget;
  auto_delete_duration: RecordingPrunePolicy;
  analytics_enabled: boolean;
  analytics_install_id: string;
  local_api_key: string;
  local_api_port: number;
  local_api_model: string;
  local_api_host: string;
  local_api_start_on_launch: boolean;
  local_api_cors: boolean;
};
