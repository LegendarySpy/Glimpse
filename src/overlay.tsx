import React, { useRef, useEffect, useState } from 'react';

// --- Types & Interfaces ---

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

export interface MatrixPillProps {
  /** Optional class name for the outer wrapper */
  className?: string;
  /** Optional inline styles for the outer wrapper */
  style?: React.CSSProperties;
  /** Audio sensitivity (default: 6.5) */
  sensitivity?: number;
  /** Rate at which the bars fall (0.0 - 1.0, default: 0.85) */
  decay?: number;
  /** Color of the idle dots (default: rgba(40, 40, 40, alpha)) */
  baseColor?: string;
  /** Color of the active waveform (default: rgba(255, 255, 255, alpha)) */
  activeColor?: string;
}

interface GridInfo {
  spacing: number;
  cols: number;
  rows: number;
  offsetX: number;
  offsetY: number;
}

// --- Constants & Assets ---

// Bitmaps for Icons (1 = dot on, 0 = dot off)
const MIC_ICON = [
  [0, 1, 1, 1, 0],
  [0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0],
  [0, 1, 1, 1, 0],
  [0, 0, 1, 0, 0],
  [1, 1, 1, 1, 1],
  [1, 0, 0, 0, 1],
  [0, 1, 1, 1, 0]
];

const STOP_ICON = [
  [1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1]
];

const NOISE_SVG = `data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E`;

// --- Component ---

const MatrixPill: React.FC<MatrixPillProps> = ({
  className = "",
  style = {},
  sensitivity = 6.5,
  decay = 0.85,
  baseColor = "40, 40, 40", // passed as RGB string for alpha manipulation
  activeColor = "255, 255, 255"
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Audio State
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Sync Ref for Animation Loop
  const isListeningRef = useRef<boolean>(false);
  const [, setIsListening] = useState<boolean>(false); // Trigger re-renders only

  // Layout State
  const gridInfoRef = useRef<GridInfo>({ spacing: 8, cols: 0, rows: 0, offsetX: 0, offsetY: 0 });
  const currentHeights = useRef<number[]>([]);

  // --- Initialization & Cleanup ---

  useEffect(() => {
    // Resize Observer handles dynamic container resizing better than window.resize
    const observer = new ResizeObserver(() => {
      handleResize();
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      observer.disconnect();
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, []);

  // --- Handlers ---

  const handleResize = () => {
    if (!canvasRef.current || !containerRef.current) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();

    // Set resolution
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    // Normalize coordinate system
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(dpr, dpr);

    // Set Display size
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    // Grid Calculations
    const spacing = 8; // Fixed spacing for the matrix look
    const cols = Math.floor(rect.width / spacing);
    const rows = Math.floor(rect.height / spacing);
    const offsetX = (rect.width - (cols * spacing)) / 2;
    const offsetY = (rect.height - (rows * spacing)) / 2;

    gridInfoRef.current = { spacing, cols, rows, offsetX, offsetY };

    if (currentHeights.current.length !== cols) {
      currentHeights.current = new Array(cols).fill(0);
    }

    // Force a redraw if idle to ensure icons appear
    if (!isListeningRef.current) {
      drawFrame(new Uint8Array(0));
    }
  };

  const toggleListening = async () => {
    if (isListeningRef.current) {
      stopListening();
    } else {
      await startListening();
    }
  };

  const startListening = async () => {
    try {
      if (!audioContextRef.current) {
        const AudioContextClass = window.AudioContext || (window as unknown as WindowWithWebkitAudio).webkitAudioContext;
        if (AudioContextClass) {
          audioContextRef.current = new AudioContextClass();
        }
      }

      if (audioContextRef.current?.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      if (!audioContextRef.current) throw new Error("Audio Context not supported");

      // Disable voice processing to prevent macOS Mic Mode menu bar button
      // These settings are for standard audio recording, not VoIP
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      });

      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 1024;
      analyserRef.current.smoothingTimeConstant = 0.8;

      sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
      sourceRef.current.connect(analyserRef.current);

      isListeningRef.current = true;
      setIsListening(true);
      setError(null);

      animate();
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setError("Mic Access Denied");
      isListeningRef.current = false;
      setIsListening(false);
    }
  };

  const stopListening = () => {
    sourceRef.current?.disconnect();
    isListeningRef.current = false;
    setIsListening(false);

    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);

    // Cleanup animation (fade to black)
    const fadeOut = () => {
      let active = false;
      const heights = currentHeights.current;

      for (let i = 0; i < heights.length; i++) {
        heights[i] *= 0.80;
        if (heights[i] > 0.01) active = true;
      }

      drawFrame(new Uint8Array(0), true);

      if (active) {
        requestAnimationFrame(fadeOut);
      } else {
        currentHeights.current.fill(0);
        drawFrame(new Uint8Array(0));
      }
    }
    fadeOut();
  };

  const animate = () => {
    if (!analyserRef.current || !isListeningRef.current) return;

    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyserRef.current.getByteFrequencyData(dataArray);

    drawFrame(dataArray);
    animationFrameRef.current = requestAnimationFrame(animate);
  };

  // --- Rendering Helpers ---

  const getMaskOpacity = (x: number, y: number, width: number, height: number, radius: number): number => {
    const leftCenter = radius;
    const rightCenter = width - radius;
    let distToEdge = 0;

    if (x < leftCenter) {
      // Left Cap
      const dist = Math.sqrt(Math.pow(x - leftCenter, 2) + Math.pow(y - height / 2, 2));
      distToEdge = radius - dist;
    } else if (x > rightCenter) {
      // Right Cap
      const dist = Math.sqrt(Math.pow(x - rightCenter, 2) + Math.pow(y - height / 2, 2));
      distToEdge = radius - dist;
    } else {
      // Body
      distToEdge = Math.min(y, height - y);
    }

    const fadeRange = 15; // px
    return Math.max(0, Math.min(1, distToEdge / fadeRange));
  };

  const getIconPixel = (c: number, r: number, iconGrid: number[][], centerCol: number, centerRow: number): boolean => {
    const iconH = iconGrid.length;
    const iconW = iconGrid[0].length;

    const startC = centerCol - Math.floor(iconW / 2);
    const startR = centerRow - Math.floor(iconH / 2);

    const localC = c - startC;
    const localR = r - startR;

    return (localC >= 0 && localC < iconW && localR >= 0 && localR < iconH)
      ? iconGrid[localR][localC] === 1
      : false;
  };

  // --- Main Draw Loop ---

  const drawFrame = (audioData: Uint8Array, usingCachedHeights = false) => {
    if (!canvasRef.current || !containerRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Canvas dimensions (logical)
    const width = canvas.width / (window.devicePixelRatio || 1);
    const height = canvas.height / (window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, width, height);

    const { cols, rows, spacing, offsetX, offsetY } = gridInfoRef.current;
    const pillRadius = height / 2;
    const centerCol = Math.floor(cols / 2);
    const centerRow = Math.floor(rows / 2);

    // 1. Calculate Heights
    if (!usingCachedHeights && audioData.length > 0) {
      for (let i = 0; i <= centerCol; i++) {
        const distFromCenter = i / centerCol;
        // Map freq index: heavily weight low freqs to center
        const freqIndex = Math.floor(audioData.length * 0.4 * (distFromCenter * distFromCenter));

        let sample = audioData[freqIndex] || 0;
        if (audioData[freqIndex + 1]) sample = (sample + audioData[freqIndex + 1]) / 2;

        let val = (sample / 255) * sensitivity;
        if (distFromCenter < 0.2) val *= 1.25; // Bass boost
        val = Math.min(val, 1.0);

        // Left Side
        const leftIdx = centerCol - i;
        if (leftIdx >= 0 && leftIdx < cols) {
          if (val > currentHeights.current[leftIdx]) {
            currentHeights.current[leftIdx] += (val - currentHeights.current[leftIdx]) * 0.5;
          } else {
            currentHeights.current[leftIdx] += (val - currentHeights.current[leftIdx]) * (1 - decay);
          }
        }

        // Mirror to Right
        const rightIdx = centerCol + i;
        if (rightIdx < cols && rightIdx !== leftIdx) {
          currentHeights.current[rightIdx] = currentHeights.current[leftIdx];
        }
      }
    }

    // 2. Render Grid
    for (let c = 0; c < cols; c++) {
      const amp = currentHeights.current[c] || 0;
      const activeRadiusPixels = amp * (height * 0.45);

      for (let r = 0; r < rows; r++) {
        const cx = offsetX + c * spacing + spacing / 2;
        const cy = offsetY + r * spacing + spacing / 2;

        const maskAlpha = getMaskOpacity(cx, cy, width, height, pillRadius);
        if (maskAlpha <= 0.05) continue;

        const distFromCenterY = Math.abs(cy - height / 2);
        // Only trigger wave visual if amplitude is significant to avoid "ghost line"
        const isWaveActive = activeRadiusPixels > 0.5 && distFromCenterY < activeRadiusPixels;

        // Icon Determination
        let isIconDot = false;
        if (isListeningRef.current) {
          isIconDot = getIconPixel(c, r, STOP_ICON, centerCol, centerRow);
        } else {
          isIconDot = getIconPixel(c, r, MIC_ICON, centerCol, centerRow);
        }

        // Style Determination
        ctx.beginPath();
        let radius = 2; // base size
        let fillStyle = `rgba(${baseColor}, ${maskAlpha})`;
        let shadowBlur = 0;
        let shadowColor = "transparent";

        if (isIconDot) {
          radius = 2.6;
          shadowBlur = 8;
          if (isListeningRef.current) {
            fillStyle = `rgba(255, 50, 50, ${maskAlpha})`; // Red Stop
            shadowColor = "rgba(255, 50, 50, 0.5)";
          } else {
            fillStyle = `rgba(${activeColor}, ${maskAlpha})`; // White Mic
            shadowColor = `rgba(${activeColor}, 0.5)`;
          }

        } else if (isWaveActive) {
          radius = 2.4;
          const waveEdgeDist = 1 - (distFromCenterY / (activeRadiusPixels + 0.1));
          const brightness = 0.5 + (waveEdgeDist * 0.5);
          fillStyle = `rgba(${activeColor}, ${brightness * maskAlpha})`;

          if (brightness > 0.8) {
            shadowBlur = 4;
            shadowColor = `rgba(${activeColor}, 0.4)`;
          }
        }

        ctx.fillStyle = fillStyle;
        ctx.shadowBlur = shadowBlur;
        ctx.shadowColor = shadowColor;
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  return (
    <div
      className={`relative group cursor-pointer ${className}`}
      style={{
        width: '100%',
        height: '160px',
        minWidth: '200px', // Prevent collapse
        ...style
      }}
      onClick={toggleListening}
    >
      {/* Glow Effect Wrapper */}
      <div className={`absolute -inset-1 bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-blue-500/10 rounded-full blur-2xl transition-opacity duration-1000 pointer-events-none ${isListeningRef.current ? 'opacity-100' : 'opacity-20'}`} />

      {/* Physical Pill Container */}
      <div
        ref={containerRef}
        className="relative w-full h-full rounded-full bg-[#0a0a0a] z-10 overflow-hidden"
        style={{
          boxShadow: `
              0 25px 50px -12px rgba(0,0,0,1),
              inset 0 1px 1px rgba(255,255,255,0.15),
              inset 0 -2px 5px rgba(0,0,0,0.8)
            `
        }}
      >
        {/* Texture */}
        <div className="absolute inset-0 opacity-[0.07] pointer-events-none mix-blend-overlay z-20"
          style={{ backgroundImage: `url("${NOISE_SVG}")` }} />

        {/* Gloss Reflection */}
        <div className="absolute top-0 left-10 right-10 h-[40%] bg-gradient-to-b from-white/[0.04] to-transparent rounded-[100%] blur-[1px] z-20 pointer-events-none" />

        {/* Canvas Layer */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full z-10 block"
        />

        {/* Error Message Overlay */}
        {error && (
          <div className="absolute bottom-4 left-0 right-0 flex justify-center z-30 pointer-events-none">
            <div className="px-4 py-1 rounded-full bg-red-500/10 border border-red-500/20 backdrop-blur-sm">
              <span className="text-[10px] font-mono text-red-400 tracking-widest">
                {error}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MatrixPill;