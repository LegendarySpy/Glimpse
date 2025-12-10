import { createDocument, getDocument, listDocuments, updateDocument, Query, type Document } from "./database";
import { Permission, Role } from "./appwrite";

const DATABASE_ID = import.meta.env.VITE_APPWRITE_DATABASE_ID;
const COLLECTION_ID = import.meta.env.VITE_APPWRITE_TRANSCRIPTIONS_COLLECTION_ID;

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
