import { motion, useReducedMotion, type Transition } from "framer-motion";

type GlimpseLogoSize = "sm" | "md" | "lg" | "xl";

const GLIMPSE_LOGO_SIZES: Record<
  GlimpseLogoSize,
  { dot: number; gap: number }
> = {
  sm: { dot: 5, gap: 4 },
  md: { dot: 10, gap: 7 },
  lg: { dot: 14, gap: 10 },
  xl: { dot: 22, gap: 16 },
};

const GLIMPSE_LOGO_DOT_COLORS = [
  "var(--color-cloud)",
  "var(--color-local)",
  "var(--color-local)",
  "var(--color-cloud)",
];

const COLOR_MATRIX_VALUES = "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7";


const CLOUD_TRANSITION: Transition = {
  duration: 4,
  repeat: Infinity,
  times: [0, 0.125, 0.25, 0.5, 0.625, 0.75, 1],
  ease: ["easeIn", "easeOut", "linear", "easeIn", "easeOut", "linear"],
};
const LOCAL_TRANSITION: Transition = {
  duration: 4,
  repeat: Infinity,
  times: [0, 0.25, 0.375, 0.5, 0.75, 0.875, 1],
  ease: ["linear", "easeIn", "easeOut", "linear", "easeIn", "easeOut"],
};

export const GlimpseLogo = ({ size = "md" }: { size?: GlimpseLogoSize }) => {
  const sizes = GLIMPSE_LOGO_SIZES[size];
  const distance = sizes.dot + sizes.gap;
  const radius = sizes.dot / 2;
  const dotRadius = radius * 1.1;
  const coords = [
    { cx: radius, cy: radius },
    { cx: radius + distance, cy: radius },
    { cx: radius, cy: radius + distance },
    { cx: radius + distance, cy: radius + distance },
  ];
  const gridSize = sizes.dot * 2 + sizes.gap;
  const center = radius + distance / 2;
  const stdDev = sizes.dot * 0.2;
  const reduceMotion = useReducedMotion();

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: gridSize, height: gridSize }}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        width={gridSize}
        height={gridSize}
        viewBox={`0 0 ${gridSize} ${gridSize}`}
        style={{ overflow: "visible" }}
      >
        <defs>
          <filter
            id={`goo-${size}`}
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feGaussianBlur
              in="SourceGraphic"
              stdDeviation={stdDev}
              result="blur"
            />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values={COLOR_MATRIX_VALUES}
              result="goo"
            />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
        </defs>
        <g filter={`url(#goo-${size})`}>
          {coords.map((coord, i) => (
            <circle
              key={i}
              cx={coord.cx}
              cy={coord.cy}
              r={dotRadius}
              fill={GLIMPSE_LOGO_DOT_COLORS[i]}
            />
          ))}
          {reduceMotion ? null : (
            <>
              <motion.circle
                fill="var(--color-cloud)"
                animate={{
                  r: [
                    dotRadius,
                    dotRadius * 0.6,
                    dotRadius,
                    dotRadius,
                    dotRadius * 0.6,
                    dotRadius,
                    dotRadius,
                  ],
                  cx: [
                    coords[0].cx,
                    center,
                    coords[3].cx,
                    coords[3].cx,
                    center,
                    coords[0].cx,
                    coords[0].cx,
                  ],
                  cy: [
                    coords[0].cy,
                    center,
                    coords[3].cy,
                    coords[3].cy,
                    center,
                    coords[0].cy,
                    coords[0].cy,
                  ],
                }}
                transition={CLOUD_TRANSITION}
              />
              <motion.circle
                fill="var(--color-local)"
                animate={{
                  r: [
                    dotRadius,
                    dotRadius,
                    dotRadius * 0.6,
                    dotRadius,
                    dotRadius,
                    dotRadius * 0.6,
                    dotRadius,
                  ],
                  cx: [
                    coords[1].cx,
                    coords[1].cx,
                    center,
                    coords[2].cx,
                    coords[2].cx,
                    center,
                    coords[1].cx,
                  ],
                  cy: [
                    coords[1].cy,
                    coords[1].cy,
                    center,
                    coords[2].cy,
                    coords[2].cy,
                    center,
                    coords[1].cy,
                  ],
                }}
                transition={LOCAL_TRANSITION}
              />
            </>
          )}
        </g>
      </svg>
    </div>
  );
};
