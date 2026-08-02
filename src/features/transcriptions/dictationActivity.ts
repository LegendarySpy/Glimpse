import { invoke } from "@tauri-apps/api/core";

export type DictationDay = {
  day: string;
  count: number;
  words: number;
};

export const ACTIVITY_WEEKS = 53;

// Words per minute a typical typist sustains, used only for the saved-time
// estimate. Stated under the figures so the number stays auditable.
export const ASSUMED_TYPING_WPM = 40;

export async function getDictationActivity(
  startMs: number,
): Promise<DictationDay[]> {
  return invoke<DictationDay[]>("get_dictation_activity", { startMs });
}

export function localDayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function activityStart(today: Date): Date {
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (ACTIVITY_WEEKS * 7 - 1));
  start.setDate(start.getDate() - start.getDay());
  return start;
}

export type ActivityCell = {
  key: string;
  date: Date;
  count: number;
  words: number;
  future: boolean;
};

export function buildActivityGrid(
  days: DictationDay[],
  today: Date,
): ActivityCell[][] {
  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  const start = activityStart(today);
  const todayKey = localDayKey(today);
  const columns: ActivityCell[][] = [];

  for (let week = 0; week < ACTIVITY_WEEKS; week += 1) {
    const column: ActivityCell[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + week * 7 + weekday);
      const key = localDayKey(date);
      const entry = byDay.get(key);
      column.push({
        key,
        date,
        count: entry?.count ?? 0,
        words: entry?.words ?? 0,
        future: key > todayKey,
      });
    }
    columns.push(column);
  }

  return columns;
}

export function activityLevel(words: number, busiest: number): number {
  if (words <= 0) return 0;
  if (busiest <= 0) return 1;
  const ratio = words / busiest;
  if (ratio > 0.66) return 4;
  if (ratio > 0.33) return 3;
  if (ratio > 0.1) return 2;
  return 1;
}

export function currentStreak(days: DictationDay[], today: Date): number {
  const dictated = new Set(days.filter((d) => d.count > 0).map((d) => d.day));
  const cursor = new Date(today);
  cursor.setHours(0, 0, 0, 0);

  // Today not being done yet should not read as a broken streak.
  if (!dictated.has(localDayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }

  let streak = 0;
  while (dictated.has(localDayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function speakingWpm(totalWords: number, totalDurationMs: number) {
  const minutes = totalDurationMs / 60000;
  if (minutes <= 0) return 0;
  return Math.round(totalWords / minutes);
}

export function minutesSaved(totalWords: number, totalDurationMs: number) {
  const typedMinutes = totalWords / ASSUMED_TYPING_WPM;
  const spokenMinutes = totalDurationMs / 60000;
  return Math.max(0, typedMinutes - spokenMinutes);
}

export function monthLabels(grid: ActivityCell[][]) {
  const labels: Array<{ column: number; month: number }> = [];
  let previous = -1;
  grid.forEach((column, index) => {
    const month = column[0].date.getMonth();
    if (month !== previous) {
      labels.push({ column: index, month });
      previous = month;
    }
  });
  // The first column usually shows only a sliver of its month.
  return labels.filter((label, index) =>
    index === 0
      ? labels.length === 1 || labels[1].column > 1
      : label.column > 0,
  );
}

export function longestStreak(days: DictationDay[]): number {
  const dictated = days
    .filter((day) => day.count > 0)
    .map((day) => day.day)
    .sort();
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of dictated) {
    if (previous) {
      const cursor = new Date(`${previous}T00:00:00`);
      cursor.setDate(cursor.getDate() + 1);
      run = localDayKey(cursor) === day ? run + 1 : 1;
    } else {
      run = 1;
    }
    best = Math.max(best, run);
    previous = day;
  }
  return best;
}
