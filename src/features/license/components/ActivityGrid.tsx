import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import {
  ACTIVITY_ROWS,
  ACTIVITY_WEEKS,
  activityLevel,
  columnDots,
  monthLabels,
  type ActivityCell,
  type ActivityMode,
  type ActivityWeek,
} from "../../transcriptions/dictationActivity";

const LEVEL_OPACITY = [0, 0.24, 0.48, 0.72, 1];

const COLUMN_BASE_OPACITY = 0.8;
const COLUMN_CREST_OPACITY = 0.42;

const columnOpacity = (depth: number, lit: number) => {
  if (lit <= 1) return COLUMN_BASE_OPACITY;
  const ratio = (depth - 1) / (lit - 1);
  return (
    COLUMN_BASE_OPACITY - (COLUMN_BASE_OPACITY - COLUMN_CREST_OPACITY) * ratio
  );
};

const CELL = 10;
const GAP = 3;
const STEP = CELL + GAP;
const LABEL_BAND = 14;

const SWEEP_STEP_MS = 7;

export type ActivityTarget =
  { kind: "day"; cell: ActivityCell } | { kind: "week"; week: ActivityWeek };

export type ActivityGridProps = {
  grid: ActivityCell[][];
  weeks: ActivityWeek[];
  busiest: number;
  mode: ActivityMode;
  monthFormatter: Intl.DateTimeFormat;
  onHover?: (target: ActivityTarget | null, x: number, y: number) => void;
};

const ActivityGrid = ({
  grid,
  weeks,
  busiest,
  mode,
  monthFormatter,
  onHover,
}: ActivityGridProps) => {
  const { t } = useLingui();
  const months = useMemo(() => monthLabels(grid), [grid]);
  const [focused, setFocused] = useState<string | null>(null);

  const busiestWeek = useMemo(
    () => weeks.reduce((max, week) => Math.max(max, week.words), 0),
    [weeks],
  );
  const totalWords = weeks.length ? weeks[weeks.length - 1].cumulativeWords : 0;

  const width = ACTIVITY_WEEKS * STEP - GAP;
  const height = LABEL_BAND + ACTIVITY_ROWS * STEP - GAP;

  const ariaLabel =
    mode === "daily"
      ? t({
          id: "settings.stats.activity_grid.aria",
          message: "Daily dictation activity over the last year",
        })
      : mode === "weekly"
        ? t({
            id: "settings.stats.activity_grid.aria_weekly",
            message: "Weekly dictation activity over the last year",
          })
        : t({
            id: "settings.stats.activity_grid.aria_cumulative",
            message: "Cumulative dictation activity over the last year",
          });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: width }}
      preserveAspectRatio="xMinYMin meet"
      role="img"
      aria-label={ariaLabel}
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

      <g key={mode}>
        {mode === "daily"
          ? grid.map((column, columnIndex) => (
              <g
                key={column[0].key}
                className="activity-sweep"
                style={{ animationDelay: `${columnIndex * SWEEP_STEP_MS}ms` }}
              >
                {column.map((cell, rowIndex) => {
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
                        focused === cell.key
                          ? "var(--color-text-secondary)"
                          : "none"
                      }
                      strokeWidth={focused === cell.key ? 1 : 0}
                      onMouseEnter={(event) => {
                        setFocused(cell.key);
                        onHover?.(
                          { kind: "day", cell },
                          event.clientX,
                          event.clientY,
                        );
                      }}
                    />
                  );
                })}
              </g>
            ))
          : weeks.map((week, columnIndex) => {
              const lit = columnDots(
                mode === "weekly" ? week.words : week.cumulativeWords,
                mode === "weekly" ? busiestWeek : totalWords,
              );
              const isFocused = focused === week.key;
              return (
                <g
                  key={week.key}
                  className="activity-sweep"
                  style={{ animationDelay: `${columnIndex * SWEEP_STEP_MS}ms` }}
                  onMouseEnter={(event) => {
                    setFocused(week.key);
                    onHover?.(
                      { kind: "week", week },
                      event.clientX,
                      event.clientY,
                    );
                  }}
                >
                  <rect
                    x={columnIndex * STEP}
                    y={LABEL_BAND}
                    width={STEP}
                    height={ACTIVITY_ROWS * STEP - GAP}
                    fill="transparent"
                    pointerEvents="all"
                  />
                  {Array.from({ length: ACTIVITY_ROWS }, (_, rowIndex) => {
                    const depth = ACTIVITY_ROWS - rowIndex;
                    const active = depth <= lit;
                    return (
                      <rect
                        key={rowIndex}
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
                        fillOpacity={active ? columnOpacity(depth, lit) : 1}
                        stroke={
                          isFocused && active
                            ? "var(--color-text-secondary)"
                            : "none"
                        }
                        strokeWidth={isFocused && active ? 1 : 0}
                      />
                    );
                  })}
                </g>
              );
            })}
      </g>
    </svg>
  );
};

export default ActivityGrid;
