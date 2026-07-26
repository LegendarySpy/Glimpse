import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { labelForTodayStatSlide } from "../homeHeaderStats";
import {
  getHomeGreetingVariant,
  homeGreetingKey,
  labelForHomeGreeting,
  useTimeOfDayPeriodTick,
} from "../homeGreeting";
import { getActiveTodayStatSlide } from "../todayStats";
import type { TodayDictationStats } from "../../../types";

const fadeTransition = { duration: 0.22, ease: "easeOut" as const };

function formatHomeDate(now: Date, locale: string): string {
  return now.toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

type HomeTodayHeaderProps = {
  transcriptionsFetched: boolean;
  stats: TodayDictationStats;
  active: boolean;
};

export default function HomeTodayHeader({
  transcriptionsFetched,
  stats,
  active,
}: HomeTodayHeaderProps) {
  const { i18n, t } = useLingui();
  const periodTick = useTimeOfDayPeriodTick(active);

  const now = new Date();
  const dateLabel = formatHomeDate(now, i18n.locale);

  const greetingVariant = useMemo(
    () => getHomeGreetingVariant(now),
    [periodTick, now.getFullYear(), now.getMonth(), now.getDate()],
  );
  const statSlide = useMemo(
    () => getActiveTodayStatSlide(stats, now),
    [periodTick, stats, now.getFullYear(), now.getMonth(), now.getDate()],
  );

  const greetingText = greetingVariant
    ? labelForHomeGreeting(greetingVariant, t)
    : "";
  const greetingKey = greetingVariant
    ? homeGreetingKey(greetingVariant, now)
    : "empty";
  const statText = statSlide ? labelForTodayStatSlide(statSlide, stats, t) : "";

  return (
    <header className="mb-4 shrink-0">
      <AnimatePresence mode="wait" initial={false}>
        <motion.h1
          key={greetingKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={fadeTransition}
          className="font-satoshi ui-text-display font-normal ui-color-primary tracking-tight"
        >
          {greetingText}
        </motion.h1>
      </AnimatePresence>

      <p className="mt-2 ui-text-body ui-color-muted">{dateLabel}</p>

      {transcriptionsFetched && statText ? (
        <p className="mt-1 ui-text-body-sm ui-color-disabled">{statText}</p>
      ) : null}
    </header>
  );
}
