import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import {
  ACTIVITY_WEEKS,
  activityLevel,
  monthLabels,
  type ActivityCell,
} from "../../transcriptions/dictationActivity";

export const LEVEL_OPACITY = [0, 0.24, 0.48, 0.72, 1];

const CELL = 10;
const GAP = 3;
const STEP = CELL + GAP;
const LABEL_BAND = 14;

export type ActivityGridProps = {
  grid: ActivityCell[][];
  busiest: number;
  monthFormatter: Intl.DateTimeFormat;
  onHover?: (cell: ActivityCell | null, x: number, y: number) => void;
};

const ActivityGrid = ({
  grid,
  busiest,
  monthFormatter,
  onHover,
}: ActivityGridProps) => {
  const { t } = useLingui();
  const months = useMemo(() => monthLabels(grid), [grid]);
  const [focused, setFocused] = useState<string | null>(null);

  const width = ACTIVITY_WEEKS * STEP - GAP;
  const height = LABEL_BAND + 7 * STEP - GAP;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      preserveAspectRatio="xMinYMin meet"
      role="img"
      aria-label={t({
        id: "settings.stats.activity_grid.aria",
        message: "Daily dictation activity over the last year",
      })}
      onMouseLeave={() => {
        setFocused(null);
        onHover?.(null, 0, 0);
      }}
    >
      {months.map((label) => (
        <text
          key={`${label.column}-${label.month}`}
          x={label.column * STEP}
          y={9}
          className="ui-color-disabled"
          fill="currentColor"
          fontSize={9}
        >
          {monthFormatter.format(new Date(2026, label.month, 1))}
        </text>
      ))}

      {grid.map((column, columnIndex) =>
        column.map((cell, rowIndex) => {
          if (cell.future) return null;
          const active = cell.count > 0;
          const level = active ? activityLevel(cell.words, busiest) : 0;
          return (
            <rect
              key={cell.key}
              x={columnIndex * STEP}
              y={LABEL_BAND + rowIndex * STEP}
              width={CELL}
              height={CELL}
              rx={2}
              fill={
                active
                  ? "var(--color-local)"
                  : "var(--surface-interactive-strong)"
              }
              fillOpacity={active ? LEVEL_OPACITY[level] : 1}
              className={level === 4 ? "activity-shimmer" : undefined}
              style={
                level === 4
                  ? {
                      animationDelay: `${((columnIndex * 7 + rowIndex) % 11) * 0.29}s`,
                    }
                  : undefined
              }
              stroke={
                focused === cell.key ? "var(--color-text-secondary)" : "none"
              }
              strokeWidth={focused === cell.key ? 1 : 0}
              onMouseEnter={(event) => {
                setFocused(cell.key);
                onHover?.(cell, event.clientX, event.clientY);
              }}
            />
          );
        }),
      )}
    </svg>
  );
};

export default ActivityGrid;
