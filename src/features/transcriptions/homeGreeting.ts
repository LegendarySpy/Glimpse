import { useEffect, useState } from "react";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

export type TimeOfDayPeriod = "morning" | "afternoon" | "evening";

export type HomeGreetingVariant =
  { kind: "time" } | { kind: "occasion"; id: HomeOccasionId };

export type HomeOccasionId = "leap_day";

// Morning 6–12, afternoon 12–17, evening 17–6 (local)
export function timeOfDayPeriod(now: Date = new Date()): TimeOfDayPeriod {
  const hour = now.getHours();
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}

type OccasionRule = {
  id: HomeOccasionId;
  descriptor: MessageDescriptor;
  when: (date: Date) => boolean;
};

const OCCASION_RULES: OccasionRule[] = [
  {
    id: "leap_day",
    descriptor: msg({
      id: "home.greeting.occasion.leap_day",
      message: "Happy leap day",
    }),
    when: (date) => date.getMonth() === 1 && date.getDate() === 29,
  },
];

function mixSeed(...parts: number[]): number {
  let h = 0;
  for (const part of parts) {
    h = Math.imul(h ^ part, 0x9e3779b1);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

function localCalendarKey(date: Date): number {
  return (
    date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate()
  );
}

function periodSalt(period: TimeOfDayPeriod): number {
  if (period === "morning") return 1;
  if (period === "afternoon") return 2;
  return 3;
}

function periodEndMs(now: Date, period: TimeOfDayPeriod): number {
  const end = new Date(now);
  if (period === "morning") {
    end.setHours(12, 0, 0, 0);
    return end.getTime();
  }
  if (period === "afternoon") {
    end.setHours(17, 0, 0, 0);
    return end.getTime();
  }
  if (now.getHours() < 6) {
    end.setHours(6, 0, 0, 0);
  } else {
    end.setDate(end.getDate() + 1);
    end.setHours(6, 0, 0, 0);
  }
  return end.getTime();
}

function msUntilNextTimeOfDayPeriod(now: Date = new Date()): number {
  const period = timeOfDayPeriod(now);
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  const target = Math.min(periodEndMs(now, period), nextMidnight.getTime());
  return Math.max(1_000, target - now.getTime() + 50);
}

/** Re-render when the local morning / afternoon / evening band changes. */
export function useTimeOfDayPeriodTick(enabled: boolean): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    let timeoutId = 0;

    const schedule = () => {
      timeoutId = window.setTimeout(() => {
        setTick((value) => value + 1);
        schedule();
      }, msUntilNextTimeOfDayPeriod());
    };

    schedule();
    return () => window.clearTimeout(timeoutId);
  }, [enabled]);

  return tick;
}

function stableIndex(length: number, now: Date, extraSalt: number): number {
  if (length <= 0) return 0;
  const mixed = mixSeed(
    localCalendarKey(now),
    periodSalt(timeOfDayPeriod(now)),
    extraSalt,
  );
  return mixed % length;
}

export function getHomeOccasions(now: Date = new Date()): HomeOccasionId[] {
  return OCCASION_RULES.filter((rule) => rule.when(now)).map((rule) => rule.id);
}

export function pickStableForCurrentPeriod<T>(
  items: readonly T[],
  extraSalt: number,
  now: Date = new Date(),
): T | undefined {
  if (items.length === 0) return undefined;
  return items[stableIndex(items.length, now, extraSalt)];
}

export function getHomeGreetingVariant(
  now: Date = new Date(),
): HomeGreetingVariant {
  const occasions = getHomeOccasions(now).map((id): HomeGreetingVariant => ({
    kind: "occasion",
    id,
  }));
  const pool: HomeGreetingVariant[] = [{ kind: "time" }, ...occasions];
  return pool[stableIndex(pool.length, now, 0)] ?? pool[0];
}

export function homeGreetingKey(
  variant: HomeGreetingVariant,
  now: Date = new Date(),
): string {
  if (variant.kind === "occasion") return `occasion-${variant.id}`;
  return `time-${timeOfDayPeriod(now)}`;
}

export function labelForHomeGreeting(
  variant: HomeGreetingVariant,
  t: (descriptor: MessageDescriptor) => string,
): string {
  switch (variant.kind) {
    case "occasion": {
      const rule = OCCASION_RULES.find((entry) => entry.id === variant.id);
      if (!rule) return "";
      return t(rule.descriptor);
    }
    case "time":
      switch (timeOfDayPeriod()) {
        case "morning":
          return t(
            msg({
              id: "home.greeting.morning",
              message: "Good morning",
            }),
          );
        case "afternoon":
          return t(
            msg({
              id: "home.greeting.afternoon",
              message: "Good afternoon",
            }),
          );
        default:
          return t(
            msg({
              id: "home.greeting.evening",
              message: "Good evening",
            }),
          );
      }
  }
}
