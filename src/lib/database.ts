import { databases, ID, Query, type Models } from "./appwrite";

export type Document = Models.Document;

export async function createDocument<T extends Document>(
    databaseId: string,
    collectionId: string,
    data: Record<string, unknown>,
    documentId?: string,
    permissions?: string[]
): Promise<T> {
    return (await databases.createDocument(
        databaseId,
        collectionId,
        documentId || ID.unique(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data as any,
        permissions
    )) as T;
}

export async function getDocument<T extends Document>(
    databaseId: string,
    collectionId: string,
    documentId: string
): Promise<T> {
    return (await databases.getDocument(
        databaseId,
        collectionId,
        documentId
    )) as T;
}

export async function listDocuments<T extends Document>(
    databaseId: string,
    collectionId: string,
    queries?: string[]
): Promise<Models.DocumentList<T>> {
    return (await databases.listDocuments(
        databaseId,
        collectionId,
        queries
    )) as Models.DocumentList<T>;
}

export async function updateDocument<T extends Document>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    data: Record<string, unknown>,
    permissions?: string[]
): Promise<T> {
    return (await databases.updateDocument(
        databaseId,
        collectionId,
        documentId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data as any,
        permissions
    )) as T;
}

export async function deleteDocument(
    databaseId: string,
    collectionId: string,
    documentId: string
): Promise<void> {
    await databases.deleteDocument(databaseId, collectionId, documentId);
}
export { Query };
