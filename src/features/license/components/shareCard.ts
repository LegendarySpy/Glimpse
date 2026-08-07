import {
  activityLevel,
  type ActivityCell,
} from "../../transcriptions/dictationActivity";

export const CARD = 1080;

export type ShareCardLabels = {
  date: string;
  speakAt: string;
  wordsAMinute: string;
  fasterValue: string;
  thanTyping: string;
  fasterInline: string;
  daysHeadline: string;
  ofDictating: string;
  words: string;
  dictations: string;
  saved: string;
};

export type ShareCardData = {
  labels: ShareCardLabels;
  rtl: boolean;
  words: string;
  wpm: number;
  fasterPercent: number;
  timeSaved: string;
  dictations: string;
  daysDictated: number;
  grid: ActivityCell[][];
  busiest: number;
};

export type ShareStyle = {
  id: string;
  label: string;
  draw: (ctx: CanvasRenderingContext2D, data: ShareCardData) => void;
};

// Pulled from tryglimpse.cc: warm paper, near black Satoshi, one purple.
const PAPER = "#f1efec";
const INK = "#111111";
const DIM = "#6b6862";
const PURPLE = "#7c3aed";
const AMBER = "#b45309";
const LOCAL = "#a5b3fe";
const CLOUD = "#fbbf24";

const roundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

// The 2x2 mark from the sidebar: cloud on one diagonal, local on the other.
const dotMark = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dot: number,
  gap: number,
) => {
  const cells: Array<[number, number, string]> = [
    [0, 0, CLOUD],
    [1, 0, LOCAL],
    [0, 1, LOCAL],
    [1, 1, CLOUD],
  ];
  cells.forEach(([col, row, color]) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(
      x + col * (dot + gap) + dot / 2,
      y + row * (dot + gap) + dot / 2,
      dot / 2,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  });
};

const footer = (ctx: CanvasRenderingContext2D, ink: string, dim: string) => {
  const baseline = CARD - 70;
  dotMark(ctx, 76, baseline - 27, 13, 6);

  ctx.fillStyle = ink;
  ctx.font = "700 30px Satoshi, Inter, system-ui, sans-serif";
  ctx.fillText("Glimpse", 76 + 32 + 22, baseline);

  ctx.fillStyle = dim;
  ctx.font = "400 23px Inter, system-ui, sans-serif";
  const label = "tryglimpse.cc";
  ctx.fillText(label, CARD - 76 - ctx.measureText(label).width, baseline);
};

const FIGURES_Y = CARD - 192;

// Translations run far longer than English, so display lines shrink to fit
// rather than colliding with whatever sits beside them.
const fitFont = (
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  size: number,
  maxWidth: number,
  min = 26,
) => {
  let current = size;
  const set = () => {
    ctx.font = `${weight} ${current}px Satoshi, Inter, system-ui, sans-serif`;
  };
  set();
  while (ctx.measureText(text).width > maxWidth && current > min) {
    current -= 2;
    set();
  }
  return current;
};

const dateline = (
  ctx: CanvasRenderingContext2D,
  text: string,
  color: string,
) => {
  ctx.fillStyle = color;
  ctx.font = "500 28px Satoshi, Inter, system-ui, sans-serif";
  ctx.fillText(text, 46, 64);
};

const figureRow = (
  ctx: CanvasRenderingContext2D,
  data: ShareCardData,
  ink: string,
  dim: string,
) => {
  const entries: Array<[string, string]> = [
    [data.words, data.labels.words],
    [data.dictations, data.labels.dictations],
    [data.timeSaved, data.labels.saved],
  ];
  const y = FIGURES_Y;
  const left = 76;
  const usable = CARD - left * 2;
  const columnW = usable / entries.length;
  entries.forEach(([value, label], index) => {
    const x = left + index * columnW;
    if (index > 0) {
      ctx.strokeStyle = dim;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.moveTo(x - 26, y - 52);
      ctx.lineTo(x - 26, y + 12);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = ink;
    ctx.font = "700 66px Satoshi, Inter, system-ui, sans-serif";
    ctx.fillText(value, x, y);
    ctx.fillStyle = dim;
    fitFont(ctx, label, 500, 26, columnW - 34, 15);
    ctx.fillText(label, x, y + 38);
  });
};

// Deterministic wobble so a redraw never reshuffles the marks.
const wobble = (seed: number) => {
  let state = seed * 9301 + 49297;
  return (amount: number) => {
    state = (state * 9301 + 49297) % 233280;
    return ((state / 233280) * 2 - 1) * amount;
  };
};

const sketchStroke = (
  ctx: CanvasRenderingContext2D,
  points: Array<[number, number]>,
  color: string,
  width: number,
  seed: number,
  passes = 2,
  amount = 2.2,
) => {
  const jitter = wobble(seed);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let pass = 0; pass < passes; pass += 1) {
    ctx.globalAlpha = pass === 0 ? 1 : 0.4;
    ctx.beginPath();
    points.forEach(([x, y], index) => {
      const px = x + jitter(amount);
      const py = y + jitter(amount);
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
};

// The underline the site puts beneath a phrase, thickening toward the middle.
const sketchUnderline = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  color: string,
  seed: number,
) => {
  // y is the text baseline; callers pass the measured descent in already.
  const jitter = wobble(seed);
  ctx.fillStyle = color;
  ctx.beginPath();
  const steps = 26;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const px = x + width * t;
    const py = y + Math.sin(t * Math.PI) * -3 + jitter(1.2);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  for (let i = steps; i >= 0; i -= 1) {
    const t = i / steps;
    const px = x + width * t;
    const thickness = 8 + Math.sin(t * Math.PI) * 7;
    const py = y + Math.sin(t * Math.PI) * -3 + thickness + jitter(1.2);
    ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
};

const sketchArrow = (
  ctx: CanvasRenderingContext2D,
  from: [number, number],
  to: [number, number],
  bend: number,
  color: string,
  seed: number,
) => {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const points: Array<[number, number]> = [];
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const cx = mx + (-dy / len) * bend;
  const cy = my + (dx / len) * bend;
  for (let t = 0; t <= 1.0001; t += 0.035) {
    const mt = 1 - t;
    points.push([
      mt * mt * x1 + 2 * mt * t * cx + t * t * x2,
      mt * mt * y1 + 2 * mt * t * cy + t * t * y2,
    ]);
  }
  sketchStroke(ctx, points, color, 5, seed, 2, 0.8);

  const tail = points[points.length - 3];
  const angle = Math.atan2(y2 - tail[1], x2 - tail[0]);
  const head = 30;
  sketchStroke(
    ctx,
    [
      [x2 - head * Math.cos(angle - 0.38), y2 - head * Math.sin(angle - 0.38)],
      [x2, y2],
    ],
    color,
    5,
    seed + 3,
    1,
    0.8,
  );
  sketchStroke(
    ctx,
    [
      [x2 - head * Math.cos(angle + 0.38), y2 - head * Math.sin(angle + 0.38)],
      [x2, y2],
    ],
    color,
    5,
    seed + 7,
    1,
    0.8,
  );
};

const drawNoteStyle: ShareStyle["draw"] = (ctx, data) => {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, CARD, CARD);

  const left = 84;
  dateline(ctx, data.labels.date, DIM);

  ctx.fillStyle = DIM;
  fitFont(ctx, data.labels.speakAt, 500, 66, CARD - 400 - left);
  ctx.fillText(data.labels.speakAt, left, 286);

  ctx.fillStyle = INK;
  ctx.font = "700 292px Satoshi, Inter, system-ui, sans-serif";
  const wpmText = `${data.wpm}`;
  ctx.fillText(wpmText, left - 6, 552);
  const wpmMetrics = ctx.measureText(wpmText);
  const wpmWidth = wpmMetrics.width;

  sketchUnderline(
    ctx,
    left - 6,
    552 + (wpmMetrics.actualBoundingBoxDescent || 0) + 9,
    wpmWidth,
    PURPLE,
    11,
  );

  ctx.fillStyle = INK;
  fitFont(ctx, data.labels.wordsAMinute, 700, 66, CARD - left * 2);
  ctx.fillText(data.labels.wordsAMinute, left - 2, 680);

  if (data.fasterPercent > 0) {
    ctx.fillStyle = PURPLE;
    fitFont(ctx, data.labels.fasterValue, 700, 46, 296, 24);
    ctx.fillText(data.labels.fasterValue, CARD - 372, 274);
    ctx.fillStyle = DIM;
    fitFont(ctx, data.labels.thanTyping, 500, 34, 296, 20);
    ctx.fillText(data.labels.thanTyping, CARD - 372, 320);

    sketchArrow(
      ctx,
      [CARD - 340, 360],
      [left + wpmWidth + 26, 470],
      -54,
      PURPLE,
      5,
    );
  }

  figureRow(ctx, data, INK, DIM);
  footer(ctx, INK, DIM);
};

const drawYearStyle: ShareStyle["draw"] = (ctx, data) => {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, CARD, CARD);

  const left = 84;
  dateline(ctx, data.labels.date, DIM);

  ctx.fillStyle = INK;
  ctx.font = "700 132px Satoshi, Inter, system-ui, sans-serif";
  const daysText = data.labels.daysHeadline;
  ctx.fillText(daysText, left - 6, 242);
  const daysMetrics = ctx.measureText(daysText);
  const daysWidth = daysMetrics.width;
  sketchUnderline(
    ctx,
    left - 6,
    242 + (daysMetrics.actualBoundingBoxDescent || 0) - 1,
    daysWidth,
    PURPLE,
    17,
  );

  ctx.fillStyle = DIM;
  fitFont(ctx, data.labels.ofDictating, 500, 54, CARD - left * 2);
  ctx.fillText(data.labels.ofDictating, left - 2, 344);

  // 52 weeks splits evenly into two blocks; 53 leaves a ragged edge.
  const weeks = data.grid.slice(data.grid.length - 52);
  const half = 26;
  const gridW = 700;
  const step = gridW / half;
  const cell = step - step * 0.2;
  const blockH = step * 7;
  const gapY = 30;
  const top = 378;

  weeks.forEach((column, columnIndex) => {
    const block = columnIndex < half ? 0 : 1;
    const col = columnIndex - block * half;
    column.forEach((entry, rowIndex) => {
      if (entry.future) return;
      const active = entry.count > 0;
      ctx.globalAlpha = active
        ? 0.22 + 0.78 * (activityLevel(entry.words, data.busiest) / 4)
        : 1;
      ctx.fillStyle = active ? PURPLE : "#e2dfd8";
      roundRect(
        ctx,
        left + col * step,
        top + block * (blockH + gapY) + rowIndex * step,
        cell,
        cell,
        cell * 0.26,
      );
      ctx.fill();
    });
  });
  ctx.globalAlpha = 1;

  figureRow(ctx, data, INK, DIM);
  footer(ctx, INK, DIM);
};

const drawPosterStyle: ShareStyle["draw"] = (ctx, data) => {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, CARD, CARD);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, CARD, CARD);
  ctx.clip();
  ctx.translate(CARD * 0.5, 112);
  ctx.rotate((30 * Math.PI) / 180);
  const bands: Array<[number, number, string]> = [
    [-268, 152, PURPLE],
    [-98, 20, INK],
    [-64, 68, AMBER],
    [18, 9, INK],
  ];
  bands.forEach(([offset, height, color]) => {
    ctx.fillStyle = color;
    ctx.fillRect(-CARD * 1.4, offset, CARD * 2.8, height);
  });
  ctx.restore();

  const left = 84;
  dateline(ctx, data.labels.date, DIM);

  ctx.fillStyle = INK;
  ctx.font = "700 300px Satoshi, Inter, system-ui, sans-serif";
  ctx.fillText(`${data.wpm}`, left - 8, 638);

  ctx.fillStyle = INK;
  fitFont(ctx, data.labels.wordsAMinute, 700, 62, CARD - left * 2);
  ctx.fillText(data.labels.wordsAMinute, left - 2, 716);

  if (data.fasterPercent > 0) {
    ctx.fillStyle = AMBER;
    fitFont(ctx, data.labels.fasterInline, 500, 38, CARD - left * 2, 22);
    ctx.fillText(data.labels.fasterInline, left - 2, 772);
  }

  figureRow(ctx, data, INK, DIM);
  footer(ctx, INK, DIM);
};

export const SHARE_STYLES: ShareStyle[] = [
  { id: "note", label: "Note", draw: drawNoteStyle },
  { id: "year", label: "Year", draw: drawYearStyle },
  { id: "poster", label: "Poster", draw: drawPosterStyle },
];

let fontsReady: Promise<unknown> | null = null;
const whenFontsReady = () => {
  if (!fontsReady) fontsReady = document.fonts?.ready ?? Promise.resolve();
  return fontsReady;
};

export function drawShareCard(
  canvas: HTMLCanvasElement,
  style: ShareStyle,
  data: ShareCardData,
  scale = 2,
) {
  if (canvas.width !== CARD * scale) {
    canvas.width = CARD * scale;
    canvas.height = CARD * scale;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, CARD, CARD);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  // Gives bidi a right-to-left base so signs and numerals land correctly.
  ctx.direction = data.rtl ? "rtl" : "ltr";
  style.draw(ctx, data);
  ctx.restore();
}

export async function preloadShareFonts() {
  await whenFontsReady();
}

export function canvasToPngBytes(
  canvas: HTMLCanvasElement,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not render the image"));
        return;
      }
      blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)))
        .catch(reject);
    }, "image/png");
  });
}
