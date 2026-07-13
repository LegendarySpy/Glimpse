import { invoke } from "@tauri-apps/api/core";
import type {
  TodayDictationStats,
  TranscriptionFilter,
  TranscriptionPage,
} from "../../types";

export async function getTranscriptionsPage(
  filter: TranscriptionFilter,
  limit: number,
  offset: number,
): Promise<TranscriptionPage> {
  return invoke<TranscriptionPage>("get_transcriptions_page", {
    search: filter.search,
    afterMs: filter.afterMs,
    beforeMs: filter.beforeMs,
    sort: filter.sort,
    limit,
    offset,
  });
}

export async function getTodayDictationStats(
  startMs: number,
  endMs: number,
): Promise<TodayDictationStats> {
  return invoke<TodayDictationStats>("get_today_dictation_stats", {
    startMs,
    endMs,
  });
}

export async function deleteTranscription(id: string): Promise<void> {
  await invoke("delete_transcription", { id });
}

export async function retryTranscription(id: string): Promise<void> {
  await invoke("retry_transcription", { id });
}

export async function cancelRetryTranscription(id: string): Promise<void> {
  await invoke("cancel_retry_transcription", { id });
}

export async function retryLlmCleanup(id: string): Promise<void> {
  await invoke("retry_llm_cleanup", { id });
}

export async function undoLlmCleanup(id: string): Promise<void> {
  await invoke("undo_llm_cleanup", { id });
}
