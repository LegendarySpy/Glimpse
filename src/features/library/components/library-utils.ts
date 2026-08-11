import { msg } from "@lingui/core/macro";
import { i18n } from "../../../i18n";

export const SUPPORTED_EXTENSIONS = [
  "wav",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "flac",
  "mp4",
  "mov",
  "webm",
  "mkv",
];
export const PLAYBACK_RATES = [0.5, 1, 1.5, 2, 2.5, 3, 4];

export const clampProgress = (value: number) => Math.min(Math.max(value, 0), 1);

export const shouldShowImportProgress = (value: number) => {
  const clamped = clampProgress(value);
  return clamped >= 0.02 && clamped < 0.98;
};

export const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
};

export const formatPlaybackRate = (rate: number) =>
  rate.toFixed(2).replace(/\.?0+$/, "");

export const formatTimestamp = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export const getFileExtension = (path: string) => {
  const parts = path.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
};

export const uniquePaths = (paths: string[]) => Array.from(new Set(paths));
export const formatLibraryName = (name: string) => name.replace(/[_.]/g, " ");
export const sanitizeFileName = (value: string) =>
  value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ");

export const formatImportErrorMessage = (rawMessage: string) => {
  const message = rawMessage.trim();
  if (!message) {
    return i18n._(
      msg({
        id: "library.import_error.default",
        message: "Import failed for one of the files.",
      }),
    );
  }

  const lower = message.toLowerCase();
  if (lower.includes("selected model is not installed")) {
    return i18n._(
      msg({
        id: "library.import_error.model_not_installed",
        message:
          "Selected model isn't installed. Download one in Settings -> Models.",
      }),
    );
  }
  if (lower.includes("file not found")) {
    return i18n._(
      msg({
        id: "library.import_error.file_not_found",
        message: "File not found. It may have moved or been deleted.",
      }),
    );
  }
  if (lower.includes("unsupported file format")) {
    return i18n._(
      msg({
        id: "library.import_error.unsupported_format",
        message: "Unsupported file format.",
      }),
    );
  }
  if (lower.includes("no supported audio tracks")) {
    return i18n._(
      msg({
        id: "library.import_error.no_audio_track",
        message: "No audio track found in this file.",
      }),
    );
  }
  if (
    lower.includes("audio decode failed") ||
    lower.includes("failed to read audio container") ||
    lower.includes("unsupported audio codec") ||
    lower.includes("no audio samples decoded")
  ) {
    return i18n._(
      msg({
        id: "library.import_error.decode_failed",
        message: "Couldn't decode this audio file. Try installing FFmpeg.",
      }),
    );
  }
  if (lower.includes("failed to create library folder")) {
    return i18n._(
      msg({
        id: "library.import_error.create_storage_failed",
        message: "Couldn't create library storage. Check disk permissions.",
      }),
    );
  }
  if (lower.includes("failed to copy original file")) {
    return i18n._(
      msg({
        id: "library.import_error.copy_original_failed",
        message: "Couldn't copy the original file into the library.",
      }),
    );
  }
  if (
    lower.includes("wav writer init failed") ||
    lower.includes("wav finalize error") ||
    lower.includes("wav write error")
  ) {
    return i18n._(
      msg({
        id: "library.import_error.audio_conversion_failed",
        message: "Couldn't convert this file to audio for transcription.",
      }),
    );
  }
  if (
    lower.includes("invalid sample rate") ||
    lower.includes("unknown sample rate")
  ) {
    return i18n._(
      msg({
        id: "library.import_error.unsupported_sample_rate",
        message: "This file has an unsupported sample rate.",
      }),
    );
  }

  return i18n._(
    msg({
      id: "library.import_error.default_fallback",
      message: "Import failed for one of the files.",
    }),
  );
};

export const formatDeleteErrorMessage = (rawMessage: string) => {
  const message = rawMessage.trim();
  if (!message) {
    return i18n._(
      msg({
        id: "library.delete_error.default",
        message: "Failed to delete the library item.",
      }),
    );
  }

  const lower = message.toLowerCase();
  if (lower.includes("outside the library folder")) {
    return i18n._(
      msg({
        id: "library.delete_error.outside_folder",
        message:
          "Couldn't delete this item because its files are outside the library folder.",
      }),
    );
  }
  if (lower.includes("storage location")) {
    return i18n._(
      msg({
        id: "library.delete_error.storage_missing",
        message:
          "Couldn't delete this item. Library storage couldn't be found.",
      }),
    );
  }
  if (
    lower.includes("delete library files") ||
    lower.includes("delete library file")
  ) {
    return i18n._(
      msg({
        id: "library.delete_error.delete_files_failed",
        message:
          "Couldn't delete the library files. Check permissions and try again.",
      }),
    );
  }
  if (lower.includes("invalid library file path")) {
    return i18n._(
      msg({
        id: "library.delete_error.invalid_path",
        message: "Couldn't delete this item due to an invalid file path.",
      }),
    );
  }

  return i18n._(
    msg({
      id: "library.delete_error.default_fallback",
      message: "Failed to delete the library item.",
    }),
  );
};

export const getLibraryErrorDetails = (rawMessage: string) => {
  const message = rawMessage.trim();
  if (!message) {
    return {
      message: i18n._(
        msg({
          id: "library.error_details.import_failed",
          message: "Import failed.",
        }),
      ),
      showFfmpegHelp: false,
    };
  }

  const lower = message.toLowerCase();

  if (lower.includes("selected model is not installed")) {
    return {
      message: i18n._(
        msg({
          id: "library.error_details.model_not_installed",
          message: "Model not installed.",
        }),
      ),
      showFfmpegHelp: false,
    };
  }
  if (
    lower.includes("file not found") ||
    lower.includes("audio file not found")
  ) {
    return {
      message: i18n._(
        msg({
          id: "library.error_details.file_not_found",
          message: "File not found.",
        }),
      ),
      showFfmpegHelp: false,
    };
  }
  if (lower.includes("unsupported file format")) {
    return {
      message: i18n._(
        msg({
          id: "library.error_details.unsupported_format",
          message: "Unsupported file format.",
        }),
      ),
      showFfmpegHelp: false,
    };
  }
  if (lower.includes("no supported audio tracks")) {
    return {
      message: i18n._(
        msg({
          id: "library.error_details.no_audio_track",
          message: "No audio track found.",
        }),
      ),
      showFfmpegHelp: false,
    };
  }
  if (
    lower.includes("invalid sample rate") ||
    lower.includes("unknown sample rate") ||
    lower.includes("unknown channel count") ||
    lower.includes("unsupported wav sample format")
  ) {
    return {
      message: i18n._(
        msg({
          id: "library.error_details.unsupported_audio_settings",
          message: "Unsupported audio settings.",
        }),
      ),
      showFfmpegHelp: false,
    };
  }
  if (
    lower.includes("audio decode failed") ||
    lower.includes("failed to read audio container") ||
    lower.includes("unsupported audio codec") ||
    lower.includes("no audio samples decoded")
  ) {
    return {
      message: i18n._(
        msg({
          id: "library.error_details.invalid_audio",
          message: "Not a valid audio file.",
        }),
      ),
      showFfmpegHelp: true,
    };
  }
  if (lower.includes("ffmpeg")) {
    return {
      message: i18n._(
        msg({
          id: "library.error_details.ffmpeg_required",
          message: "FFmpeg required for video imports.",
        }),
      ),
      showFfmpegHelp: true,
    };
  }
  if (lower.includes("failed to create library folder")) {
    return {
      message: i18n._(
        msg({
          id: "library.error_details.create_storage_failed",
          message: "Couldn't create library storage.",
        }),
      ),
      showFfmpegHelp: false,
    };
  }
  if (lower.includes("failed to copy original file")) {
    return {
      message: i18n._(
        msg({
          id: "library.error_details.copy_original_failed",
          message: "Couldn't copy original file.",
        }),
      ),
      showFfmpegHelp: false,
    };
  }
  if (lower.includes("insufficient disk space")) {
    return {
      message: i18n._(
        msg({
          id: "library.error_details.insufficient_disk_space",
          message: "Not enough disk space.",
        }),
      ),
      showFfmpegHelp: false,
    };
  }

  return { message, showFfmpegHelp: false };
};
