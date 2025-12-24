import { useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { account } from "../lib/appwrite";
import { getCurrentUser } from "../lib/auth";

const CLOUD_FUNCTION_URL = import.meta.env.VITE_CLOUD_TRANSCRIPTION_URL;

export function useCloudTranscription() {
    const jwtRefreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);
    const isSetup = useRef(false);

    const setupCloudCredentials = useCallback(async () => {
        try {
            const user = await getCurrentUser();
            if (!user) {
                await invoke("clear_cloud_credentials");
                isSetup.current = false;
                return;
            }

            const isSubscriber = user.labels?.includes("subscriber") ?? false;
            if (!isSubscriber) {
                await invoke("clear_cloud_credentials");
                isSetup.current = false;
                return;
            }

            const cloudEnabled = localStorage.getItem("glimpse_cloud_sync_enabled") === "true";
            if (!cloudEnabled) {
                await invoke("clear_cloud_credentials");
                isSetup.current = false;
                return;
            }

            if (!CLOUD_FUNCTION_URL) {
                console.warn("VITE_CLOUD_TRANSCRIPTION_URL not configured");
                await invoke("clear_cloud_credentials");
                isSetup.current = false;
                return;
            }

            const jwt = await account.createJWT();
            await invoke("set_cloud_credentials", {
                jwt: jwt.jwt,
                functionUrl: CLOUD_FUNCTION_URL,
            });
            isSetup.current = true;
        } catch (err) {
            console.error("Failed to setup cloud credentials:", err);
            await invoke("clear_cloud_credentials").catch(() => {});
            isSetup.current = false;
        }
    }, []);

    const clearCredentials = useCallback(async () => {
        try {
            await invoke("clear_cloud_credentials");
            isSetup.current = false;
        } catch (err) {
            console.error("Failed to clear cloud credentials:", err);
        }
    }, []);

    useEffect(() => {
        let unlistenAuth: UnlistenFn | null = null;

        setupCloudCredentials();

        // Refresh JWT every 10 minutes (JWT expires in 15 minutes)
        jwtRefreshInterval.current = setInterval(() => {
            if (isSetup.current) {
                setupCloudCredentials();
            }
        }, 10 * 60 * 1000);

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

        return () => {
            if (jwtRefreshInterval.current) {
                clearInterval(jwtRefreshInterval.current);
            }
            window.removeEventListener("storage", handleStorageChange);
            unlistenAuth?.();
        };
    }, [setupCloudCredentials]);

    return {
        refreshCredentials: setupCloudCredentials,
        clearCredentials,
    };
}
