import { useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { account } from "../lib/appwrite";
import { getCurrentUser } from "../lib/auth";

const CLOUD_FUNCTION_URL = import.meta.env.VITE_CLOUD_TRANSCRIPTION_URL;
const JWT_REFRESH_INTERVAL = 8 * 60 * 1000; // 8 minutes (JWT expires in 15)

export function useCloudTranscription() {
    const jwtRefreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);

    const setupCloudCredentials = useCallback(async () => {
        try {
            const user = await getCurrentUser();
            if (!user) {
                await invoke("clear_cloud_credentials");
                return;
            }

            const isSubscriber = user.labels?.includes("subscriber") || user.labels?.includes("cloud") || false;

            if (!CLOUD_FUNCTION_URL) {
                await invoke("clear_cloud_credentials");
                return;
            }

            const historySyncEnabled = localStorage.getItem("glimpse_cloud_sync_enabled") === "true";

            const jwt = await account.createJWT();
            await invoke("set_cloud_credentials", {
                jwt: jwt.jwt,
                functionUrl: CLOUD_FUNCTION_URL,
                isSubscriber,
                historySyncEnabled,
            });
        } catch {
            await invoke("clear_cloud_credentials").catch(() => { });
        }
    }, []);

    useEffect(() => {
        let unlistenAuth: UnlistenFn | null = null;
        let unlistenAuthError: UnlistenFn | null = null;

        setupCloudCredentials();

        // Refresh JWT periodically
        jwtRefreshInterval.current = setInterval(() => {
            setupCloudCredentials();
        }, JWT_REFRESH_INTERVAL);

        // Listen for storage changes (cloud sync toggle)
        const handleStorageChange = (e: StorageEvent) => {
            if (e.key === "glimpse_cloud_sync_enabled") {
                setupCloudCredentials();
            }
        };
        window.addEventListener("storage", handleStorageChange);

        // Listen for auth state changes (login/logout)
        listen("auth:changed", () => {
            setupCloudCredentials();
        }).then((fn) => {
            unlistenAuth = fn;
        });

        // Listen for auth errors - clear credentials to force refresh on next attempt
        listen("cloud:auth-error", async () => {
            await invoke("clear_cloud_credentials").catch(() => { });
        }).then((fn) => {
            unlistenAuthError = fn;
        });

        return () => {
            if (jwtRefreshInterval.current) {
                clearInterval(jwtRefreshInterval.current);
            }
            window.removeEventListener("storage", handleStorageChange);
            unlistenAuth?.();
            unlistenAuthError?.();
        };
    }, [setupCloudCredentials]);

    return {
        refreshCredentials: setupCloudCredentials,
    };
}
