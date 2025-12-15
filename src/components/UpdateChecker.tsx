import { useState, useEffect, useCallback } from "react"
import { check, type Update } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { Download, RefreshCw, CheckCircle, AlertCircle, Loader2 } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import WhatsNewModal from "./WhatsNewModal"

interface UpdateCheckerProps {
    autoCheck?: boolean
}

export function UpdateChecker({ autoCheck = true }: UpdateCheckerProps) {
    const [update, setUpdate] = useState<Update | null>(null)
    const [checking, setChecking] = useState(false)
    const [downloading, setDownloading] = useState(false)
    const [progress, setProgress] = useState(0)
    const [error, setError] = useState<string | null>(null)
    const [installed, setInstalled] = useState(false)
    const [whatsNewOpen, setWhatsNewOpen] = useState(false)

    const checkForUpdates = useCallback(async () => {
        setChecking(true)
        setError(null)
        try {
            const result = await check()
            setUpdate(result)
        } catch (err) {
            console.error("Update check failed:", err)
            setError(err instanceof Error ? err.message : "Failed to check for updates")
        } finally {
            setChecking(false)
        }
    }, [])

    useEffect(() => {
        if (autoCheck) {
            checkForUpdates()
        }
    }, [autoCheck, checkForUpdates])

    useEffect(() => {
        let unlistenCheck: UnlistenFn | undefined

        listen("updater:check", () => {
            checkForUpdates()
        }).then((fn) => {
            unlistenCheck = fn
        })

        return () => {
            unlistenCheck?.()
        }
    }, [checkForUpdates])

    const handleDownloadAndInstall = async () => {
        if (!update) return

        setDownloading(true)
        setProgress(0)
        setError(null)

        try {
            let downloaded = 0
            let contentLength = 0

            await update.downloadAndInstall((event) => {
                switch (event.event) {
                    case "Started":
                        contentLength = event.data.contentLength ?? 0
                        break
                    case "Progress":
                        downloaded += event.data.chunkLength
                        if (contentLength > 0) {
                            setProgress(Math.round((downloaded / contentLength) * 100))
                        }
                        break
                    case "Finished":
                        setProgress(100)
                        break
                }
            })

            setInstalled(true)
        } catch (err) {
            console.error("Update failed:", err)
            setError(err instanceof Error ? err.message : "Failed to download update")
        } finally {
            setDownloading(false)
        }
    }

    const handleRelaunch = async () => {
        await relaunch()
    }

    if (installed) {
        return (
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-3 rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-3 h-[52px]"
            >
                <CheckCircle size={16} className="text-green-400" />
                <div className="flex-1">
                    <p className="text-[12px] font-medium text-green-400">Update installed!</p>
                    <p className="text-[10px] text-green-400/70">Restart the app to apply changes.</p>
                </div>
                <motion.button
                    onClick={handleRelaunch}
                    className="rounded-lg bg-green-500 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-green-400 transition-colors"
                    whileTap={{ scale: 0.97 }}
                >
                    Restart Now
                </motion.button>
            </motion.div>
        )
    }

    if (update) {
        return (
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-4 py-3 h-[52px]"
            >
                <Download size={16} className="text-amber-400" />
                <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-amber-400">
                        v{update.version} available
                    </p>
                    {update.body && (
                        <p className="text-[10px] text-[#6b6b76] truncate max-w-[200px]">
                            {update.body}
                        </p>
                    )}
                </div>
                <AnimatePresence mode="wait">
                    {downloading ? (
                        <motion.div
                            key="downloading"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2"
                        >
                            <div className="w-20 h-1.5 bg-[#2a2a30] rounded-full overflow-hidden">
                                <motion.div
                                    className="h-full bg-amber-400 rounded-full"
                                    initial={{ width: 0 }}
                                    animate={{ width: `${progress}%` }}
                                    transition={{ duration: 0.2 }}
                                />
                            </div>
                            <span className="text-[10px] text-[#6b6b76] w-8">{progress}%</span>
                        </motion.div>
                    ) : (
                        <motion.button
                            key="update-btn"
                            onClick={handleDownloadAndInstall}
                            className="rounded-lg bg-amber-400 px-3 py-1.5 text-[11px] font-medium text-black hover:bg-amber-300 transition-colors"
                            whileTap={{ scale: 0.97 }}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                        >
                            Update
                        </motion.button>
                    )}
                </AnimatePresence>
            </motion.div>
        )
    }

    if (error) {
        return (
            <div className="flex items-center gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 h-[52px]">
                <AlertCircle size={16} className="text-red-400" />
                <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-red-400">Update check failed</p>
                    <p className="text-[10px] text-red-400/70 truncate">{error}</p>
                </div>
                <motion.button
                    onClick={checkForUpdates}
                    className="flex items-center gap-1.5 rounded-lg border border-red-500/20 px-2.5 py-1.5 text-[11px] text-red-400 hover:bg-red-500/10 transition-colors"
                    whileTap={{ scale: 0.97 }}
                >
                    <RefreshCw size={12} />
                    Retry
                </motion.button>
            </div>
        )
    }

    return (
        <>
            <div className="flex items-center gap-3 rounded-lg border border-[#1e1e22] bg-[#111113] px-4 py-3 h-[52px]">
                {checking ? (
                    <>
                        <Loader2 size={16} className="text-[#6b6b76] animate-spin shrink-0" />
                        <p className="flex-1 text-[12px] text-[#6b6b76]">Checking for updates...</p>
                    </>
                ) : (
                    <>
                        <CheckCircle size={16} className="text-[#4a4a54] shrink-0" />
                        <p className="flex-1 text-[12px] text-[#e8e8eb]">You're up to date!</p>
                        <button
                            onClick={() => setWhatsNewOpen(true)}
                            className="text-[11px] text-[#6b6b76] hover:text-[#a0a0ab] underline underline-offset-2 transition-colors"
                        >
                            What's new?
                        </button>
                        <motion.button
                            onClick={checkForUpdates}
                            className="p-1.5 rounded-md text-[#6b6b76] hover:text-[#a0a0ab] hover:bg-[#1a1a1e] transition-colors"
                            whileTap={{ scale: 0.95 }}
                            title="Check for updates"
                        >
                            <RefreshCw size={14} />
                        </motion.button>
                    </>
                )}
            </div>
            <WhatsNewModal isOpen={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
        </>
    )
}

export default UpdateChecker
