import { createDocument, getDocument, listDocuments, updateDocument, Query, type Document } from "./database";
import { Permission, Role } from "./appwrite";

const DATABASE_ID = import.meta.env.VITE_APPWRITE_DATABASE_ID;
const COLLECTION_ID = import.meta.env.VITE_APPWRITE_TRANSCRIPTIONS_COLLECTION_ID;
const USAGE_COLLECTION_ID = import.meta.env.VITE_APPWRITE_USAGE_COLLECTION_ID;

export interface UsageRecord extends Document {
    user_id: string;
    period: string; // YYYY-MM format
    audio_seconds_used: number;
}

export interface CloudTranscription extends Document {
    text: string;
    raw_text: string | null;
    audio_file_id: string | null;
    status: "pending" | "success" | "error";
    error_message: string | null;
    llm_cleaned: boolean;
    speech_model: string;
    llm_model: string | null;
    word_count: number;
    audio_duration_seconds: number;
    local_id: string | null;
    is_deleted: boolean;
    timestamp: string;
    user_id: string;
}

export type TranscriptionInput = Omit<CloudTranscription, "$id" | "$createdAt" | "$updatedAt" | "$permissions" | "$collectionId" | "$databaseId" | "$sequence">;

export async function createTranscription(
    userId: string,
    data: TranscriptionInput
): Promise<CloudTranscription> {
    const permissions = [
        Permission.read(Role.user(userId)),
        Permission.update(Role.user(userId)),
    ];

    return createDocument<CloudTranscription>(
        DATABASE_ID,
        COLLECTION_ID,
        data,
        undefined,
        permissions
    );
}

export async function getTranscription(documentId: string): Promise<CloudTranscription> {
    return getDocument<CloudTranscription>(DATABASE_ID, COLLECTION_ID, documentId);
}

export async function listTranscriptions(
    userId: string,
    limit: number = 100,
    offset: number = 0
): Promise<CloudTranscription[]> {
    const result = await listDocuments<CloudTranscription>(DATABASE_ID, COLLECTION_ID, [
        Query.equal("user_id", userId),
        Query.equal("is_deleted", false),
        Query.orderDesc("$createdAt"),
        Query.limit(limit),
        Query.offset(offset),
    ]);
    return result.documents;
}

export async function updateTranscription(
    documentId: string,
    data: Partial<TranscriptionInput>
): Promise<CloudTranscription> {
    return updateDocument<CloudTranscription>(
        DATABASE_ID,
        COLLECTION_ID,
        documentId,
        data
    );
}

export async function deleteCloudTranscription(documentId: string): Promise<void> {
    await updateDocument(DATABASE_ID, COLLECTION_ID, documentId, {
        is_deleted: true
    });
}

export async function findByLocalId(userId: string, localId: string): Promise<CloudTranscription | null> {
    const result = await listDocuments<CloudTranscription>(DATABASE_ID, COLLECTION_ID, [
        Query.equal("user_id", userId),
        Query.equal("local_id", localId),
        Query.equal("is_deleted", false),
        Query.limit(1),
    ]);
    return result.documents[0] || null;
}

export async function syncLocalTranscription(
    userId: string,
    localRecord: {
        id: string;
        timestamp: string;
        text: string;
        raw_text?: string | null;
        status: "success" | "error";
        error_message?: string;
        llm_cleaned: boolean;
        speech_model: string;
        llm_model?: string | null;
        word_count: number;
        audio_duration_seconds: number;
    }
): Promise<CloudTranscription> {
    const existing = await findByLocalId(userId, localRecord.id);

    const cloudData: TranscriptionInput = {
        text: localRecord.text,
        raw_text: localRecord.raw_text || null,
        audio_file_id: null,
        status: localRecord.status === "success" ? "success" : "error",
        error_message: localRecord.error_message || null,
        llm_cleaned: localRecord.llm_cleaned,
        speech_model: localRecord.speech_model,
        llm_model: localRecord.llm_model || null,
        word_count: localRecord.word_count,
        audio_duration_seconds: localRecord.audio_duration_seconds,
        local_id: localRecord.id,
        is_deleted: false,
        timestamp: localRecord.timestamp,
        user_id: userId,
    };

    if (existing) {
        return updateTranscription(existing.$id, cloudData);
    }
    return createTranscription(userId, cloudData);
}

export async function validateConnection(): Promise<boolean> {
    await listDocuments<CloudTranscription>(DATABASE_ID, COLLECTION_ID, [Query.limit(1)]);
    return true;
}

export type CloudUsageStats = {
    cloud_minutes_this_month: number;
    cloud_hours_lifetime: number;
    cloud_transcriptions_count: number;
    cloud_transcriptions_this_month: number;
};

const USAGE_CACHE_KEY = "glimpse_cloud_usage_cache";

type UsageCache = {
    stats: CloudUsageStats;
    timestamp: number;
    userId: string;
    monthKey: string; // YYYY-MM format to detect month changes
};

function getMonthKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function getCachedUsageStats(userId: string): CloudUsageStats | null {
    try {
        const cached = localStorage.getItem(USAGE_CACHE_KEY);
        if (!cached) return null;

        const data: UsageCache = JSON.parse(cached);

        // Invalidate if different user or month changed
        if (data.userId !== userId || data.monthKey !== getMonthKey()) {
            localStorage.removeItem(USAGE_CACHE_KEY);
            return null;
        }

        return data.stats;
    } catch {
        return null;
    }
}

export function setCachedUsageStats(userId: string, stats: CloudUsageStats): void {
    const cache: UsageCache = {
        stats,
        timestamp: Date.now(),
        userId,
        monthKey: getMonthKey(),
    };
    localStorage.setItem(USAGE_CACHE_KEY, JSON.stringify(cache));
}

export async function getCloudUsageStats(userId: string): Promise<CloudUsageStats> {
    const currentPeriod = getMonthKey();

    const usageRecords = await listDocuments<UsageRecord>(DATABASE_ID, USAGE_COLLECTION_ID, [
        Query.equal("user_id", userId),
        Query.limit(1000), // Enough for a few years
    ]);

    let lifetimeSeconds = 0;
    let monthlySeconds = 0;

    for (const record of usageRecords.documents) {
        lifetimeSeconds += record.audio_seconds_used || 0;
        if (record.period === currentPeriod) {
            monthlySeconds = record.audio_seconds_used || 0;
        }
    }

    // For transcription counts, we still need to query transcriptions
    // but this is optional metadata, not critical for quota enforcement
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [monthlyTranscriptions, allTranscriptions] = await Promise.all([
        listDocuments<CloudTranscription>(DATABASE_ID, COLLECTION_ID, [
            Query.equal("user_id", userId),
            Query.equal("status", "success"),
            Query.equal("is_deleted", false),
            Query.greaterThanEqual("timestamp", monthStart.toISOString()),
            Query.limit(1), // We only need the total count
        ]),
        listDocuments<CloudTranscription>(DATABASE_ID, COLLECTION_ID, [
            Query.equal("user_id", userId),
            Query.equal("status", "success"),
            Query.equal("is_deleted", false),
            Query.limit(1),
        ]),
    ]);

    const stats: CloudUsageStats = {
        cloud_minutes_this_month: monthlySeconds / 60,
        cloud_hours_lifetime: lifetimeSeconds / 3600,
        cloud_transcriptions_count: allTranscriptions.total,
        cloud_transcriptions_this_month: monthlyTranscriptions.total,
    };

    // Cache the fetched stats
    setCachedUsageStats(userId, stats);

    return stats;
}
