import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, DownloadSimple, X, XLogo } from "@phosphor-icons/react";
import {
  SHARE_STYLES,
  canvasToPngBytes,
  drawShareCard,
  preloadShareFonts,
  type ShareCardData,
} from "./shareCard";

type ShareCardModalProps = {
  isOpen: boolean;
  onClose: () => void;
  data: ShareCardData;
  shareTexts: string[];
};

const ShareCardModal = ({
  isOpen,
  onClose,
  data,
  shareTexts,
}: ShareCardModalProps) => {
  const { t } = useLingui();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [styleIndex, setStyleIndex] = useState(0);
  const [postIndex, setPostIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setStyleIndex(0);
    setPostIndex(Math.floor(Math.random() * shareTexts.length));
    setError(null);
  }, [isOpen, shareTexts.length]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const paint = () => {
      if (cancelled || !canvasRef.current) return;
      drawShareCard(canvasRef.current, SHARE_STYLES[styleIndex], data);
    };
    paint();
    // Repaint once webfonts land so the first open is not drawn in a fallback.
    void preloadShareFonts().then(paint);
    return () => {
      cancelled = true;
    };
  }, [isOpen, styleIndex, data]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        setStyleIndex((index) => {
          const delta = event.key === "ArrowRight" ? 1 : -1;
          return (index + delta + SHARE_STYLES.length) % SHARE_STYLES.length;
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen, onClose]);

  const handleSave = async () => {
    setError(null);
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const path = await save({
        defaultPath: `glimpse-${SHARE_STYLES[styleIndex].id}.png`,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!path) return;
      const bytes = await canvasToPngBytes(canvas);
      await invoke("save_share_image", { path, bytes: Array.from(bytes) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  };

  // X's web intent cannot carry media, so the image goes to the clipboard and
  // the compose window opens ready for a paste.
  const handlePost = async () => {
    setError(null);
    try {
      await copyImage();
    } catch {
      // The post still goes out; the image just has to be attached by hand.
    }
    await openUrl(
      `https://x.com/intent/tweet?text=${encodeURIComponent(shareTexts[postIndex] ?? shareTexts[0])}`,
    );
  };

  const handleCopy = async () => {
    setError(null);
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const done = await copyImage();
      if (!done) throw new Error("Could not render the image");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(
        t({
          id: "settings.stats.share.copy_failed",
          message: "Copying images is not available here. Save it instead.",
        }),
      );
    }
  };

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-xs"
            onClick={onClose}
          />

          <motion.div
            className="relative flex w-[min(430px,calc(100vw-64px))] flex-col rounded-[6px] bg-white p-3 pb-0 shadow-[0_28px_64px_rgba(0,0,0,0.6)]"
            initial={{ opacity: 0, scale: 0.94, y: 14, rotate: -1.5 }}
            animate={{ opacity: 1, scale: 1, y: 0, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 14, rotate: -1.5 }}
            transition={{ type: "spring", stiffness: 380, damping: 28 }}
          >
            <button
              onClick={onClose}
              className="absolute -top-3 -right-3 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-[#1a1716] text-[#f7f5f1] shadow-md transition-transform hover:scale-105"
              aria-label={t({
                id: "settings.stats.share.close",
                message: "Close",
              })}
            >
              <X size={13} weight="bold" />
            </button>

            <div className="relative overflow-hidden rounded-[2px] ring-1 ring-black/10">
              <canvas
                ref={canvasRef}
                className="block w-full"
                style={{ aspectRatio: "1 / 1" }}
              />
            </div>

            <div className="flex items-center justify-between gap-3 py-4">
              <div className="flex items-center gap-1">
                {SHARE_STYLES.map((style, index) => (
                  <button
                    key={style.id}
                    onClick={() => setStyleIndex(index)}
                    aria-label={style.label}
                    aria-pressed={index === styleIndex}
                    className={`flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-[11px] font-semibold transition-colors ${
                      index === styleIndex
                        ? "bg-[#1a1716] text-[#f7f5f1]"
                        : "text-[#8a857c] hover:bg-[#e3e0da] hover:text-[#1a1716]"
                    }`}
                  >
                    {index + 1}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1">
                <LipAction
                  icon={copied ? Check : Copy}
                  label={t({
                    id: "settings.stats.share.copy",
                    message: "Copy",
                  })}
                  onClick={handleCopy}
                />
                <LipAction
                  icon={DownloadSimple}
                  label={t({
                    id: "settings.stats.share.save",
                    message: "Save",
                  })}
                  onClick={handleSave}
                />
                <LipAction
                  icon={XLogo}
                  label={t({
                    id: "settings.stats.share.post",
                    message: "Post",
                  })}
                  onClick={() => void handlePost()}
                />
              </div>
            </div>

            {error && (
              <p className="pb-3 text-center text-[11px] leading-tight text-[#b91c1c]">
                {error}
              </p>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
};

const LipAction = ({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    title={label}
    aria-label={label}
    className="flex h-8 w-8 items-center justify-center rounded-full text-[#46433d] transition-colors hover:bg-[#e3e0da] hover:text-[#1a1716]"
  >
    <Icon size={15} />
  </button>
);

export default ShareCardModal;
