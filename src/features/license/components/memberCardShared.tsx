import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import {
  mulberry32,
  seedFromLicenseKey,
  seededDotField,
} from "../licenseFingerprint";
import type { PurchaseTier } from "../../license/purchaseConfig";
import { EDITION_COLORS } from "../../../shared/lib/licenseEdition";

export type MemberCardPalette = {
  bg: string;
  textPrimary: string;
  textDisabled: string;
  border: string;
  dotColor: string;
  stripeBg: string;
  shellShadow: string;
  noiseOpacity: number;
  securityDotOpacity: number;
  vignette: string;
  wordmarkShadow: string;
};

export const MEMBER_CARD_LIGHT_PALETTE: MemberCardPalette = {
  bg: "#F3F1ED",
  textPrimary: "#1a1716",
  textDisabled: "#938e86",
  border: "#d5d1ca",
  dotColor: "#bdb6ac",
  stripeBg: "#EDECE6",
  shellShadow:
    "2px 4px 0 -1px rgba(58, 52, 46, 0.06), 4px 9px 18px -4px rgba(58, 52, 46, 0.22), 1px 2px 4px -1px rgba(58, 52, 46, 0.12)",
  noiseOpacity: 0.045,
  securityDotOpacity: 0.14,
  vignette:
    "inset 0 0 48px rgba(58, 52, 46, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.45), inset 1px 0 0 rgba(255, 255, 255, 0.18)",
  wordmarkShadow: "0 1px 0 rgba(255, 255, 255, 0.55)",
};

export const MEMBER_CARD_DARK_PALETTE: MemberCardPalette = {
  bg: "#1a1917",
  textPrimary: "#ece9e4",
  textDisabled: "#7a7670",
  border: "#2f2d28",
  dotColor: "#4a4742",
  stripeBg: "#141311",
  shellShadow:
    "2px 4px 0 -1px rgba(0, 0, 0, 0.18), 4px 9px 18px -4px rgba(0, 0, 0, 0.42), 1px 2px 4px -1px rgba(0, 0, 0, 0.24)",
  noiseOpacity: 0.05,
  securityDotOpacity: 0.1,
  vignette:
    "inset 0 0 48px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.06), inset 1px 0 0 rgba(255, 255, 255, 0.03)",
  wordmarkShadow:
    "0 1px 0 rgba(255, 255, 255, 0.08), 0 -1px 0 rgba(0, 0, 0, 0.28)",
};

function readAppTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function paletteForAppTheme(appTheme: "light" | "dark"): MemberCardPalette {
  return appTheme === "light"
    ? MEMBER_CARD_LIGHT_PALETTE
    : MEMBER_CARD_DARK_PALETTE;
}

const MemberCardPaletteContext = createContext(MEMBER_CARD_LIGHT_PALETTE);

export function useMemberCardPalette() {
  return useContext(MemberCardPaletteContext);
}

export function MemberCardPaletteProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [palette, setPalette] = useState(() =>
    paletteForAppTheme(readAppTheme()),
  );

  useEffect(() => {
    const sync = () => setPalette(paletteForAppTheme(readAppTheme()));
    let disposed = false;
    let unlistenTheme: (() => void) | null = null;

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    mediaQuery.addEventListener("change", sync);

    void listen("ui:theme_changed", sync)
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenTheme = unlisten;
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      observer.disconnect();
      mediaQuery.removeEventListener("change", sync);
      unlistenTheme?.();
      unlistenTheme = null;
    };
  }, []);

  return (
    <MemberCardPaletteContext.Provider value={palette}>
      {children}
    </MemberCardPaletteContext.Provider>
  );
}

export const CARD_WIDTH = 400;
export const CARD_STAMP_SLOT_WIDTH = 132;
export const CARD_STAMP_SLOT_HEIGHT = 38;
export const CARD_HEADER_HEIGHT = CARD_STAMP_SLOT_HEIGHT;
export const CARD_HEADLINE_HEIGHT = 58;
export const CARD_HEADLINE_HEIGHT_EXPANDED = 102;
export const CARD_HEADLINE_OVERLAP = 12;
export const CARD_DETAILS_HEIGHT = 88;
export const CARD_DETAILS_HEIGHT_SLIM = 44;
export const CARD_HEADLINE_GAP = 4;
export const CARD_STRIPE_DENSITY = 0.26;
export const CARD_STRIPE_GAP = 10;
export const CARD_RADIUS = 8;
export const CARD_PADDING = 20;
export const CARD_INNER_WIDTH = CARD_WIDTH - CARD_PADDING * 2;
export const DOT_SWAP_SWEEP_MS = 560;
export const DOT_SWAP_BLINK_MS = 90;
export const DOT_SWAP_TOTAL_MS = DOT_SWAP_SWEEP_MS + DOT_SWAP_BLINK_MS + 48;
export const STRIPE_DIVIDER_OFFSET = -6;
export const CARD_TITLE_FONT =
  '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';

export function getCardContentHeight(): number {
  return (
    CARD_HEADER_HEIGHT +
    CARD_HEADLINE_HEIGHT +
    8 +
    CARD_DETAILS_HEIGHT +
    CARD_STRIPE_GAP +
    STRIPE_HEIGHT -
    CARD_HEADLINE_OVERLAP
  );
}

export function getMemberCardHeight(extraHeight = 0): number {
  return CARD_PADDING + getCardContentHeight() + extraHeight;
}

export const STRIPE_DOT_SIZE = 3;
export const STRIPE_DOT_GAP = 3;
export const STRIPE_DOT_PITCH = STRIPE_DOT_SIZE + STRIPE_DOT_GAP;
export const STRIPE_VERTICAL_INSET = 4;
export const STRIPE_ROWS = 7;
export const STRIPE_CORNER_RADIUS = CARD_RADIUS - 1;
export const STRIPE_COLS = Math.floor(
  (CARD_WIDTH + STRIPE_DOT_GAP) / STRIPE_DOT_PITCH,
);
export const STRIPE_FIELD_HEIGHT =
  STRIPE_ROWS * STRIPE_DOT_SIZE + (STRIPE_ROWS - 1) * STRIPE_DOT_GAP;
export const STRIPE_HEIGHT = STRIPE_FIELD_HEIGHT + STRIPE_VERTICAL_INSET * 2;

export const SECURITY_DOT_SIZE = 2;
export const SECURITY_DOT_PITCH = 9;
export const SECURITY_COLS = Math.floor(CARD_WIDTH / SECURITY_DOT_PITCH);

export function getCardShellStyle(palette: MemberCardPalette, extraHeight = 0) {
  const height = getMemberCardHeight(extraHeight);
  return {
    width: `${CARD_WIDTH}px`,
    height: `${height}px`,
    minHeight: `${height}px`,
    maxHeight: `${height}px`,
    backgroundColor: palette.bg,
    border: "none",
    borderRadius: `${CARD_RADIUS}px`,
    boxShadow: palette.shellShadow,
    transform: "rotate(-0.65deg)",
    transformOrigin: "center center",
  };
}

export const TIER_COLORS: Record<PurchaseTier, { fg: string; bg: string }> = {
  personal: EDITION_COLORS.personal,
  commercial: EDITION_COLORS.commercial,
};

export const MEMBER_CARD_LAYOUT_ID = "glimpse-member-card";

function gridDotCenter(
  row: number,
  col: number,
  offsetX: number,
  offsetY: number,
  pitch = STRIPE_DOT_PITCH,
  dotSize = STRIPE_DOT_SIZE,
): { x: number; y: number } {
  return {
    x: offsetX + col * pitch + dotSize / 2,
    y: offsetY + row * pitch + dotSize / 2,
  };
}

function isInsideRoundedRect(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): boolean {
  if (x < 0 || x > width || y < 0 || y > height) return false;

  const r = radius;
  if (x < r && y > height - r) {
    const dx = r - x;
    const dy = y - (height - r);
    return dx * dx + dy * dy <= r * r;
  }
  if (x > width - r && y > height - r) {
    const dx = x - (width - r);
    const dy = y - (height - r);
    return dx * dx + dy * dy <= r * r;
  }
  return true;
}

function cornerArcDotCenters(
  width: number,
  height: number,
  radius: number,
  pitch = STRIPE_DOT_PITCH,
  dotSize = STRIPE_DOT_SIZE,
): Array<{ x: number; y: number }> {
  const inset = dotSize / 2 + 0.5;
  const arcRadius = radius - inset;
  const corners = [
    { cx: radius, cy: height - radius, start: Math.PI, end: Math.PI / 2 },
    {
      cx: width - radius,
      cy: height - radius,
      start: Math.PI / 2,
      end: 0,
    },
  ];

  const dots: Array<{ x: number; y: number }> = [];
  for (const { cx, cy, start, end } of corners) {
    const arcLength = arcRadius * Math.abs(end - start);
    const steps = Math.max(2, Math.ceil(arcLength / pitch));
    for (let i = 0; i <= steps; i += 1) {
      const angle = start + ((end - start) * i) / steps;
      dots.push({
        x: cx + arcRadius * Math.cos(angle),
        y: cy + arcRadius * Math.sin(angle),
      });
    }
  }
  return dots;
}

function cornerDotActive(key: string, index: number, density = 0.34): boolean {
  const rand = mulberry32(
    (seedFromLicenseKey(key) + Math.imul(index, 0x9e3779b1)) >>> 0,
  );
  return rand() < density;
}

export function buildSecurityDots(
  seedKey: string,
  cardHeight: number,
  density = 0.07,
): Array<{ x: number; y: number; active: boolean }> {
  const rows = Math.floor(cardHeight / SECURITY_DOT_PITCH);
  const active = seededDotField(
    `${seedKey}:security`,
    rows,
    SECURITY_COLS,
    density,
  );
  const dots: Array<{ x: number; y: number; active: boolean }> = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < SECURITY_COLS; col += 1) {
      const { x, y } = gridDotCenter(
        row,
        col,
        SECURITY_DOT_PITCH / 2,
        SECURITY_DOT_PITCH / 2,
        SECURITY_DOT_PITCH,
        SECURITY_DOT_SIZE,
      );
      if (!isInsideRoundedRect(x, y, CARD_WIDTH, cardHeight, CARD_RADIUS)) {
        continue;
      }
      dots.push({
        x,
        y,
        active: active.has(row * SECURITY_COLS + col),
      });
    }
  }

  return dots;
}

export function buildStripeDots(
  seedKey: string,
  density = 0.34,
): Array<{ x: number; y: number; active: boolean }> {
  const active = seededDotField(seedKey, STRIPE_ROWS, STRIPE_COLS, density);
  const offsetX = 0;
  const offsetY = STRIPE_VERTICAL_INSET;
  const seen = new Set<string>();
  const dots: Array<{ x: number; y: number; active: boolean }> = [];

  const pushDot = (x: number, y: number, index: number) => {
    if (
      !isInsideRoundedRect(
        x,
        y,
        CARD_WIDTH,
        STRIPE_HEIGHT,
        STRIPE_CORNER_RADIUS,
      )
    ) {
      return;
    }
    const key = `${Math.round(x * 10)}:${Math.round(y * 10)}`;
    if (seen.has(key)) return;
    seen.add(key);
    dots.push({ x, y, active: active.has(index) });
  };

  for (let row = 0; row < STRIPE_ROWS; row += 1) {
    for (let col = 0; col < STRIPE_COLS; col += 1) {
      const { x, y } = gridDotCenter(row, col, offsetX, offsetY);
      pushDot(x, y, row * STRIPE_COLS + col);
    }
  }

  const cornerStart = STRIPE_ROWS * STRIPE_COLS;
  cornerArcDotCenters(CARD_WIDTH, STRIPE_HEIGHT, STRIPE_CORNER_RADIUS).forEach(
    ({ x, y }, i) => {
      const index = cornerStart + i;
      if (
        !isInsideRoundedRect(
          x,
          y,
          CARD_WIDTH,
          STRIPE_HEIGHT,
          STRIPE_CORNER_RADIUS,
        )
      ) {
        return;
      }
      const dotKey = `${Math.round(x * 10)}:${Math.round(y * 10)}`;
      if (seen.has(dotKey)) return;
      seen.add(dotKey);
      dots.push({
        x,
        y,
        active: cornerDotActive(seedKey, index, density),
      });
    },
  );

  return dots;
}

export type MemberCardDot = { x: number; y: number; active: boolean };

export type StripeDotTransitionMode = "none" | "sweep";

function dotGridKey(dot: MemberCardDot): string {
  return `${Math.round(dot.x * 10)}:${Math.round(dot.y * 10)}`;
}

function useDotSeedTransition(
  seedKey: string,
  totalMs: number,
  enabled: boolean,
) {
  const committedRef = useRef(seedKey);
  const [outgoingKey, setOutgoingKey] = useState<string | null>(null);
  const [incomingKey, setIncomingKey] = useState(seedKey);

  useEffect(() => {
    if (seedKey === committedRef.current) return;

    const previous = committedRef.current;
    committedRef.current = seedKey;

    if (!enabled || totalMs <= 0) {
      setOutgoingKey(null);
      setIncomingKey(seedKey);
      return;
    }

    setOutgoingKey(previous);
    setIncomingKey(seedKey);

    const timer = window.setTimeout(() => {
      setOutgoingKey(null);
    }, totalMs);

    return () => window.clearTimeout(timer);
  }, [enabled, seedKey, totalMs]);

  return {
    outgoingKey,
    incomingKey,
    isTransitioning: outgoingKey !== null,
  };
}

function SweepBlinkDotLayers({
  outgoingDots,
  incomingDots,
  fieldWidth,
  dotRadius,
  color,
  activeOpacity,
  inactiveOpacity,
}: {
  outgoingDots: MemberCardDot[];
  incomingDots: MemberCardDot[];
  fieldWidth: number;
  dotRadius: number;
  color: string;
  activeOpacity: number;
  inactiveOpacity: number;
}) {
  const sweepSec = DOT_SWAP_SWEEP_MS / 1000;
  const blinkSec = DOT_SWAP_BLINK_MS / 1000;
  const incomingMap = useMemo(
    () => new Map(incomingDots.map((dot) => [dotGridKey(dot), dot])),
    [incomingDots],
  );
  const outgoingMap = useMemo(
    () => new Map(outgoingDots.map((dot) => [dotGridKey(dot), dot])),
    [outgoingDots],
  );
  const keys = useMemo(() => {
    const all = new Set<string>();
    for (const dot of incomingDots) all.add(dotGridKey(dot));
    for (const dot of outgoingDots) all.add(dotGridKey(dot));
    return Array.from(all);
  }, [incomingDots, outgoingDots]);

  return (
    <>
      {keys.map((key) => {
        const outgoing = outgoingMap.get(key);
        const incoming = incomingMap.get(key);
        const x = outgoing?.x ?? incoming?.x;
        const y = outgoing?.y ?? incoming?.y;
        if (x === undefined || y === undefined) return null;

        const outOpacity = outgoing
          ? outgoing.active
            ? activeOpacity
            : inactiveOpacity
          : 0;
        const inOpacity = incoming
          ? incoming.active
            ? activeOpacity
            : inactiveOpacity
          : 0;

        if (outgoing && incoming && outgoing.active === incoming.active) {
          return (
            <circle
              key={key}
              cx={x}
              cy={y}
              r={dotRadius}
              fill={color}
              opacity={inOpacity}
            />
          );
        }

        const delaySec = (x / fieldWidth) * sweepSec;

        return (
          <Fragment key={key}>
            {outgoing ? (
              <motion.circle
                cx={x}
                cy={y}
                r={dotRadius}
                fill={color}
                initial={{ opacity: outOpacity }}
                animate={{ opacity: 0 }}
                transition={{
                  delay: delaySec,
                  duration: blinkSec,
                  ease: "easeOut",
                }}
              />
            ) : null}
            {incoming ? (
              <motion.circle
                cx={x}
                cy={y}
                r={dotRadius}
                fill={color}
                initial={{ opacity: 0 }}
                animate={{ opacity: inOpacity }}
                transition={{
                  delay: delaySec,
                  duration: blinkSec,
                  ease: "easeIn",
                }}
              />
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
}

function StaticDotLayer({
  dots,
  dotRadius,
  color,
  activeOpacity,
  inactiveOpacity,
}: {
  dots: MemberCardDot[];
  dotRadius: number;
  color: string;
  activeOpacity: number;
  inactiveOpacity: number;
}) {
  return (
    <>
      {dots.map(({ x, y, active }, index) => (
        <circle
          key={index}
          cx={x}
          cy={y}
          r={dotRadius}
          fill={color}
          opacity={active ? activeOpacity : inactiveOpacity}
        />
      ))}
    </>
  );
}

function StripeDotField({
  currentDots,
  outgoingDots,
  isTransitioning,
  sweep,
  width,
  dotRadius,
  color,
  activeOpacity,
  inactiveOpacity,
}: {
  currentDots: MemberCardDot[];
  outgoingDots: MemberCardDot[];
  isTransitioning: boolean;
  sweep: boolean;
  width: number;
  dotRadius: number;
  color: string;
  activeOpacity: number;
  inactiveOpacity: number;
}) {
  return (
    <svg
      width={width}
      height={STRIPE_HEIGHT}
      viewBox={`0 0 ${width} ${STRIPE_HEIGHT}`}
      xmlns="http://www.w3.org/2000/svg"
      className="absolute inset-0"
    >
      {isTransitioning && sweep ? (
        <SweepBlinkDotLayers
          outgoingDots={outgoingDots}
          incomingDots={currentDots}
          fieldWidth={width}
          dotRadius={dotRadius}
          color={color}
          activeOpacity={activeOpacity}
          inactiveOpacity={inactiveOpacity}
        />
      ) : (
        <StaticDotLayer
          dots={currentDots}
          dotRadius={dotRadius}
          color={color}
          activeOpacity={activeOpacity}
          inactiveOpacity={inactiveOpacity}
        />
      )}
    </svg>
  );
}

export function formatCardDate(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export const STAMP_LAYER_CLASS =
  "absolute inset-0 flex items-center justify-end origin-[85%_70%]";

export const MemberCardPaperOverlays = ({
  seedKey,
  cardHeight,
}: {
  seedKey: string;
  cardHeight: number;
}) => {
  const palette = useMemberCardPalette();
  const securityDots = useMemo(
    () => buildSecurityDots(seedKey, cardHeight),
    [seedKey, cardHeight],
  );
  const noiseSeed = seedFromLicenseKey(`${seedKey}:grain`) % 997;
  const noiseFilterId = `member-card-noise-${noiseSeed}`;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ borderRadius: `${CARD_RADIUS}px` }}
    >
      <svg
        width={CARD_WIDTH}
        height={cardHeight}
        viewBox={`0 0 ${CARD_WIDTH} ${cardHeight}`}
        xmlns="http://www.w3.org/2000/svg"
        className="absolute inset-0"
      >
        {securityDots.map(({ x, y, active }, index) => (
          <circle
            key={index}
            cx={x}
            cy={y}
            r={SECURITY_DOT_SIZE / 2}
            fill={palette.dotColor}
            opacity={
              active
                ? palette.securityDotOpacity
                : palette.securityDotOpacity * 0.35
            }
          />
        ))}
      </svg>

      <svg
        width={CARD_WIDTH}
        height={cardHeight}
        className="absolute inset-0"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <filter id={noiseFilterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.92"
              numOctaves="4"
              seed={noiseSeed}
              stitchTiles="stitch"
            />
          </filter>
        </defs>
        <rect
          width={CARD_WIDTH}
          height={cardHeight}
          filter={`url(#${noiseFilterId})`}
          opacity={palette.noiseOpacity}
        />
      </svg>

      <div
        className="absolute inset-0"
        style={{
          boxShadow: palette.vignette,
          borderRadius: `${CARD_RADIUS}px`,
        }}
      />
    </div>
  );
};

export const CardWordmark = () => {
  const palette = useMemberCardPalette();

  return (
    <p
      className="font-mono uppercase tracking-[0.24em]"
      style={{
        fontSize: "10px",
        fontWeight: 700,
        lineHeight: 1.35,
        color: palette.textDisabled,
        textShadow: palette.wordmarkShadow,
      }}
    >
      Glimpse
    </p>
  );
};

export const CardStampSlot = ({ children }: { children: ReactNode }) => (
  <div
    className="relative shrink-0 overflow-visible"
    style={{
      width: `${CARD_STAMP_SLOT_WIDTH}px`,
      height: `${CARD_STAMP_SLOT_HEIGHT}px`,
    }}
  >
    {children}
  </div>
);

export const CardHeaderRow = ({
  stamp,
  price,
  priceColor,
}: {
  stamp: ReactNode;
  price?: string | null;
  priceColor?: string;
}) => {
  const palette = useMemberCardPalette();

  return (
    <div
      className="relative flex shrink-0 items-start justify-end overflow-visible"
      style={{ height: `${CARD_HEADER_HEIGHT}px` }}
    >
      <div
        className="pointer-events-none absolute left-0 min-w-0 max-w-[58%]"
        style={{ top: "-11px" }}
      >
        <CardWordmark />
        {price && priceColor ? (
          <p
            className="mt-1.5 truncate font-mono tabular-nums tracking-[0.02em]"
            style={{
              fontSize: "13px",
              fontWeight: 600,
              lineHeight: 1.2,
              color: priceColor,
              textShadow: palette.wordmarkShadow,
            }}
          >
            {price}
          </p>
        ) : null}
      </div>
      <CardStampSlot>{stamp}</CardStampSlot>
    </div>
  );
};

export const CardHeadlineBlock = ({
  title,
  subtitle,
  height = CARD_HEADLINE_HEIGHT,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  height?: number;
}) => (
  <div
    className="flex min-w-0 shrink-0 flex-col overflow-hidden"
    style={{
      marginTop: `-${CARD_HEADLINE_OVERLAP}px`,
      gap: `${CARD_HEADLINE_GAP}px`,
      height: `${height}px`,
    }}
  >
    <div className="min-w-0">{title}</div>
    <div className="min-w-0">{subtitle}</div>
  </div>
);

export const CardDetailsGrid = ({
  children,
  height = CARD_DETAILS_HEIGHT,
}: {
  children: ReactNode;
  height?: number;
}) => (
  <dl
    className="mt-2 shrink-0 grid grid-cols-2 gap-x-6 gap-y-2"
    style={{ height: `${height}px` }}
  >
    {children}
  </dl>
);

export const CardDottedRule = () => {
  const palette = useMemberCardPalette();

  return (
    <svg
      width={CARD_INNER_WIDTH}
      height={2}
      aria-hidden="true"
      className="block w-full"
      viewBox={`0 0 ${CARD_INNER_WIDTH} 2`}
      preserveAspectRatio="none"
    >
      <line
        x1={0}
        y1={1}
        x2={CARD_INNER_WIDTH}
        y2={1}
        stroke={palette.border}
        strokeWidth={1}
        strokeDasharray="2 5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

export const TierStamp = ({
  label,
  color,
  bg,
}: {
  label: string;
  color: string;
  bg: string;
}) => {
  const stampStyle = {
    color,
    backgroundColor: bg,
    border: `1.5px dashed color-mix(in srgb, ${color} 50%, transparent)`,
    borderRadius: "6px 2px 6px 2px",
    padding: "4px 10px",
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.16em",
    lineHeight: 1,
  };

  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ transform: "rotate(3deg)" }}
    >
      <span
        aria-hidden="true"
        style={{
          ...stampStyle,
          position: "absolute",
          top: "0.8px",
          left: "0.6px",
          opacity: 0.38,
          filter: "blur(0.45px)",
          pointerEvents: "none",
        }}
      >
        {label}
      </span>
      <span style={stampStyle}>{label}</span>
    </span>
  );
};

export const Detail = ({
  label,
  value,
  wide = false,
  muted = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
  muted?: boolean;
}) => {
  const palette = useMemberCardPalette();

  return (
    <div className={`min-w-0 ${wide ? "col-span-2" : ""}`}>
      <dt
        className="font-mono uppercase tracking-[0.16em]"
        style={{
          fontSize: "9.5px",
          fontWeight: 600,
          color: palette.textDisabled,
        }}
      >
        {label}
      </dt>
      <dd
        className="mt-1 truncate font-mono"
        style={{
          fontSize: "13px",
          fontWeight: 500,
          color: muted ? palette.textDisabled : palette.textPrimary,
        }}
      >
        {value}
      </dd>
    </div>
  );
};

export const MemberCardStripe = ({
  seedKey,
  transitionMode = "none",
  density = CARD_STRIPE_DENSITY,
}: {
  seedKey: string;
  transitionMode?: StripeDotTransitionMode;
  density?: number;
}) => {
  const palette = useMemberCardPalette();
  const buildStripeDotsForDensity = useMemo(
    () => (key: string) => buildStripeDots(key, density),
    [density],
  );
  const sweep = transitionMode === "sweep";
  const { outgoingKey, incomingKey, isTransitioning } = useDotSeedTransition(
    seedKey,
    sweep ? DOT_SWAP_TOTAL_MS : 0,
    sweep,
  );
  const currentDots = useMemo(
    () => buildStripeDotsForDensity(sweep ? incomingKey : seedKey),
    [buildStripeDotsForDensity, sweep, incomingKey, seedKey],
  );
  const outgoingDots = useMemo(
    () => (outgoingKey ? buildStripeDotsForDensity(outgoingKey) : []),
    [buildStripeDotsForDensity, outgoingKey],
  );

  return (
    <div
      aria-hidden="true"
      className="relative shrink-0"
      style={{
        marginLeft: `-${CARD_PADDING}px`,
        marginRight: `-${CARD_PADDING}px`,
        marginTop: `${CARD_STRIPE_GAP}px`,
        width: `${CARD_WIDTH}px`,
        height: `${STRIPE_HEIGHT}px`,
        backgroundColor: palette.stripeBg,
        borderBottomLeftRadius: `${STRIPE_CORNER_RADIUS}px`,
        borderBottomRightRadius: `${STRIPE_CORNER_RADIUS}px`,
        overflow: "hidden",
      }}
    >
      <svg
        width={CARD_WIDTH}
        height={3}
        viewBox={`0 0 ${CARD_WIDTH} 3`}
        xmlns="http://www.w3.org/2000/svg"
        className="pointer-events-none absolute inset-x-0 z-[2]"
        style={{ top: `${STRIPE_DIVIDER_OFFSET}px` }}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line
          x1={0}
          y1={1.5}
          x2={CARD_WIDTH}
          y2={1.5}
          stroke={palette.border}
          strokeWidth={2}
          strokeDasharray="6 4"
          strokeLinecap="butt"
        />
      </svg>
      <StripeDotField
        currentDots={currentDots}
        outgoingDots={outgoingDots}
        isTransitioning={isTransitioning}
        sweep={sweep}
        width={CARD_WIDTH}
        dotRadius={STRIPE_DOT_SIZE / 2}
        color={palette.dotColor}
        activeOpacity={1}
        inactiveOpacity={0.2}
      />
    </div>
  );
};

export const MemberCardFrame = ({
  children,
  layoutId = MEMBER_CARD_LAYOUT_ID,
}: {
  children: ReactNode;
  layoutId?: string;
}) => {
  void layoutId;
  return (
    <div className="relative z-[1] flex flex-col p-5 pb-0">{children}</div>
  );
};
