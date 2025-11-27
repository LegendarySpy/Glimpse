import React, { useRef, useEffect, useCallback, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSharedAnalyser } from "./hooks/useSharedAnalyser";

// --- Types ---

type PillStatus = "idle" | "listening" | "processing" | "error";

interface ToastMessage {
  type: "error" | "info";
  message: string;
  autoDismiss?: boolean;
}

interface GridInfo {
  spacing: number;
  cols: number;
  rows: number;
  offsetX: number;
  offsetY: number;
}

// --- Constants ---

const PILL_WIDTH = 107;
const PILL_HEIGHT = 27;
const DOT_SPACING = 3;
const DOT_RADIUS = {
  base: 0.9,
  icon: 1.2,
  wave: 1.0,
  loader: 1.0,
};

// --- Icon Bitmaps ---

const ICONS = {
  mic: [
    [0, 0, 0, 0, 0],
    [0, 1, 1, 1, 0],
    [0, 1, 0, 1, 0],
    [0, 1, 0, 1, 0],
    [0, 1, 1, 1, 0],
    [0, 0, 1, 0, 0],
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  stop: [
    [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1],
  ],
  warning: [
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0],
  ],
};

const COLORS = {
  base: "40, 40, 40",
  white: "255, 255, 255",
  red: "239, 68, 68",
};

// --- Event Payloads ---

interface RecordingStartPayload { started_at: string; }
interface RecordingErrorPayload { message: string; }
interface TranscriptionStartPayload { path: string; }
interface TranscriptionCompletePayload { transcript: string; confidence?: number | null; auto_paste: boolean; }
interface TranscriptionErrorPayload { message: string; stage: string; }

// --- Toast Component ---

interface ToastProps {
  toast: ToastMessage;
  onDismiss: () => void;
  isLeaving: boolean;
}

const TOAST_MAX_HEIGHT = 80; // Max height before expanding width
const TOAST_MIN_WIDTH = 120;
const TOAST_MAX_WIDTH = 280;

const Toast: React.FC<ToastProps> = ({ toast, onDismiss, isLeaving }) => {
  const [hasShaken, setHasShaken] = useState(false);
  const [needsWider, setNeedsWider] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Shake only on initial mount for errors
    if (toast.type === "error" && !hasShaken) {
      const timer = setTimeout(() => setHasShaken(true), 500);
      return () => clearTimeout(timer);
    }
  }, [toast.type, hasShaken]);

  // Check if content exceeds max height and needs wider width
  useEffect(() => {
    if (contentRef.current) {
      const checkHeight = () => {
        const height = contentRef.current?.scrollHeight || 0;
        setNeedsWider(height > TOAST_MAX_HEIGHT);
      };
      checkHeight();
      // Recheck after fonts load
      const timer = setTimeout(checkHeight, 50);
      return () => clearTimeout(timer);
    }
  }, [toast.message]);

  const isError = toast.type === "error";
  const shouldShake = isError && !hasShaken;

  return (
    <div
      className={`
        relative px-3 py-2.5 rounded-2xl select-none transition-all duration-200 ease-out
        ${isError ? "bg-[#0c0c0c] border border-red-500/40" : "bg-[#0c0c0c] border border-white/10"}
        ${shouldShake ? "animate-shake" : ""}
        ${isLeaving ? "animate-toast-out" : "animate-toast-in"}
      `}
      style={{
        minWidth: TOAST_MIN_WIDTH,
        maxWidth: needsWider ? TOAST_MAX_WIDTH : 200,
        maxHeight: TOAST_MAX_HEIGHT + 20, // Some padding for the container
      }}
    >
      {/* Close button */}
      <button
        onClick={onDismiss}
        className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-[#1a1a1a] border border-[#333] 
                   flex items-center justify-center text-[10px] text-gray-400 hover:text-white 
                   hover:border-gray-500 hover:bg-[#252525] transition-all z-10"
      >
        ✕
      </button>

      {/* Content */}
      <div ref={contentRef} className="flex items-start gap-2.5 overflow-hidden" style={{ maxHeight: TOAST_MAX_HEIGHT }}>
        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${isError ? "bg-red-500 animate-pulse" : "bg-white/50"}`} />
        <p className="text-[11px] text-gray-200 leading-relaxed pr-2">{toast.message}</p>
      </div>
    </div>
  );
};

// --- Main Pill Component ---

export interface PillOverlayProps {
  className?: string;
  style?: React.CSSProperties;
  sensitivity?: number;
  decay?: number;
}

const PillOverlay: React.FC<PillOverlayProps> = ({
  className = "",
  style = {},
  sensitivity = 2,
  decay = 0.85,
}) => {
  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<GridInfo>({ spacing: DOT_SPACING, cols: 0, rows: 0, offsetX: 0, offsetY: 0 });
  const heightsRef = useRef<number[]>([]);
  const animationRef = useRef<number | null>(null);
  const loaderTimeRef = useRef<number>(0);

  // State
  const [status, setStatus] = useState<PillStatus>("idle");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [toastLeaving, setToastLeaving] = useState(false);
  const [recordingMode, setRecordingMode] = useState<"hold" | "toggle" | null>(null);
  const [isErrorFlashing, setIsErrorFlashing] = useState(false);

  // Audio
  const { analyser, isListening, start, stop } = useSharedAnalyser();
  const analyserRef = useRef<AnalyserNode | null>(null);

  useEffect(() => {
    analyserRef.current = analyser;
  }, [analyser]);

  // --- Hide overlay window ---
  const hideOverlay = useCallback(async () => {
    try {
      const window = getCurrentWindow();
      await window.hide();
    } catch (err) {
      console.error("Failed to hide window:", err);
    }
  }, []);

  // --- Dismiss handler (closes toast AND hides window) ---
  const dismissOverlay = useCallback(() => {
    if (toast) {
      // Animate out then hide
      setToastLeaving(true);
      setTimeout(() => {
        setToast(null);
        setToastLeaving(false);
        setStatus("idle");
        setIsErrorFlashing(false);
        hideOverlay();
      }, 150);
    } else {
      hideOverlay();
    }
  }, [toast, hideOverlay]);

  // --- Keyboard handler (Esc to dismiss) ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (toast || status === "error")) {
        e.preventDefault();
        dismissOverlay();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toast, status, dismissOverlay]);

  // --- Drawing Utilities ---

  const getMaskOpacity = useCallback((x: number, y: number, width: number, height: number): number => {
    const radius = height / 2;
    const leftCenter = radius;
    const rightCenter = width - radius;
    let distToEdge = 0;

    if (x < leftCenter) {
      const dist = Math.sqrt((x - leftCenter) ** 2 + (y - height / 2) ** 2);
      distToEdge = radius - dist;
    } else if (x > rightCenter) {
      const dist = Math.sqrt((x - rightCenter) ** 2 + (y - height / 2) ** 2);
      distToEdge = radius - dist;
    } else {
      distToEdge = Math.min(y, height - y);
    }

    return Math.max(0, Math.min(1, distToEdge / 15));
  }, []);

  const isIconPixel = useCallback((col: number, row: number, icon: number[][], centerCol: number, centerRow: number): boolean => {
    const iconH = icon.length;
    const iconW = icon[0].length;
    const startCol = centerCol - Math.floor(iconW / 2);
    const startRow = centerRow - Math.floor(iconH / 2);
    const localCol = col - startCol;
    const localRow = row - startRow;

    if (localCol >= 0 && localCol < iconW && localRow >= 0 && localRow < iconH) {
      return icon[localRow][localCol] === 1;
    }
    return false;
  }, []);

  // --- Draw Functions ---

  const drawStaticIcon = useCallback((icon: number[][], color: string, glowColor?: string) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const { cols, rows, spacing, offsetX, offsetY } = gridRef.current;
    const centerCol = Math.floor(cols / 2);
    const centerRow = Math.floor(rows / 2);

    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const cx = offsetX + c * spacing + spacing / 2;
        const cy = offsetY + r * spacing + spacing / 2;
        const maskAlpha = getMaskOpacity(cx, cy, width, height);
        if (maskAlpha <= 0.05) continue;

        const isIcon = isIconPixel(c, r, icon, centerCol, centerRow);

        ctx.beginPath();
        if (isIcon) {
          ctx.fillStyle = `rgba(${color}, ${maskAlpha})`;
          ctx.shadowBlur = glowColor ? 8 : 0;
          ctx.shadowColor = glowColor ? `rgba(${glowColor}, 0.5)` : "transparent";
          ctx.arc(cx, cy, DOT_RADIUS.icon, 0, Math.PI * 2);
        } else {
          ctx.fillStyle = `rgba(${COLORS.base}, ${maskAlpha})`;
          ctx.shadowBlur = 0;
          ctx.shadowColor = "transparent";
          ctx.arc(cx, cy, DOT_RADIUS.base, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
  }, [getMaskOpacity, isIconPixel]);

  const drawProcessingFrame = useCallback((time: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const { cols, rows, spacing, offsetX, offsetY } = gridRef.current;

    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const waveSpeed = 0.003;
    const waveLength = cols * 0.3;
    const pulseSpeed = 0.002;

    for (let c = 0; c < cols; c++) {
      const wavePhase = (c / waveLength) - (time * waveSpeed);
      const waveValue = Math.sin(wavePhase * Math.PI * 2);
      const pulseValue = 0.5 + 0.5 * Math.sin(time * pulseSpeed * Math.PI * 2);
      const amplitude = (0.3 + 0.7 * ((waveValue + 1) / 2)) * pulseValue;
      const activeRadius = amplitude * (height * 0.35);

      for (let r = 0; r < rows; r++) {
        const cx = offsetX + c * spacing + spacing / 2;
        const cy = offsetY + r * spacing + spacing / 2;
        const maskAlpha = getMaskOpacity(cx, cy, width, height);
        if (maskAlpha <= 0.05) continue;

        const distFromCenterY = Math.abs(cy - height / 2);
        const isActive = distFromCenterY < activeRadius;

        ctx.beginPath();
        if (isActive) {
          const brightness = 1 - (distFromCenterY / (activeRadius + 0.1));
          ctx.fillStyle = `rgba(${COLORS.white}, ${brightness * maskAlpha})`;
          ctx.arc(cx, cy, DOT_RADIUS.loader, 0, Math.PI * 2);
        } else {
          ctx.fillStyle = `rgba(${COLORS.base}, ${maskAlpha * 0.5})`;
          ctx.arc(cx, cy, DOT_RADIUS.base, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
  }, [getMaskOpacity]);

  const drawErrorFrame = useCallback((time: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const { cols, rows, spacing, offsetX, offsetY } = gridRef.current;
    const centerCol = Math.floor(cols / 2);
    const centerRow = Math.floor(rows / 2);

    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Fast flash effect
    const flash = Math.sin(time * 0.02 * Math.PI * 2);
    const intensity = 0.5 + 0.5 * Math.max(0, flash);

    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const cx = offsetX + c * spacing + spacing / 2;
        const cy = offsetY + r * spacing + spacing / 2;
        const maskAlpha = getMaskOpacity(cx, cy, width, height);
        if (maskAlpha <= 0.05) continue;

        const isIcon = isIconPixel(c, r, ICONS.warning, centerCol, centerRow);

        ctx.beginPath();
        if (isIcon) {
          ctx.fillStyle = `rgba(${COLORS.red}, ${maskAlpha})`;
          ctx.shadowBlur = 6;
          ctx.shadowColor = `rgba(${COLORS.red}, 0.6)`;
          ctx.arc(cx, cy, DOT_RADIUS.icon, 0, Math.PI * 2);
        } else {
          ctx.fillStyle = `rgba(${COLORS.red}, ${intensity * maskAlpha * 0.6})`;
          ctx.shadowBlur = 0;
          ctx.shadowColor = "transparent";
          ctx.arc(cx, cy, DOT_RADIUS.base, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
  }, [getMaskOpacity, isIconPixel]);

  const drawAudioFrame = useCallback((audioData: Uint8Array, showStopIcon: boolean) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const { cols, rows, spacing, offsetX, offsetY } = gridRef.current;
    const centerCol = Math.floor(cols / 2);
    const centerRow = Math.floor(rows / 2);

    if (audioData.length > 0) {
      for (let i = 0; i <= centerCol; i++) {
        const distFromCenter = i / centerCol;
        const freqIndex = Math.floor(audioData.length * 0.4 * (distFromCenter * distFromCenter));
        let sample = audioData[freqIndex] || 0;
        if (audioData[freqIndex + 1]) sample = (sample + audioData[freqIndex + 1]) / 2;

        let val = (sample / 255) * sensitivity;
        if (distFromCenter < 0.2) val *= 1.25;
        val = Math.min(val, 1.0);

        const leftIdx = centerCol - i;
        if (leftIdx >= 0 && leftIdx < cols) {
          if (val > heightsRef.current[leftIdx]) {
            heightsRef.current[leftIdx] += (val - heightsRef.current[leftIdx]) * 0.5;
          } else {
            heightsRef.current[leftIdx] += (val - heightsRef.current[leftIdx]) * (1 - decay);
          }
        }

        const rightIdx = centerCol + i;
        if (rightIdx < cols && rightIdx !== leftIdx) {
          heightsRef.current[rightIdx] = heightsRef.current[leftIdx];
        }
      }
    }

    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let c = 0; c < cols; c++) {
      const amp = heightsRef.current[c] || 0;
      const activeRadiusPixels = amp * (height * 0.45);

      for (let r = 0; r < rows; r++) {
        const cx = offsetX + c * spacing + spacing / 2;
        const cy = offsetY + r * spacing + spacing / 2;
        const maskAlpha = getMaskOpacity(cx, cy, width, height);
        if (maskAlpha <= 0.05) continue;

        const distFromCenterY = Math.abs(cy - height / 2);
        const isWaveActive = activeRadiusPixels > 0.5 && distFromCenterY < activeRadiusPixels;
        const isIcon = showStopIcon && isIconPixel(c, r, ICONS.stop, centerCol, centerRow);

        ctx.beginPath();
        if (isIcon) {
          ctx.fillStyle = `rgba(${COLORS.red}, ${maskAlpha})`;
          ctx.shadowBlur = 8;
          ctx.shadowColor = `rgba(${COLORS.red}, 0.5)`;
          ctx.arc(cx, cy, DOT_RADIUS.icon, 0, Math.PI * 2);
        } else if (isWaveActive) {
          const waveEdgeDist = 1 - (distFromCenterY / (activeRadiusPixels + 0.1));
          const brightness = 0.5 + (waveEdgeDist * 0.5);
          ctx.fillStyle = `rgba(${COLORS.white}, ${brightness * maskAlpha})`;
          ctx.shadowBlur = brightness > 0.8 ? 4 : 0;
          ctx.shadowColor = brightness > 0.8 ? `rgba(${COLORS.white}, 0.4)` : "transparent";
          ctx.arc(cx, cy, DOT_RADIUS.wave, 0, Math.PI * 2);
        } else {
          ctx.fillStyle = `rgba(${COLORS.base}, ${maskAlpha})`;
          ctx.shadowBlur = 0;
          ctx.shadowColor = "transparent";
          ctx.arc(cx, cy, DOT_RADIUS.base, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
  }, [decay, getMaskOpacity, isIconPixel, sensitivity]);

  // --- Animation Controller ---

  const stopAllAnimations = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const runAnimation = useCallback((type: "processing" | "listening" | "error", showStopIcon = false) => {
    stopAllAnimations();
    loaderTimeRef.current = 0;

    const tick = () => {
      loaderTimeRef.current += 16;

      switch (type) {
        case "processing":
          drawProcessingFrame(loaderTimeRef.current);
          break;
        case "listening":
          if (analyserRef.current) {
            const bufferLength = analyserRef.current.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            analyserRef.current.getByteFrequencyData(dataArray);
            drawAudioFrame(dataArray, showStopIcon);
          }
          break;
        case "error":
          drawErrorFrame(loaderTimeRef.current);
          break;
      }

      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);
  }, [drawAudioFrame, drawErrorFrame, drawProcessingFrame, stopAllAnimations]);

  const fadeOutWave = useCallback(() => {
    let hasActivity = false;
    for (let i = 0; i < heightsRef.current.length; i++) {
      heightsRef.current[i] *= 0.8;
      if (heightsRef.current[i] > 0.01) hasActivity = true;
    }

    if (hasActivity) {
      drawAudioFrame(new Uint8Array(0), false);
      animationRef.current = requestAnimationFrame(fadeOutWave);
    } else {
      heightsRef.current.fill(0);
      drawStaticIcon(ICONS.mic, COLORS.white, COLORS.white);
    }
  }, [drawAudioFrame, drawStaticIcon]);

  // --- Show Error ---
  const showError = useCallback((message: string) => {
    setStatus("error");
    setToast({ type: "error", message, autoDismiss: false });
    setIsErrorFlashing(true);

    // Stop flashing after animation, keep error state
    setTimeout(() => setIsErrorFlashing(false), 1200);
  }, []);

  // --- Show Info Toast (auto-dismisses) - for future use ---
  // const showInfo = useCallback((message: string, duration = 2000) => {
  //   setToast({ type: "info", message, autoDismiss: true });
  //   setTimeout(() => {
  //     setToastLeaving(true);
  //     setTimeout(() => {
  //       setToast(null);
  //       setToastLeaving(false);
  //     }, 150);
  //   }, duration);
  // }, []);

  // --- Event Listeners ---

  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<{ mode: string }>("recording:mode_change", (event) => {
        setRecordingMode(event.payload.mode as "hold" | "toggle");
      }),
      listen<RecordingStartPayload>("recording:start", async () => {
        setStatus("listening");
        setToast(null);
        try {
          await start();
        } catch (err) {
          console.error(err);
          showError("Microphone permission needed");
        }
      }),
      listen("recording:stop", () => {
        setStatus("processing");
        setRecordingMode(null);
        stop();
      }),
      listen<RecordingErrorPayload>("recording:error", (event) => {
        showError(event.payload.message);
        stop();
      }),
      listen<TranscriptionStartPayload>("transcription:start", () => {
        setStatus("processing");
      }),
      listen<TranscriptionCompletePayload>("transcription:complete", () => {
        // Success - hide the overlay
        setStatus("idle");
        hideOverlay();
      }),
      listen<TranscriptionErrorPayload>("transcription:error", (event) => {
        showError(event.payload.message);
      }),
    ];

    return () => {
      unlisteners.forEach(async (p) => {
        try { (await p)(); } catch { }
      });
      stop();
    };
  }, [start, stop, showError, hideOverlay]);

  // --- Canvas Setup ---

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext("2d");
    if (ctx) ctx.scale(dpr, dpr);

    const cols = Math.floor(rect.width / DOT_SPACING);
    const rows = Math.floor(rect.height / DOT_SPACING);
    gridRef.current = {
      spacing: DOT_SPACING,
      cols,
      rows,
      offsetX: (rect.width - cols * DOT_SPACING) / 2,
      offsetY: (rect.height - rows * DOT_SPACING) / 2,
    };

    if (heightsRef.current.length !== cols) {
      heightsRef.current = new Array(cols).fill(0);
    }
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(setupCanvas);
    if (containerRef.current) observer.observe(containerRef.current);
    setupCanvas();

    return () => {
      observer.disconnect();
      stopAllAnimations();
    };
  }, [setupCanvas, stopAllAnimations]);

  // --- Visual State Management ---

  useEffect(() => {
    stopAllAnimations();

    switch (status) {
      case "idle":
        drawStaticIcon(ICONS.mic, COLORS.white, COLORS.white);
        break;

      case "listening":
        if (isListening && analyser) {
          runAnimation("listening", recordingMode === "toggle");
        }
        break;

      case "processing":
        runAnimation("processing");
        break;

      case "error":
        if (isErrorFlashing) {
          runAnimation("error");
        } else {
          // Static error state with warning icon
          drawStaticIcon(ICONS.warning, COLORS.red, COLORS.red);
        }
        break;
    }
  }, [status, isListening, analyser, recordingMode, isErrorFlashing, drawStaticIcon, runAnimation, stopAllAnimations]);

  useEffect(() => {
    if (status === "listening" && isListening && analyser) {
      runAnimation("listening", recordingMode === "toggle");
    } else if (status === "listening" && !isListening) {
      fadeOutWave();
    }
  }, [isListening, analyser, status, recordingMode, runAnimation, fadeOutWave]);

  // --- Render ---

  const getStatusLabel = () => {
    switch (status) {
      case "idle": return "Ready";
      case "listening": return recordingMode === "toggle" ? "Tap to stop" : "Release to stop";
      case "processing": return "Processing…";
      case "error": return "Error";
    }
  };

  const statusColors: Record<PillStatus, string> = {
    idle: "text-gray-500",
    listening: "text-rose-400",
    processing: "text-gray-400",
    error: "text-red-400",
  };

  return (
    <div
      className={`relative w-full h-full flex flex-col justify-end select-none ${className}`}
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Pill - fixed at bottom, never moves */}
      <div className="relative flex flex-col items-center pb-2">
        {/* Toast - absolutely positioned above pill, doesn't affect pill layout */}
        {toast && (
          <div
            className="absolute left-1/2 flex justify-center pointer-events-auto"
            style={{
              bottom: PILL_HEIGHT + 20 + 16, // pill height + status text area + gap
              transform: 'translateX(-50%)',
            }}
          >
            <Toast
              toast={toast}
              onDismiss={dismissOverlay}
              isLeaving={toastLeaving}
            />
          </div>
        )}

        <div
          ref={containerRef}
          className={`relative rounded-full bg-[#050505] overflow-hidden ${isErrorFlashing ? "animate-shake" : ""}`}
          style={{
            width: PILL_WIDTH,
            height: PILL_HEIGHT,
            boxShadow: status === "error"
              ? "0 0 20px rgba(239, 68, 68, 0.3), inset 0 1px 1px rgba(255,255,255,0.1), inset 0 -2px 5px rgba(0,0,0,0.8)"
              : "0 8px 20px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.15), inset 0 -2px 5px rgba(0,0,0,0.8)",
          }}
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full block"
          />
        </div>

        {/* Status Text */}
        <div className="mt-2 text-center">
          <p className={`text-[9px] uppercase tracking-[0.25em] ${statusColors[status]}`}>
            {getStatusLabel()}
          </p>
        </div>
      </div>
    </div>
  );
};

export default PillOverlay;
