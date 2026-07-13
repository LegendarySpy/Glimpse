import type { TranscriptionSort } from "../../types";

export type { TranscriptionSort } from "../../types";

export type TimePreset = "any" | "today" | "7d" | "custom";

export type ParsedTranscriptionSearch = {
  text: string;
  sort: TranscriptionSort;
  // after is inclusive, before is exclusive, both start-of-day.
  after: Date | null;
  before: Date | null;
};

const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());

const addLocalDays = (d: Date, days: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

const pad = (n: number) => String(n).padStart(2, "0");

export function formatDateToken(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

export function parseTranscriptionSearch(
  query: string,
): ParsedTranscriptionSearch {
  let sort: TranscriptionSort = "recent";
  let after: Date | null = null;
  let before: Date | null = null;
  const text: string[] = [];

  for (const token of query.split(/\s+/)) {
    if (!token) continue;
    const sep = token.indexOf(":");
    if (sep > 0) {
      const key = token.slice(0, sep).toLowerCase();
      const value = token.slice(sep + 1);

      if (key === "sort") {
        const v = value.toLowerCase();
        sort =
          v === "oldest" || v === "longest" || v === "shortest" ? v : "recent";
        continue;
      }
      if (key === "after") {
        const d = parseDate(value);
        if (d) {
          after = startOfDay(d);
          continue;
        }
      }
      if (key === "before") {
        const d = parseDate(value);
        if (d) {
          before = startOfDay(d);
          continue;
        }
      }
      if (key === "on") {
        const d = parseDate(value);
        if (d) {
          after = startOfDay(d);
          before = addLocalDays(d, 1);
          continue;
        }
      }
    }
    text.push(token);
  }

  return { text: text.join(" "), sort, after, before };
}

export function matchesDateRange(
  timestamp: string | number | Date,
  after: Date | null,
  before: Date | null,
): boolean {
  if (!after && !before) return true;
  const time = new Date(timestamp).getTime();
  if (Number.isNaN(time)) return false;
  if (after && time < after.getTime()) return false;
  if (before && time >= before.getTime()) return false;
  return true;
}

export function withSortToken(query: string, sort: TranscriptionSort): string {
  const parts = query.split(/\s+/).filter((p) => p && !/^sort:/i.test(p));
  if (sort !== "recent") parts.push(`sort:${sort}`);
  return parts.join(" ");
}

export function withTimePreset(query: string, preset: TimePreset): string {
  const parts = query
    .split(/\s+/)
    .filter((p) => p && !/^(after|before|on):/i.test(p));
  const token = timePresetToken(preset);
  if (token) parts.push(token);
  return parts.join(" ");
}

function timePresetToken(preset: TimePreset): string | null {
  if (preset === "any" || preset === "custom") return null;
  const today = startOfDay(new Date());
  if (preset === "today") return `on:${formatDateToken(today)}`;
  const from = addLocalDays(today, -6);
  return `after:${formatDateToken(from)}`;
}

export function currentTimePreset(
  after: Date | null,
  before: Date | null,
): TimePreset {
  if (!after && !before) return "any";
  const today = startOfDay(new Date());
  if (
    after &&
    before &&
    after.getTime() === today.getTime() &&
    before.getTime() === addLocalDays(today, 1).getTime()
  ) {
    return "today";
  }
  if (after && !before) {
    if (after.getTime() === addLocalDays(today, -6).getTime()) return "7d";
  }
  return "custom";
}
