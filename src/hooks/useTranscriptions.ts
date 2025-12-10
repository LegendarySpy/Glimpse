import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
    syncLocalTranscription,
    listTranscriptions,
    getCurrentUser,
    deleteCloudTranscription,
    findByLocalId
} from "../lib";

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
    cloud_id?: string;
}

interface UseTranscriptionsOptions {
    cloudSyncEnabled?: boolean;
}

export function useTranscriptions(options: UseTranscriptionsOptions = {}) {
    const resolvedCloudSyncEnabled = useMemo(() => {
        if (typeof options.cloudSyncEnabled === "boolean") {
            return options.cloudSyncEnabled;
        }
        try {
            if (typeof localStorage === "undefined") {
                return true;
            }
            const stored = localStorage.getItem("glimpse_cloud_sync_enabled");
            if (stored === null) {
                return true;
            }
            return stored === "true";
        } catch {
            return true;
        }
    }, [options.cloudSyncEnabled]);

    const [transcriptions, setTranscriptions] = useState<TranscriptionRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);

    const [userId, setUserId] = useState<string | null>(null);

    useEffect(() => {
        const checkUser = async () => {
            try {
                const user = await getCurrentUser();
                setUserId(user?.$id ?? null);
            } catch {
                setUserId(null);
            }
        };
        checkUser();
    }, []);

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

    const syncToCloud = useCallback(async (record: TranscriptionRecord) => {
        if (!userId || !resolvedCloudSyncEnabled) return null;

        try {
            setIsSyncing(true);
            const cloudDoc = await syncLocalTranscription(userId, record);
            return cloudDoc;
        } catch (err) {
            console.error("Failed to sync to cloud:", err);
            return null;
        } finally {
            setIsSyncing(false);
        }
    }, [resolvedCloudSyncEnabled, userId]);

    const syncAllToCloud = useCallback(async () => {
        if (!userId || !resolvedCloudSyncEnabled) return;

        setIsSyncing(true);
        try {
            const currentRecords = await invoke<TranscriptionRecord[]>("get_transcriptions");

            for (const record of currentRecords) {
                await syncLocalTranscription(userId, record);
            }
        } catch (err) {
            console.error("Failed to sync all to cloud:", err);
        } finally {
            setIsSyncing(false);
        }
    }, [resolvedCloudSyncEnabled, userId]);

    const syncFromCloud = useCallback(async () => {
        if (!userId || !resolvedCloudSyncEnabled) return;

        try {
            setIsSyncing(true);
            const cloudDocs = await listTranscriptions(userId, 100);
            const localRecords = await invoke<TranscriptionRecord[]>("get_transcriptions");

            let importedCount = 0;

            for (const doc of cloudDocs) {
                if (doc.is_deleted) continue;

                if (!doc.text || !doc.status) continue;

                const targetId = doc.local_id || doc.$id;
                const existsById = localRecords.some(r => r.id === targetId);

                const existsByTimestamp = doc.timestamp
                    ? localRecords.some(r => r.timestamp === doc.timestamp)
                    : false;

                if (existsById || existsByTimestamp) {
                    continue;
                }

                const localRecord: TranscriptionRecord = {
                    id: targetId,
                    timestamp: doc.timestamp || doc.$createdAt,
                    text: doc.text,
                    raw_text: doc.raw_text,
                    audio_path: "cloud_synced_placeholder",
                    status: doc.status === "success" ? "success" : "error",
                    error_message: doc.error_message || undefined,
                    llm_cleaned: doc.llm_cleaned,
                    speech_model: doc.speech_model,
                    llm_model: doc.llm_model,
                    word_count: doc.word_count,
                    audio_duration_seconds: doc.audio_duration_seconds,
                };

                const wasImported = await invoke<boolean>("import_transcription_from_cloud", { record: localRecord });
                if (wasImported) {
                    importedCount++;
                }
            }

            if (importedCount > 0) {
                await loadTranscriptions();
            }
        } catch (err) {
            console.error("Failed to sync from cloud:", err);
        } finally {
            setIsSyncing(false);
        }
    }, [resolvedCloudSyncEnabled, userId, loadTranscriptions]);

    const deleteTranscription = useCallback(async (id: string) => {
        try {
            await invoke("delete_transcription", { id });
            setTranscriptions(prev => prev.filter(t => t.id !== id));

            if (resolvedCloudSyncEnabled && userId) {
                const cloudDoc = await findByLocalId(userId, id);
                if (cloudDoc) {
                    await deleteCloudTranscription(cloudDoc.$id);
                }
            }
        } catch (err) {
            console.error("Failed to delete transcription:", err);
            throw err;
        }
    }, [resolvedCloudSyncEnabled, userId]);

    const retryTranscription = useCallback(async (id: string) => {
        try {
            await invoke("retry_transcription", { id });
        } catch (err) {
            console.error("Failed to retry transcription:", err);
        }
    }, []);

    const retryLlmCleanup = useCallback(async (id: string) => {
        try {
            await invoke("retry_llm_cleanup", { id });
        } catch (err) {
            console.error("Failed to retry LLM cleanup:", err);
        }
    }, []);

    const undoLlmCleanup = useCallback(async (id: string) => {
        try {
            await invoke("undo_llm_cleanup", { id });
        } catch (err) {
            console.error("Failed to undo LLM cleanup:", err);
        }
    }, []);

    const clearAllTranscriptions = useCallback(async () => {
        try {
            const recordsToDelete = [...transcriptions];

            await invoke("delete_all_transcriptions");
            setTranscriptions([]);

            if (resolvedCloudSyncEnabled && userId && recordsToDelete.length > 0) {
                await Promise.all(recordsToDelete.map(async (record) => {
                    try {
                        const cloudDoc = await findByLocalId(userId, record.id);
                        if (cloudDoc) {
                            await deleteCloudTranscription(cloudDoc.$id);
                        }
                    } catch (e) {
                        console.error(`Failed to soft delete cloud doc for ${record.id}:`, e);
                    }
                }));
            }
        } catch (err) {
            console.error("Failed to clear all transcriptions:", err);
            throw err;
        }
    }, [transcriptions, resolvedCloudSyncEnabled, userId]);

    useEffect(() => {
        loadTranscriptions();
    }, [loadTranscriptions]);

    useEffect(() => {
        if (resolvedCloudSyncEnabled && userId) {
            syncFromCloud();
            syncAllToCloud();
        }
    }, [resolvedCloudSyncEnabled, userId, syncFromCloud, syncAllToCloud]);

    useEffect(() => {
        const unlisten1 = listen<{ id: string }>("transcription:complete", async (event) => {
            await loadTranscriptions();

            if (resolvedCloudSyncEnabled && userId) {
                const records = await invoke<TranscriptionRecord[]>("get_transcriptions");
                const newRecord = records.find(r => r.id === event.payload?.id) || records[0];

                if (newRecord) {
                    syncLocalTranscription(userId, newRecord).catch(err => {
                        console.error("Background sync failed:", err);
                    });
                }
            }
        });

        const unlisten2 = listen("transcription:error", () => {
            loadTranscriptions();
        });

        return () => {
            unlisten1.then(fn => fn());
            unlisten2.then(fn => fn());
        };
    }, [loadTranscriptions, resolvedCloudSyncEnabled, userId]);

    return {
        transcriptions,
        isLoading,
        error,
        isSyncing,
        deleteTranscription,
        retryTranscription,
        retryLlmCleanup,
        undoLlmCleanup,
        clearAllTranscriptions,
        refresh: loadTranscriptions,
        syncToCloud,
        syncAllToCloud,
        syncFromCloud,
    };
}
