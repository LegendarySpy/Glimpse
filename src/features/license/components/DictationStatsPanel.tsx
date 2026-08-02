import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ShareNetwork } from "@phosphor-icons/react";
import SectionLabel from "../../../shared/ui/SectionLabel";
import ActivityGrid, { LEVEL_OPACITY } from "./ActivityGrid";
import ShareCardModal from "./ShareCardModal";
import { useDictationStats } from "../queries";
import {
  activityStart,
  buildActivityGrid,
  currentStreak,
  getDictationActivity,
  longestStreak,
  minutesSaved,
  speakingWpm,
  type ActivityCell,
  type DictationDay,
} from "../../transcriptions/dictationActivity";

const formatCompact = (value: number) =>
  value >= 10000
    ? `${Math.round(value / 1000)}k`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : `${value}`;

const formatDuration = (minutes: number) => {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
};

type HoveredCell = { cell: ActivityCell; x: number; y: number };

const DictationStatsPanel = () => {
  const { t, i18n } = useLingui();
  const today = useMemo(() => new Date(), []);
  const startMs = useMemo(() => activityStart(today).getTime(), [today]);
  const [hovered, setHovered] = useState<HoveredCell | null>(null);
  const [sharing, setSharing] = useState(false);

  const { data: totals } = useDictationStats();
  const { data: activity } = useQuery({
    queryKey: ["dictation-activity", startMs],
    queryFn: () => getDictationActivity(startMs),
    staleTime: 5 * 60 * 1000,
  });

  const days: DictationDay[] = useMemo(() => activity ?? [], [activity]);
  const grid = useMemo(() => buildActivityGrid(days, today), [days, today]);
  const busiest = useMemo(
    () => days.reduce((max, day) => Math.max(max, day.words), 0),
    [days],
  );

  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.locale, { month: "short" }),
    [i18n.locale],
  );
  const dayFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" }),
    [i18n.locale],
  );

  const totalWords = totals?.totalWords ?? 0;
  const totalDurationMs = totals?.totalDurationMs ?? 0;
  const totalDictations = totals?.totalDictations ?? 0;
  const daysDictated = days.filter((day) => day.count > 0).length;

  const wpm = speakingWpm(totalWords, totalDurationMs);
  const fasterPercent = Math.max(0, Math.round((wpm / 40 - 1) * 100));

  const figures = [
    {
      key: "wpm",
      value: `${wpm}`,
      label: t({ id: "settings.stats.wpm", message: "Words a minute" }),
    },
    {
      key: "dictations",
      value: formatCompact(totalDictations),
      label: t({ id: "settings.stats.dictations", message: "Dictations" }),
    },
    {
      key: "saved",
      value: formatDuration(minutesSaved(totalWords, totalDurationMs)),
      label: t({ id: "settings.stats.saved", message: "Time saved" }),
    },
    {
      key: "streak",
      value: `${currentStreak(days, today)}`,
      label: t({ id: "settings.stats.streak", message: "Day streak" }),
    },
    {
      key: "best_streak",
      value: `${longestStreak(days)}`,
      label: t({ id: "settings.stats.best_streak", message: "Best streak" }),
    },
  ];

  const stampFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    [i18n.locale],
  );

  const shareLabels = useMemo(
    () => ({
      date: stampFormatter.format(today),
      speakAt: t({ id: "settings.stats.card.speak_at", message: "I speak at" }),
      wordsAMinute: t({
        id: "settings.stats.card.words_a_minute",
        message: "words a minute",
      }),
      fasterValue: t({
        id: "settings.stats.card.faster_value",
        message: `${fasterPercent}% faster`,
      }),
      thanTyping: t({
        id: "settings.stats.card.than_typing",
        message: "than typing",
      }),
      fasterInline: t({
        id: "settings.stats.card.faster_inline",
        message: `${fasterPercent}% faster than typing`,
      }),
      daysHeadline: t({
        id: "settings.stats.card.days_headline.v2",
        message: plural(daysDictated, {
          one: "# day",
          other: "# days",
        }),
      }),
      ofDictating: t({
        id: "settings.stats.card.of_dictating",
        message: "of dictating this year",
      }),
      words: t({ id: "settings.stats.card.words", message: "words" }),
      dictations: t({
        id: "settings.stats.card.dictations",
        message: "dictations",
      }),
      saved: t({ id: "settings.stats.card.saved", message: "saved" }),
    }),
    [t, fasterPercent, daysDictated, stampFormatter, today],
  );

  const shareData = useMemo(
    () => ({
      labels: shareLabels,
      rtl: ["ar", "he", "fa", "ur"].includes(i18n.locale.split("-")[0]),
      words: formatCompact(totalWords),
      wpm,
      fasterPercent,
      timeSaved: formatDuration(minutesSaved(totalWords, totalDurationMs)),
      dictations: formatCompact(totalDictations),
      daysDictated,
      grid,
      busiest,
    }),
    [
      totalWords,
      wpm,
      fasterPercent,
      totalDurationMs,
      totalDictations,
      daysDictated,
      grid,
      busiest,
      shareLabels,
      i18n.locale,
    ],
  );

  const shareTexts = useMemo(
    () => [
      t({
        id: "settings.stats.post.1",
        message: `I speak at ${wpm} words a minute. Turns out talking beats typing. Dictated with @try_glimpse_app`,
      }),
      t({
        id: "settings.stats.post.2",
        message: `${wpm} words a minute out loud. My hands have never been happier. @try_glimpse_app`,
      }),
      t({
        id: "settings.stats.post.3",
        message: `Stopped typing, started talking. ${wpm} words a minute and counting. @try_glimpse_app`,
      }),
      t({
        id: "settings.stats.post.4.v2",
        message: `${daysDictated} days of talking instead of typing in the last year, ${formatCompact(totalWords)} words dictated all time. @try_glimpse_app`,
      }),
      t({
        id: "settings.stats.post.5",
        message: `My keyboard is getting jealous. ${wpm} words a minute with @try_glimpse_app`,
      }),
      t({
        id: "settings.stats.post.6",
        message: `${formatCompact(totalWords)} words dictated, none of them typed. @try_glimpse_app`,
      }),
      t({
        id: "settings.stats.post.7",
        message: `Turns out I think faster than I type. ${wpm} words a minute. @try_glimpse_app`,
      }),
      t({
        id: "settings.stats.post.8.v2",
        message: `${formatDuration(minutesSaved(totalWords, totalDurationMs))} I never spent typing. @try_glimpse_app`,
      }),
      t({
        id: "settings.stats.post.9",
        message: `${daysDictated} days of talking my way through work. @try_glimpse_app`,
      }),
      t({
        id: "settings.stats.post.10",
        message: `Voice is the fastest keyboard I own. ${wpm} words a minute. @try_glimpse_app`,
      }),
    ],
    [t, wpm, daysDictated, totalWords, totalDurationMs],
  );

  return (
    <div className="space-y-3">
      <SectionLabel
        trailing={
          <button
            onClick={() => setSharing(true)}
            className="ui-button-ghost h-6 shrink-0 gap-1.5 px-2 ui-text-button"
          >
            <ShareNetwork size={13} />
            {t({ id: "settings.stats.share.open", message: "Share" })}
          </button>
        }
      >
        {t({ id: "settings.stats.title", message: "Statistics" })}
      </SectionLabel>

      <div className="flex items-baseline justify-between gap-3">
        <span className="ui-text-body-sm ui-color-secondary">
          {t({
            id: "settings.stats.headline.v2",
            message: plural(daysDictated, {
              one: "# day dictated in the last year",
              other: "# days dictated in the last year",
            }),
          })}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <span className="ui-text-micro ui-color-disabled">
            {t({ id: "settings.stats.less", message: "Less" })}
          </span>
          {LEVEL_OPACITY.map((opacity, level) => (
            <div
              key={level}
              className="size-[9px] rounded-[2px]"
              style={{
                backgroundColor:
                  level === 0
                    ? "var(--surface-interactive-strong)"
                    : "var(--color-local)",
                opacity: level === 0 ? 1 : opacity,
              }}
            />
          ))}
          <span className="ui-text-micro ui-color-disabled">
            {t({ id: "settings.stats.more", message: "More" })}
          </span>
        </div>
      </div>

      <ActivityGrid
        grid={grid}
        busiest={busiest}
        monthFormatter={monthFormatter}
        onHover={(cell, x, y) => setHovered(cell ? { cell, x, y } : null)}
      />

      <div className="grid grid-cols-5 gap-3 pt-1">
        {figures.map((figure) => (
          <div key={figure.key} className="min-w-0">
            <div className="ui-text-title-lg ui-color-primary tabular-nums">
              {figure.value}
            </div>
            <div className="mt-0.5 ui-text-micro ui-color-disabled leading-tight">
              {figure.label}
            </div>
          </div>
        ))}
      </div>

      {hovered &&
        createPortal(
          <div
            className="settings-typescale ui-surface-menu pointer-events-none fixed z-tooltip -translate-y-full px-2.5 py-1.5"
            style={{ left: hovered.x + 9, top: hovered.y - 7 }}
          >
            <div className="ui-text-micro ui-color-primary whitespace-nowrap">
              {hovered.cell.count > 0
                ? t({
                    id: "settings.stats.tooltip.v2",
                    message: `${plural(hovered.cell.words, {
                      one: "# word",
                      other: "# words",
                    })} in ${plural(hovered.cell.count, {
                      one: "# dictation",
                      other: "# dictations",
                    })}`,
                  })
                : t({
                    id: "settings.stats.tooltip_empty",
                    message: "No dictation",
                  })}
            </div>
            <div className="ui-text-micro ui-color-disabled whitespace-nowrap">
              {dayFormatter.format(hovered.cell.date)}
            </div>
          </div>,
          document.body,
        )}

      <ShareCardModal
        isOpen={sharing}
        onClose={() => setSharing(false)}
        shareTexts={shareTexts}
        data={shareData}
      />
    </div>
  );
};

export default DictationStatsPanel;
