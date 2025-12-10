export { client, account, databases, storage, functions, ID, Query } from "./appwrite";
export type { Models } from "./appwrite";

export {
    createAccount,
    login,
    logout,
    logoutAll,
    getCurrentUser,
    isLoggedIn,
    createOAuth2Session,
    updateName,
    updateEmail,
    updatePassword,
    requestPasswordRecovery,
    confirmPasswordRecovery,
    getPreferences,
    updatePreferences,
} from "./auth";
export type { User } from "./auth";

export {
    createDocument,
    getDocument,
    listDocuments,
    updateDocument,
    deleteDocument,
} from "./database";
export type { Document } from "./database";

export {
    uploadFile,
    getFile,
    getFilePreview,
    getFileDownload,
    getFileView,
    deleteFile,
    listFiles,
    updateFile,
} from "./storage";
export type { FileModel } from "./storage";

export {
    executeFunction,
    executeFunctionJson,
    getExecution,
    listExecutions,
} from "./functions";
export type { Execution } from "./functions";

export { subscribe, channels, events } from "./realtime";
export type { RealtimeCallback } from "./realtime";

export {
    createTranscription,
    getTranscription,
    listTranscriptions,
    updateTranscription,
    deleteCloudTranscription,
    findByLocalId,
    syncLocalTranscription,
    validateConnection,
} from "./transcriptions";
export type { CloudTranscription, TranscriptionInput } from "./transcriptions";

export { Permission, Role } from "./appwrite";
