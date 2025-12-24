import React, { useRef, useEffect, useCallback, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

type PillStatus = "idle" | "listening" | "processing" | "error";

interface PillStatePayload {
  status: PillStatus;
  mode?: string;
}

interface GridInfo {
  spacing: number;
  cols: number;
  rows: number;
  offsetX: number;
  offsetY: number;
}

const PILL_WIDTH = 97;
const PILL_HEIGHT = 27;
const DOT_SPACING = 3;
const DOT_RADIUS = {
  base: 0.9,
  icon: 1.2,
  wave: 1.0,
  loader: 1.0,
};

const ICONS = {
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

export interface PillOverlayProps {
  className?: string;
  style?: React.CSSProperties;
  sensitivity?: number;
  decay?: number;
}

const PillOverlay: React.FC<PillOverlayProps> = ({
  className = "",
  style = {},
  sensitivity = 3,
  decay = 0.85,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<GridInfo>({ spacing: DOT_SPACING, cols: 0, rows: 0, offsetX: 0, offsetY: 0 });
  const heightsRef = useRef<number[]>([]);
  const animationRef = useRef<number | null>(null);
  const loaderTimeRef = useRef<number>(0);
  const audioReferenceLevelRef = useRef<number>(0);
  const audioFrameCountRef = useRef<number>(0);

  // Single source of truth for frontend rendering (backend is the real truth)
  const [status, setStatus] = useState<PillStatus>("idle");
  const statusRef = useRef<PillStatus>("idle");
  const [isErrorFlashing, setIsErrorFlashing] = useState(false);

  // Web Audio Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const micGenerationRef = useRef(0);

  // --- Visual Logic (Dumb) ---

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

    const speed = 0.0015;
    const waveLength = cols * 0.4;
    const breathe = 0.5 + 0.5 * Math.sin(time * 0.001);

    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const cx = offsetX + c * spacing + spacing / 2;
        const cy = offsetY + r * spacing + spacing / 2;
        const maskAlpha = getMaskOpacity(cx, cy, width, height);
        if (maskAlpha <= 0.05) continue;

        const distFromCenterY = Math.abs(cy - height / 2);
        const wavePhase = (c / waveLength) - (time * speed);
        const wave = Math.sin(wavePhase * Math.PI * 2) * 0.5 + 0.5;

        const maxRadius = height * 0.4 * (0.6 + 0.4 * breathe);
        const activeRadius = wave * maxRadius;
        const isActive = distFromCenterY < activeRadius;

        ctx.beginPath();
        if (isActive) {
          const edgeFactor = 1 - (distFromCenterY / (activeRadius + 0.5));
          const brightness = Math.pow(edgeFactor, 1.5) * (0.7 + 0.3 * wave);

          ctx.fillStyle = `rgba(${COLORS.white}, ${brightness * maskAlpha})`;
          if (brightness > 0.7) {
            ctx.shadowBlur = 3;
            ctx.shadowColor = `rgba(${COLORS.white}, 0.3)`;
          }
          ctx.arc(cx, cy, DOT_RADIUS.loader, 0, Math.PI * 2);
        } else {
          ctx.fillStyle = `rgba(${COLORS.base}, ${maskAlpha * 0.4})`;
          ctx.arc(cx, cy, DOT_RADIUS.base, 0, Math.PI * 2);
        }
        ctx.fill();

        if (isActive) {
          ctx.shadowBlur = 0;
          ctx.shadowColor = "transparent";
        }
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

  const drawAudioFrame = useCallback((audioData: Uint8Array) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const { cols, rows, spacing, offsetX, offsetY } = gridRef.current;
    const centerCol = Math.floor(cols / 2);

    if (audioData.length > 0) {
      let framePeak = 0;
      for (let i = 0; i < audioData.length; i += 4) {
        if (audioData[i] > framePeak) framePeak = audioData[i];
      }

      const SIGNAL_FLOOR = 15;
      const TARGET_PEAK = 200;
      const MIN_REFERENCE = 40;

      audioFrameCountRef.current++;

      if (framePeak > SIGNAL_FLOOR) {
        // Adaptive rate: fast in first ~30 frames (~0.5s), then stabilize
        const frameCount = audioFrameCountRef.current;
        const adaptUp = frameCount < 30 ? 0.3 : 0.1;
        const adaptDown = frameCount < 30 ? 0.05 : 0.005;

        if (framePeak > audioReferenceLevelRef.current) {
          audioReferenceLevelRef.current += (framePeak - audioReferenceLevelRef.current) * adaptUp;
        } else {
          audioReferenceLevelRef.current += (framePeak - audioReferenceLevelRef.current) * adaptDown;
        }
      }

      const effectiveRef = Math.max(audioReferenceLevelRef.current, MIN_REFERENCE);
      const normalizationFactor = TARGET_PEAK / effectiveRef;

      for (let i = 0; i <= centerCol; i++) {
        const distFromCenter = i / centerCol;
        const freqIndex = Math.floor(audioData.length * 0.4 * (distFromCenter * distFromCenter));
        let sample = audioData[freqIndex] || 0;
        if (audioData[freqIndex + 1]) sample = (sample + audioData[freqIndex + 1]) / 2;

        let val = (sample * normalizationFactor / 255) * sensitivity;
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

        ctx.beginPath();
        if (isWaveActive) {
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
  }, [decay, getMaskOpacity, sensitivity]);

  const drawBaseDots = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const { cols, rows, spacing, offsetX, offsetY } = gridRef.current;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const cx = offsetX + c * spacing + spacing / 2;
        const cy = offsetY + r * spacing + spacing / 2;
        const maskAlpha = getMaskOpacity(cx, cy, width, height);
        if (maskAlpha <= 0.05) continue;

        ctx.beginPath();
        ctx.fillStyle = `rgba(${COLORS.base}, ${maskAlpha})`;
        ctx.arc(cx, cy, DOT_RADIUS.base, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [getMaskOpacity]);

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

  const stopAllAnimations = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const runAnimation = useCallback((type: "processing" | "listening" | "error") => {
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
            drawAudioFrame(dataArray);
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
      drawAudioFrame(new Uint8Array(0));
      animationRef.current = requestAnimationFrame(fadeOutWave);
    } else {
      heightsRef.current.fill(0);
      drawBaseDots();
    }
  }, [drawAudioFrame, drawBaseDots]);

  // --- Core Reactive Logic ---

  const startMic = useCallback(async () => {
    const generation = ++micGenerationRef.current;

    // Reset gain calibration and wave heights for fresh start
    audioReferenceLevelRef.current = 0;
    audioFrameCountRef.current = 0;
    heightsRef.current.fill(0);

    try {
      if (!audioContextRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        audioContextRef.current = new AudioContextClass();
      }

      if (audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      });

      if (generation !== micGenerationRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      streamRef.current = stream;

      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;

      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyser);
      sourceRef.current = source;

      runAnimation("listening");
    } catch (err) {
      console.error("Mic access failed:", err);
      // Backend handles error state, we just log
    }
  }, [runAnimation]);

  const stopMic = useCallback(() => {
    micGenerationRef.current++;
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    analyserRef.current = null;
    // We keep AudioContext alive for reuse
  }, []);

  const hideWindow = useCallback(async () => {
    try {
        invoke("cancel_recording"); // Tell backend to stop recording too
        const window = getCurrentWindow();
        await window.hide();
    } catch (err) {
        console.error("Failed to hide window:", err);
    }
  }, []);

  const dismissOverlay = useCallback(() => {
    setStatus("idle");
    setIsErrorFlashing(false);
    hideWindow();
  }, [hideWindow]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && status === "error") {
        e.preventDefault();
        dismissOverlay();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [status, dismissOverlay]);

  // Main Event Listener - Persistent, never recreated
  useEffect(() => {
    const unlistenPromise = listen<PillStatePayload>("pill:state", (e) => {
      const prev = statusRef.current;
      const next = e.payload.status;

      // Logic: Backend says X, we do Y
      if (next === "listening" && prev !== "listening") {
        startMic();
      } else if (next !== "listening" && prev === "listening") {
        stopMic();
      } else if (next === "listening" && prev === "listening") {
        // Ensure animation is running if we're already listening
        // (e.g. if overlay was hidden but state was somehow preserved?)
        // Usually not needed, but safe
      }

      statusRef.current = next;
      setStatus(next);

      // Visuals
      if (next === "processing") {
        runAnimation("processing");
      } else if (next === "error") {
        setIsErrorFlashing(true);
        runAnimation("error");
        setTimeout(() => setIsErrorFlashing(false), 1200);
      } else if (next === "idle") {
        stopAllAnimations();
        drawBaseDots();
      }
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
      stopMic();
      stopAllAnimations();
    };
  }, [startMic, stopMic, runAnimation, stopAllAnimations, drawBaseDots]);

  useEffect(() => {
    if (status === "error" && !isErrorFlashing) {
      stopAllAnimations();
      drawStaticIcon(ICONS.warning, COLORS.red, COLORS.red);
    }
  }, [status, isErrorFlashing, drawStaticIcon, stopAllAnimations]);

  // Initial canvas setup
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
    
    // Initial draw
    if (statusRef.current === "idle") {
        drawBaseDots();
    }
  }, [drawBaseDots]);

  useEffect(() => {
    const observer = new ResizeObserver(setupCanvas);
    if (containerRef.current) observer.observe(containerRef.current);
    setupCanvas();
    return () => observer.disconnect();
  }, [setupCanvas]);

  return (
    <div
      className={`relative w-full h-full flex flex-col justify-end select-none ${className}`}
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="relative flex flex-col items-center pb-2">
        <div
          ref={containerRef}
          className={`relative rounded-full bg-[#050505] overflow-hidden ${isErrorFlashing ? "animate-shake" : ""}`}
          style={{
            width: PILL_WIDTH,
            height: PILL_HEIGHT,
            boxShadow: "0 8px 20px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.15), inset 0 -2px 5px rgba(0,0,0,0.8)",
          }}
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full block"
          />
        </div>
      </div>
    </div>
  );
};

export default PillOverlay;
