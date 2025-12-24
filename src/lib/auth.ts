import { emit } from "@tauri-apps/api/event";
import { account, ID, type Models } from "./appwrite";
import type { OAuthProvider } from "appwrite";

export type User = Models.User<Models.Preferences>;

function emitAuthChanged() {
    emit("auth:changed").catch(() => { });
}

export async function createAccount(
    email: string,
    password: string,
    name?: string
): Promise<User> {
    const user = await account.create(ID.unique(), email, password, name);
    await login(email, password);
    return user;
}

export async function login(
    email: string,
    password: string
): Promise<Models.Session> {
    try {
        await account.deleteSession("current");
    } catch {
    }
    const session = await account.createEmailPasswordSession(email, password);
    emitAuthChanged();
    return session;
}

export async function logout(): Promise<void> {
    await account.deleteSession("current");
    emitAuthChanged();
}

export async function logoutAll(): Promise<void> {
    await account.deleteSessions();
    emitAuthChanged();
}

export async function getCurrentUser(): Promise<User | null> {
    try {
        return await account.get();
    } catch {
        return null;
    }
}

export async function isLoggedIn(): Promise<boolean> {
    const user = await getCurrentUser();
    return user !== null;
}

export async function getCurrentSession(): Promise<Models.Session | null> {
    try {
        return await account.getSession("current");
    } catch {
        return null;
    }
}

export function getOAuth2Url(
    provider: OAuthProvider,
    redirectUrl: string
): string {
    const endpoint = import.meta.env.VITE_APPWRITE_ENDPOINT;
    const projectId = import.meta.env.VITE_APPWRITE_PROJECT_ID;
    return `${endpoint}/account/sessions/oauth2/${provider}?project=${projectId}&success=${encodeURIComponent(redirectUrl)}&failure=${encodeURIComponent(redirectUrl)}`;
}

export function createOAuth2Session(
    provider: OAuthProvider,
    successUrl?: string,
    failureUrl?: string
): void {
    account.createOAuth2Session(
        provider,
        successUrl || window.location.href,
        failureUrl || window.location.href
    );
}

export async function updateName(name: string): Promise<User> {
    return account.updateName(name);
}

export async function updateEmail(
    email: string,
    password: string
): Promise<User> {
    return account.updateEmail(email, password);
}

export async function updatePassword(
    newPassword: string,
    oldPassword: string
): Promise<User> {
    return account.updatePassword(newPassword, oldPassword);
}

export async function requestPasswordRecovery(
    email: string,
    recoveryUrl: string
): Promise<Models.Token> {
    return account.createRecovery(email, recoveryUrl);
}

export async function confirmPasswordRecovery(
    userId: string,
    secret: string,
    password: string
): Promise<Models.Token> {
    return account.updateRecovery(userId, secret, password);
}

export async function getPreferences(): Promise<Models.Preferences> {
    const user = await account.get();
    return user.prefs;
}

export async function updatePreferences(
    prefs: Models.Preferences
): Promise<User> {
    return account.updatePrefs(prefs);
}
export async function listSessions(): Promise<Models.SessionList> {
    return account.listSessions();
}
export async function deleteSessionById(sessionId: string): Promise<void> {
    await account.deleteSession(sessionId);
}
