import { client, type Models } from "./appwrite";
import type { RealtimeResponseEvent } from "appwrite";

export type RealtimeCallback<T extends Models.Document = Models.Document> = (
    response: RealtimeResponseEvent<T>
) => void;

export function subscribe<T extends Models.Document = Models.Document>(
    channels: string | string[],
    callback: RealtimeCallback<T>
): () => void {
    return client.subscribe<T>(channels, callback);
}

export const channels = {
    account: () => "account",
    collection: (databaseId: string, collectionId: string) =>
        `databases.${databaseId}.collections.${collectionId}.documents`,
    document: (databaseId: string, collectionId: string, documentId: string) =>
        `databases.${databaseId}.collections.${collectionId}.documents.${documentId}`,
    bucket: (bucketId: string) => `buckets.${bucketId}.files`,
    file: (bucketId: string, fileId: string) =>
        `buckets.${bucketId}.files.${fileId}`,
    executions: (functionId: string) => `functions.${functionId}.executions`,
};

export const events = {
    isCreate: (event: RealtimeResponseEvent<unknown>) =>
        event.events.some((e) => e.includes(".create")),
    isUpdate: (event: RealtimeResponseEvent<unknown>) =>
        event.events.some((e) => e.includes(".update")),
    isDelete: (event: RealtimeResponseEvent<unknown>) =>
        event.events.some((e) => e.includes(".delete")),
};
