export type TranscriptionRecord = {
  id: string;
  timestamp: string;
  text: string;
  raw_text?: string | null;
  audio_path: string;
  audio_available: boolean;
  status: "success" | "error";
  error_message?: string;
  llm_cleaned: boolean;
  speech_model: string;
  llm_model?: string | null;
  word_count: number;
  audio_duration_seconds: number;
  synced: boolean;
  mode_id?: string | null;
  mode_name?: string | null;
};

export type TodayDictationStats = {
  count: number;
  words: number;
  audioSeconds: number;
  longestWords: number;
  longestAudioSeconds: number;
  llmCleanedCount: number;
};

export type TranscriptionSort = "recent" | "oldest" | "longest" | "shortest";

export type TranscriptionFilter = {
  search?: string;
  afterMs?: number;
  beforeMs?: number;
  sort: TranscriptionSort;
};

export type TranscriptionPage = {
  items: TranscriptionRecord[];
  hasMore: boolean;
};
