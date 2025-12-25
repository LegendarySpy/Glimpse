import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
    syncLocalTranscription,
    listTranscriptions,
    getCurrentUser,
    deleteCloudTranscription,
    findByLocalId
} from "../lib";

export type TranscriptionRecord = {
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
    synced: boolean;
};

interface UseTranscriptionsOptions {
    cloudSyncEnabled?: boolean;
}

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const PAGE_SIZE = 50;

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(
    fn: () => Promise<T>,
    maxAttempts: number = MAX_RETRY_ATTEMPTS,
    delayMs: number = RETRY_DELAY_MS
): Promise<T> {
    let lastError: Error | unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < maxAttempts) {
                const backoff = delayMs * Math.pow(2, attempt - 1);
                console.warn(`Attempt ${attempt} failed, retrying in ${backoff}ms...`, err);
                await sleep(backoff);
            }
        }
    }
    throw lastError;
}

export function useTranscriptions(options: UseTranscriptionsOptions = {}) {
    const resolvedCloudSyncEnabled = useMemo(() => {
        if (typeof options.cloudSyncEnabled === "boolean") {
            return options.cloudSyncEnabled;
        }
        try {
            if (typeof localStorage === "undefined") {
                return false;
            }
            const stored = localStorage.getItem("glimpse_cloud_sync_enabled");
            if (stored === null) {
                return false;
            }
            return stored === "true";
        } catch {
            return false;
        }
    }, [options.cloudSyncEnabled]);

    const [transcriptions, setTranscriptions] = useState<TranscriptionRecord[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [searchQuery, setSearchQuery] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);

    const [userId, setUserId] = useState<string | null>(null);
    const [isSubscriber, setIsSubscriber] = useState(false);
    const initialSyncDoneRef = useRef(false);

    const loadedOffsets = useRef<Set<number>>(new Set());
    const fetchingOffsets = useRef<Set<number>>(new Set());

    useEffect(() => {
        const checkUser = async () => {
            try {
                const user = await getCurrentUser();
                setUserId(user?.$id ?? null);
                setIsSubscriber(user?.labels?.includes("subscriber") ?? false);
            } catch {
                setUserId(null);
                setIsSubscriber(false);
            }
        };
        checkUser();
    }, []);

    const fetchPage = useCallback(async (offset: number, query: string) => {
        try {
            const records = await invoke<TranscriptionRecord[]>("list_transcriptions_paginated", {
                limit: PAGE_SIZE,
                offset,
                searchQuery: query || null,
            });
            return records;
        } catch (err) {
            console.error("Failed to fetch page:", err);
            throw err;
        }
    }, []);

    const searchTranscriptions = useCallback(async (query: string) => {
        setSearchQuery(query);
        setIsLoading(true);
        loadedOffsets.current.clear();
        fetchingOffsets.current.clear();
        try {
            const count = await invoke<number>("get_transcription_count", {
                searchQuery: query || null,
            });
            setTotalCount(count);
            const firstPage = await fetchPage(0, query);
            setTranscriptions(firstPage);
            loadedOffsets.current.add(0);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsLoading(false);
        }
    }, [fetchPage]);

    const loadMore = useCallback(async (offset: number) => {
        if (loadedOffsets.current.has(offset)) return;
        if (fetchingOffsets.current.has(offset)) return;

        if (offset >= totalCount && totalCount > 0) return;

        try {
            fetchingOffsets.current.add(offset);
            const newRecords = await fetchPage(offset, searchQuery);

            setTranscriptions(prev => {
                const copy = [...prev];
                newRecords.forEach((record, index) => {
                    copy[offset + index] = record;
                });
                return copy;
            });
            loadedOffsets.current.add(offset);
        } catch (err) {
            console.error("Failed to load more:", err);
        } finally {
            fetchingOffsets.current.delete(offset);
        }
    }, [fetchPage, searchQuery, totalCount]);

    // Initial load
    useEffect(() => {
        searchTranscriptions("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadTranscriptions = useCallback(async () => {
        // Alias for refreshing current view
        return searchTranscriptions(searchQuery);
    }, [searchTranscriptions, searchQuery]);

    const syncToCloud = useCallback(async (record: TranscriptionRecord) => {
        if (!userId || !resolvedCloudSyncEnabled || !isSubscriber) return null;

        try {
            setIsSyncing(true);
            const cloudDoc = await withRetry(() => syncLocalTranscription(userId, record));

            await invoke("mark_transcription_synced", { id: record.id });

            setTranscriptions(prev => prev.map(t =>
                t.id === record.id ? { ...t, synced: true } : t
            ));

            return cloudDoc;
        } catch (err) {
            console.error("Failed to sync to cloud:", err);
            return null;
        } finally {
            setIsSyncing(false);
        }
    }, [resolvedCloudSyncEnabled, userId, isSubscriber]);

    const syncAllToCloud = useCallback(async () => {
        if (!userId || !resolvedCloudSyncEnabled || !isSubscriber) return;

        setIsSyncing(true);
        try {
            const currentRecords = await invoke<TranscriptionRecord[]>("get_transcriptions");

            const unsyncedRecords = currentRecords.filter(r => !r.synced);

            if (unsyncedRecords.length === 0) {
                return;
            }

            console.log(`Syncing ${unsyncedRecords.length} records to cloud...`);

            for (const record of unsyncedRecords) {
                try {
                    await withRetry(() => syncLocalTranscription(userId, record));
                    await invoke("mark_transcription_synced", { id: record.id });
                    setTranscriptions(prev => prev.map(t =>
                        t.id === record.id ? { ...t, synced: true } : t
                    ));
                } catch (err) {
                    console.error(`Failed to sync record ${record.id} after retries:`, err);
                }
            }
        } catch (err) {
            console.error("Failed to sync all to cloud:", err);
        } finally {
            setIsSyncing(false);
        }
    }, [resolvedCloudSyncEnabled, userId, isSubscriber]);

    const syncFromCloud = useCallback(async () => {
        if (!userId || !resolvedCloudSyncEnabled || !isSubscriber) return;

        try {
            setIsSyncing(true);
            const localRecords = await invoke<TranscriptionRecord[]>("get_transcriptions");

            // Fetch all cloud documents with pagination
            const PAGE_SIZE = 100;
            let offset = 0;
            let allCloudDocs: Awaited<ReturnType<typeof listTranscriptions>> = [];

            while (true) {
                const batch = await listTranscriptions(userId, PAGE_SIZE, offset);
                allCloudDocs = allCloudDocs.concat(batch);

                if (batch.length < PAGE_SIZE) {
                    break; // No more pages
                }
                offset += PAGE_SIZE;
            }

            let importedCount = 0;

            for (const doc of allCloudDocs) {
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
                    synced: true,
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
    }, [resolvedCloudSyncEnabled, userId, isSubscriber, loadTranscriptions]);

    const deleteTranscription = useCallback(async (id: string) => {
        try {
            await invoke("delete_transcription", { id });
            setTranscriptions(prev => prev.filter(t => t.id !== id));

            if (resolvedCloudSyncEnabled && userId && isSubscriber) {
                const cloudDoc = await findByLocalId(userId, id);
                if (cloudDoc) {
                    await deleteCloudTranscription(cloudDoc.$id);
                }
            }
        } catch (err) {
            console.error("Failed to delete transcription:", err);
            throw err;
        }
    }, [resolvedCloudSyncEnabled, userId, isSubscriber]);

    const retryTranscription = useCallback(async (id: string) => {
        try {
            await invoke("retry_transcription", { id });
        } catch (err) {
            console.error("Failed to retry transcription:", err);
            throw err; // Re-throw so callers can handle the error
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

            if (resolvedCloudSyncEnabled && userId && isSubscriber && recordsToDelete.length > 0) {
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
    }, [transcriptions, resolvedCloudSyncEnabled, userId, isSubscriber]);

    useEffect(() => {
        loadTranscriptions();
    }, [loadTranscriptions]);

    useEffect(() => {
        if (resolvedCloudSyncEnabled && userId && isSubscriber && !initialSyncDoneRef.current) {
            initialSyncDoneRef.current = true;
            (async () => {
                await syncFromCloud();
                await syncAllToCloud();
            })();
        }
    }, [resolvedCloudSyncEnabled, userId, isSubscriber]);

    const unlistenRef1 = useRef<(() => void) | null>(null);
    const unlistenRef2 = useRef<(() => void) | null>(null);

    useEffect(() => {
        let isCancelled = false;

        if (unlistenRef1.current) {
            unlistenRef1.current();
            unlistenRef1.current = null;
        }
        if (unlistenRef2.current) {
            unlistenRef2.current();
            unlistenRef2.current = null;
        }

        listen<{ id: string }>("transcription:complete", async (event) => {
            if (isCancelled) return;
            await loadTranscriptions();

            if (resolvedCloudSyncEnabled && userId && isSubscriber) {
                const records = await invoke<TranscriptionRecord[]>("get_transcriptions");
                const newRecord = records.find(r => r.id === event.payload?.id) || records[0];

                if (newRecord && !newRecord.synced) {
                    withRetry(() => syncLocalTranscription(userId, newRecord)).then(async () => {
                        if (isCancelled) return;
                        await invoke("mark_transcription_synced", { id: newRecord.id });
                        setTranscriptions(prev => prev.map(t =>
                            t.id === newRecord.id ? { ...t, synced: true } : t
                        ));
                    }).catch(err => {
                        console.error("Background sync failed after retries:", err);
                    });
                }
            }
        }).then(fn => {
            if (!isCancelled) {
                unlistenRef1.current = fn;
            } else {
                fn(); // Already cancelled, clean up immediately
            }
        });

        listen("transcription:error", () => {
            if (isCancelled) return;
            loadTranscriptions();
        }).then(fn => {
            if (!isCancelled) {
                unlistenRef2.current = fn;
            } else {
                fn();
            }
        });

        return () => {
            isCancelled = true;
            if (unlistenRef1.current) {
                unlistenRef1.current();
                unlistenRef1.current = null;
            }
            if (unlistenRef2.current) {
                unlistenRef2.current();
                unlistenRef2.current = null;
            }
        };
    }, [loadTranscriptions, resolvedCloudSyncEnabled, userId, isSubscriber]);

    return {
        transcriptions,
        totalCount,
        isLoading,
        error,
        isSyncing,
        deleteTranscription,
        retryTranscription,
        retryLlmCleanup,
        undoLlmCleanup,
        clearAllTranscriptions,
        refresh: loadTranscriptions,
        searchTranscriptions,
        loadMore,
        syncToCloud,
        syncAllToCloud,
        syncFromCloud,
    };
}
