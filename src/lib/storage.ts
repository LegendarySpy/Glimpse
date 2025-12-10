import { storage, ID, type Models } from "./appwrite";

type PreviewGravity = Parameters<typeof storage.getFilePreview>[4];

export type FileModel = Models.File;

export async function uploadFile(
    bucketId: string,
    file: File,
    fileId?: string,
    permissions?: string[],
    onProgress?: (progress: number) => void
): Promise<FileModel> {
    return await storage.createFile(
        bucketId,
        fileId || ID.unique(),
        file,
        permissions,
        onProgress
            ? (progress) => onProgress(Math.round(progress.progress * 100))
            : undefined
    );
}

export async function getFile(
    bucketId: string,
    fileId: string
): Promise<FileModel> {
    return await storage.getFile(bucketId, fileId);
}

export function getFilePreview(
    bucketId: string,
    fileId: string,
    options?: {
        width?: number;
        height?: number;
        quality?: number;
        gravity?: PreviewGravity;
    }
): string {
    return storage
        .getFilePreview(
            bucketId,
            fileId,
            options?.width,
            options?.height,
            options?.gravity,
            options?.quality
        )
        .toString();
}

export function getFileDownload(bucketId: string, fileId: string): string {
    return storage.getFileDownload(bucketId, fileId).toString();
}

export function getFileView(bucketId: string, fileId: string): string {
    return storage.getFileView(bucketId, fileId).toString();
}

export async function deleteFile(
    bucketId: string,
    fileId: string
): Promise<void> {
    await storage.deleteFile(bucketId, fileId);
}

export async function listFiles(
    bucketId: string,
    queries?: string[]
): Promise<Models.FileList> {
    return await storage.listFiles(bucketId, queries);
}

export async function updateFile(
    bucketId: string,
    fileId: string,
    name?: string,
    permissions?: string[]
): Promise<FileModel> {
    return await storage.updateFile(bucketId, fileId, name, permissions);
}
