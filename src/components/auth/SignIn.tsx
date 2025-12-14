import { useState, useCallback, useEffect } from "react";
import { motion } from "framer-motion";
import { Mail, Lock, Loader2, AlertCircle, Eye, EyeOff, Copy, Check } from "lucide-react";
import { login, createAccount, createOAuth2Session } from "../../lib/auth";
import { OAuthProvider } from "appwrite";

const GlimpseLogo = () => {
    const [pattern, setPattern] = useState(0);

    const patterns = [
        [true, false, false, true],
        [false, true, true, false],
        [true, true, true, true],
        [true, false, false, true],
    ];

    useEffect(() => {
        const interval = setInterval(() => {
            setPattern((p) => (p + 1) % patterns.length);
        }, 700);
        return () => clearInterval(interval);
    }, []);

    const currentPattern = patterns[pattern];
    const dotSize = 10;
    const gap = 7;
    const gridSize = dotSize * 2 + gap;

    return (
        <div className="relative" style={{ width: gridSize, height: gridSize }}>
            {[0, 1, 2, 3].map((i) => {
                const row = Math.floor(i / 2);
                const col = i % 2;
                const isActive = currentPattern[i];

                return (
                    <motion.div
                        key={i}
                        className="absolute rounded-full bg-amber-400"
                        style={{
                            width: dotSize,
                            height: dotSize,
                            left: col * (dotSize + gap),
                            top: row * (dotSize + gap),
                        }}
                        animate={{
                            opacity: isActive ? 1 : 0.15,
                            scale: isActive ? 1 : 0.85,
                        }}
                        transition={{ duration: 0.3, ease: "easeOut" }}
                    />
                );
            })}
        </div>
    );
};

interface SignInProps {
    onSuccess: () => void;
    onSkip?: () => void;
}

export default function SignIn({ onSuccess, onSkip }: SignInProps) {
    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorCopied, setErrorCopied] = useState(false);

    const handleSubmit = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            setError(null);
            setIsLoading(true);

            try {
                if (mode === "signup") {
                    await createAccount(email, password, name || undefined);
                } else {
                    await login(email, password);
                }
                onSuccess();
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : "Authentication failed";
                setError(message);
            } finally {
                setIsLoading(false);
            }
        },
        [mode, email, password, name, onSuccess]
    );

    const handleOAuth = useCallback((provider: OAuthProvider) => {
        createOAuth2Session(provider);
    }, []);

    return (
        <div className="flex h-screen w-screen flex-col items-center justify-center overflow-hidden bg-[#0a0a0c] text-white select-none">
            <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-7" />

            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full max-w-sm px-6"
            >
                <div className="flex flex-col items-center mb-8">
                    <GlimpseLogo />
                    <h1 className="mt-4 text-xl font-semibold text-[#e8e8eb]">
                        {mode === "signin" ? "Welcome back" : "Create account"}
                    </h1>
                    <p className="mt-1 text-sm text-[#6b6b76]">
                        {mode === "signin"
                            ? "Sign in to sync your transcriptions"
                            : "Sign up for Glimpse Cloud"}
                    </p>
                </div>

                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400"
                    >
                        <AlertCircle size={16} className="shrink-0" />
                        <span className="flex-1">{error}</span>
                        <button
                            type="button"
                            onClick={() => {
                                navigator.clipboard.writeText(error);
                                setErrorCopied(true);
                                setTimeout(() => setErrorCopied(false), 1500);
                            }}
                            className="shrink-0 p-1 rounded hover:bg-red-500/20 transition-colors"
                            title="Copy error"
                        >
                            {errorCopied ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                    </motion.div>
                )}

                <form onSubmit={handleSubmit} className="space-y-3">
                    {mode === "signup" && (
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Name (optional)"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="w-full rounded-lg border border-[#1e1e28] bg-[#111115] px-4 py-3 pl-11 text-sm text-white placeholder-[#4a4a54] outline-none transition-colors focus:border-[#3a3a45] focus:bg-[#131318]"
                            />
                            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-[#4a4a54]">
                                <Mail size={16} />
                            </div>
                        </div>
                    )}

                    <div className="relative">
                        <input
                            type="email"
                            placeholder="Email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            className="w-full rounded-lg border border-[#1e1e28] bg-[#111115] px-4 py-3 pl-11 text-sm text-white placeholder-[#4a4a54] outline-none transition-colors focus:border-[#3a3a45] focus:bg-[#131318]"
                        />
                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-[#4a4a54]">
                            <Mail size={16} />
                        </div>
                    </div>

                    <div className="relative">
                        <input
                            type={showPassword ? "text" : "password"}
                            placeholder="Password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            minLength={8}
                            className="w-full rounded-lg border border-[#1e1e28] bg-[#111115] px-4 py-3 pl-11 pr-11 text-sm text-white placeholder-[#4a4a54] outline-none transition-colors focus:border-[#3a3a45] focus:bg-[#131318]"
                        />
                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-[#4a4a54]">
                            <Lock size={16} />
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-4 top-1/2 -translate-y-1/2 text-[#4a4a54] hover:text-[#6b6b76] transition-colors"
                        >
                            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                    </div>

                    <button
                        type="submit"
                        disabled={isLoading}
                        className="w-full flex items-center justify-center gap-2 rounded-lg bg-[#e8e8eb] px-5 py-3 text-sm font-semibold text-[#0a0a0c] hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isLoading ? (
                            <>
                                <Loader2 size={16} className="animate-spin" />
                                {mode === "signin" ? "Signing in..." : "Creating account..."}
                            </>
                        ) : mode === "signin" ? (
                            "Sign In"
                        ) : (
                            "Create Account"
                        )}
                    </button>
                </form>

                <div className="my-6 flex items-center gap-3">
                    <div className="flex-1 h-px bg-[#1e1e28]" />
                    <span className="text-xs text-[#4a4a54]">or continue with</span>
                    <div className="flex-1 h-px bg-[#1e1e28]" />
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <button
                        type="button"
                        onClick={() => handleOAuth(OAuthProvider.Google)}
                        className="flex items-center justify-center gap-2 rounded-lg border border-[#1e1e28] bg-[#111115] px-4 py-2.5 text-sm text-[#c0c0c8] hover:bg-[#161619] hover:border-[#2a2a34] transition-colors"
                    >
                        <svg className="w-4 h-4" viewBox="0 0 24 24">
                            <path
                                fill="currentColor"
                                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                            />
                            <path
                                fill="currentColor"
                                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                            />
                            <path
                                fill="currentColor"
                                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                            />
                            <path
                                fill="currentColor"
                                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                            />
                        </svg>
                        Google
                    </button>

                    <button
                        type="button"
                        onClick={() => handleOAuth(OAuthProvider.Github)}
                        className="flex items-center justify-center gap-2 rounded-lg border border-[#1e1e28] bg-[#111115] px-4 py-2.5 text-sm text-[#c0c0c8] hover:bg-[#161619] hover:border-[#2a2a34] transition-colors"
                    >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385c.6.105.825-.255.825-.57c0-.285-.015-1.23-.015-2.235c-3.015.555-3.795-.735-4.035-1.41c-.135-.345-.72-1.41-1.23-1.695c-.42-.225-1.02-.78-.015-.795c.945-.015 1.62.87 1.845 1.23c1.08 1.815 2.805 1.305 3.495.99c.105-.78.42-1.305.765-1.605c-2.67-.3-5.46-1.335-5.46-5.925c0-1.305.465-2.385 1.23-3.225c-.12-.3-.54-1.53.12-3.18c0 0 1.005-.315 3.3 1.23c.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23c.66 1.65.24 2.88.12 3.18c.765.84 1.23 1.905 1.23 3.225c0 4.605-2.805 5.625-5.475 5.925c.435.375.81 1.095.81 2.22c0 1.605-.015 2.895-.015 3.3c0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                        </svg>
                        GitHub
                    </button>
                </div>

                <p className="mt-6 text-center text-sm text-[#6b6b76]">
                    {mode === "signin" ? (
                        <>
                            Don't have an account?{" "}
                            <button
                                type="button"
                                onClick={() => {
                                    setMode("signup");
                                    setError(null);
                                }}
                                className="text-amber-400 hover:text-amber-300 transition-colors"
                            >
                                Sign up
                            </button>
                        </>
                    ) : (
                        <>
                            Already have an account?{" "}
                            <button
                                type="button"
                                onClick={() => {
                                    setMode("signin");
                                    setError(null);
                                }}
                                className="text-amber-400 hover:text-amber-300 transition-colors"
                            >
                                Sign in
                            </button>
                        </>
                    )}
                </p>

                {onSkip && (
                    <button
                        type="button"
                        onClick={onSkip}
                        className="mt-4 w-full text-center text-xs text-[#4a4a54] hover:text-[#6b6b76] transition-colors"
                    >
                        Skip for now → Use local mode
                    </button>
                )}
            </motion.div>
        </div>
    );
}
