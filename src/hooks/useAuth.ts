import { useState, useEffect, useCallback } from "react";
import { getCurrentUser, type User } from "../lib";

interface AuthState {
    user: User | null;
    isLoading: boolean;
    error: string | null;
}

export function useAuth() {
    const [state, setState] = useState<AuthState>({
        user: null,
        isLoading: true,
        error: null,
    });

    const checkAuth = useCallback(async () => {
        try {
            setState((prev) => ({ ...prev, isLoading: true, error: null }));
            const user = await getCurrentUser();
            setState({ user, isLoading: false, error: null });
        } catch {
            setState({ user: null, isLoading: false, error: null });
        }
    }, []);

    useEffect(() => {
        checkAuth();
    }, [checkAuth]);

    return {
        ...state,
        isAuthenticated: state.user !== null,
        refresh: checkAuth,
    };
}
