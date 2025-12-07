import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TranscriptionRecord {
    id: string;
    timestamp: string;
    text: string;
    raw_text?: string | null;
    audio_path: string;
    status: "success" | "error";
    error_message?: string;
    llm_cleaned: boolean;
    speech_model: string;
    llm_model?: string | null;
    word_count: number;
    audio_duration_seconds: number;
}

export function useTranscriptions() {
    const [transcriptions, setTranscriptions] = useState<TranscriptionRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadTranscriptions = useCallback(async () => {
        try {
            setIsLoading(true);
            setError(null);
            const records = await invoke<TranscriptionRecord[]>("get_transcriptions");
            setTranscriptions(records);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            console.error("Failed to load transcriptions:", err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const deleteTranscription = useCallback(async (id: string) => {
        try {
            await invoke("delete_transcription", { id });
            setTranscriptions(prev => prev.filter(t => t.id !== id));
        } catch (err) {
            console.error("Failed to delete transcription:", err);
            throw err;
        }
    }, []);

    const retryTranscription = useCallback(async (id: string) => {
        try {
            await invoke("retry_transcription", { id });
            // Don't remove from list - let the component show "retrying" state
            // It will be updated when the new transcription event fires
        } catch (err) {
            console.error("Failed to retry transcription:", err);
            throw err;
        }
    }, []);

    const retryLlmCleanup = useCallback(async (id: string) => {
        try {
            await invoke("retry_llm_cleanup", { id });
            // The transcription will be refreshed when the event fires
        } catch (err) {
            console.error("Failed to retry LLM cleanup:", err);
            throw err;
        }
    }, []);

    const undoLlmCleanup = useCallback(async (id: string) => {
        try {
            await invoke("undo_llm_cleanup", { id });
            // The transcription will be refreshed when the event fires
        } catch (err) {
            console.error("Failed to undo LLM cleanup:", err);
            throw err;
        }
    }, []);

    // Load transcriptions on mount
    useEffect(() => {
        loadTranscriptions();
    }, [loadTranscriptions]);

    // Listen for new transcriptions
    useEffect(() => {
        const unlisten1 = listen("transcription:complete", () => {
            // Reload transcriptions when a new one completes
            loadTranscriptions();
        });

        const unlisten2 = listen("transcription:error", () => {
            // Reload transcriptions when one fails
            loadTranscriptions();
        });

        return () => {
            unlisten1.then(fn => fn());
            unlisten2.then(fn => fn());
        };
    }, [loadTranscriptions]);

    const clearAllTranscriptions = useCallback(async () => {
        try {
            await invoke("delete_all_transcriptions");
            setTranscriptions([]);
        } catch (err) {
            console.error("Failed to clear all transcriptions:", err);
            throw err;
        }
    }, []);

    return {
        transcriptions,
        isLoading,
        error,
        deleteTranscription,
        retryTranscription,
        retryLlmCleanup,
        undoLlmCleanup,
        clearAllTranscriptions,
        refresh: loadTranscriptions,
    };
}
