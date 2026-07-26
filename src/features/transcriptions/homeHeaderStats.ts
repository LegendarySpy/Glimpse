import { msg, plural } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import {
  averageWordsPerDictation,
  formatRecordingClock,
  type TodayStatSlide,
  wordsPerMinute,
} from "./todayStats";
import type { TodayDictationStats } from "../../types";

export function labelForTodayStatSlide(
  slide: TodayStatSlide,
  stats: TodayDictationStats,
  t: (descriptor: MessageDescriptor) => string,
): string {
  switch (slide) {
    case "dictations_words":
      return t(
        msg({
          id: "home.today.stats.dictations_words",
          message: `${plural(stats.count, {
            one: "# dictation",
            other: "# dictations",
          })} · ${plural(stats.words, {
            one: "# word",
            other: "# words",
          })} today`,
        }),
      );
    case "minutes_spoken": {
      const seconds = Math.round(stats.audioSeconds);
      if (seconds < 60) {
        return t(
          msg({
            id: "home.today.stats.seconds_spoken",
            message: plural(seconds, {
              one: "# second spoken today",
              other: "# seconds spoken today",
            }),
          }),
        );
      }
      const minutes = Math.max(1, Math.round(seconds / 60));
      return t(
        msg({
          id: "home.today.stats.minutes_spoken",
          message: plural(minutes, {
            one: "# minute spoken today",
            other: "# minutes spoken today",
          }),
        }),
      );
    }
    case "avg_words": {
      const avg = averageWordsPerDictation(stats);
      return t(
        msg({
          id: "home.today.stats.avg_words",
          message: plural(avg, {
            one: "About # word per dictation today",
            other: "About # words per dictation today",
          }),
        }),
      );
    }
    case "longest_duration":
      return t(
        msg({
          id: "home.today.stats.longest_duration",
          message: `Longest recording today: ${formatRecordingClock(stats.longestAudioSeconds)}`,
        }),
      );
    case "longest_words":
      return t(
        msg({
          id: "home.today.stats.longest_words",
          message: plural(stats.longestWords, {
            one: "Longest dictation today: # word",
            other: "Longest dictation today: # words",
          }),
        }),
      );
    case "pace_wpm": {
      const wpm = wordsPerMinute(stats);
      return t(
        msg({
          id: "home.today.stats.pace_wpm",
          message: plural(wpm, {
            one: "About # word per minute today",
            other: "About # words per minute today",
          }),
        }),
      );
    }
    case "llm_cleaned":
      return t(
        msg({
          id: "home.today.stats.llm_cleaned",
          message: plural(stats.llmCleanedCount, {
            one: "# dictation polished with AI today",
            other: "# dictations polished with AI today",
          }),
        }),
      );
    default:
      return "";
  }
}
