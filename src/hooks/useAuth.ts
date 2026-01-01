import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
    createContext,
    createElement,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import { getCurrentUser, type User } from "../lib";

interface AuthState {
    user: User | null;
    isLoading: boolean;
    error: string | null;
}

interface AuthContextValue extends AuthState {
    isAuthenticated: boolean;
    refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AuthState>({
        user: null,
        isLoading: true,
        error: null,
    });

    const refresh = useCallback(async () => {
        setState((prev) => ({ ...prev, isLoading: true, error: null }));
        try {
            const user = await getCurrentUser();
            setState({ user, isLoading: false, error: null });
        } catch (err) {
            setState({
                user: null,
                isLoading: false,
                error: err instanceof Error ? err.message : "Failed to load user",
            });
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    useEffect(() => {
        let unlisten: UnlistenFn | null = null;
        listen("auth:changed", () => {
            refresh();
        }).then((fn) => {
            unlisten = fn;
        });

        return () => {
            unlisten?.();
        };
    }, [refresh]);

    const value = useMemo(
        () => ({
            ...state,
            isAuthenticated: state.user !== null,
            refresh,
        }),
        [state, refresh]
    );

    return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error("useAuth must be used within AuthProvider");
    }
    return context;
}
