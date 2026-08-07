import { useLingui } from "@lingui/react/macro";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  Warning as AlertTriangle,
  ArrowLeft,
  Check,
  CaretDown as ChevronDown,
  CaretLeft as ChevronLeft,
  CaretRight as ChevronRight,
  Copy,
  DotsThreeVertical,
  Funnel,
  Pause,
  PencilSimple as Pencil,
  Play,
  Plus,
  ArrowClockwise as RotateCw,
  MagnifyingGlass as Search,
  Trash as Trash2,
  UserPlus,
  Users,
  X,
} from "@phosphor-icons/react";
import LibraryRetranscribeModal from "./LibraryRetranscribeModal";
import {
  clampProgress,
  formatDuration,
  formatPlaybackRate,
  formatTimestamp,
  getLibraryErrorDetails,
  PLAYBACK_RATES,
  sanitizeFileName,
  shouldShowImportProgress,
  formatLibraryName,
} from "./library-utils";
import { resolveSpeechModelLabel } from "../../settings/models-queries";
import { useClickOutside } from "../../../shared/hooks/useClickOutside";
import { useCopyToClipboard } from "../../../shared/hooks/useCopyToClipboard";
import { IntelligencePixel } from "../../../shared/ui/IntelligencePixel";
import ToggleSwitch from "../../../shared/ui/ToggleSwitch";
import type {
  ExportFormat,
  LibraryItem,
  LibraryItemPatch,
  Speaker,
  SpeechModel,
  TranscriptSegment,
} from "../../../types";

const SPEAKER_COLORS = [
  "#7aa2f7",
  "#9ece6a",
  "#e0af68",
  "#f7768e",
  "#bb9af7",
  "#7dcfff",
];

const MAX_SPEAKERS = 16;

const SegmentWordsRow = ({
  tokens,
  activePosition,
}: {
  tokens: string[];
  activePosition: number;
}) => {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [underline, setUnderline] = useState<{
    x: number;
    y: number;
    width: number;
  } | null>(null);

  useLayoutEffect(() => {
    const active = containerRef.current?.querySelector<HTMLElement>(
      '[data-word-active="true"]',
    );
    if (!active) return;
    setUnderline({
      x: active.offsetLeft,
      y: active.offsetTop + active.offsetHeight - 2,
      width: active.offsetWidth,
    });
  }, [activePosition, tokens]);

  return (
    <span ref={containerRef} className="transcript-words select-text">
      {tokens.map((token, position) => (
        <Fragment key={position}>
          {position > 0 ? " " : null}
          <span
            data-word-active={position === activePosition || undefined}
            className={`transcript-word${
              position === activePosition ? " transcript-word-active" : ""
            }`}
          >
            {token}
          </span>
        </Fragment>
      ))}
      {underline ? (
        <span
          className="transcript-word-underline"
          aria-hidden="true"
          style={{
            transform: `translate(${underline.x}px, ${underline.y}px)`,
            width: underline.width,
            opacity: activePosition >= 0 ? 1 : 0,
          }}
        />
      ) : null}
    </span>
  );
};

const LibraryDetail = ({
  item,
  models,
  shiftHeld,
  followTimestamps,
  onFollowTimestampsChange,
  onClose,
  onDelete,
  onRetry,
  onCancel,
  onUpdate,
  onExport,
  availableTags,
}: {
  item: LibraryItem;
  models: SpeechModel[];
  shiftHeld: boolean;
  followTimestamps: boolean;
  onFollowTimestampsChange: (
    value: boolean | ((prev: boolean) => boolean),
  ) => void;
  onClose: () => void;
  onDelete: () => Promise<void>;
  onRetry: () => Promise<void>;
  onCancel: () => void;
  onUpdate: (patch: LibraryItemPatch) => Promise<LibraryItem>;
  onExport: (format: ExportFormat, outputPath: string) => Promise<void>;
  availableTags: string[];
}) => {
  const { t } = useLingui();
  const [nameDraft, setNameDraft] = useState(item.name);
  const [isEditingName, setIsEditingName] = useState(false);
  const [transcriptDraft, setTranscriptDraft] = useState(item.transcript ?? "");
  const [tagInput, setTagInput] = useState("");
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [showTimestamps, setShowTimestamps] = useState(
    item.show_timestamps && Boolean(item.segments?.length),
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const { copied: copyConfirmed, copy: copyTranscript } =
    useCopyToClipboard(1400);
  const [audioDuration, setAudioDuration] = useState(
    item.duration_seconds || 0,
  );
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [streamChunks, setStreamChunks] = useState<string[]>([]);
  const [showRetranscribe, setShowRetranscribe] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [renamingSpeakerId, setRenamingSpeakerId] = useState<string | null>(
    null,
  );
  const [speakerNameDraft, setSpeakerNameDraft] = useState("");
  const [speakerMenuSegment, setSpeakerMenuSegment] = useState<number | null>(
    null,
  );
  const [speakersMenuOpen, setSpeakersMenuOpen] = useState(false);
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const transcriptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptPending = useRef<string | null>(null);
  const transcriptSent = useRef<string | null>(null);
  const transcriptSaves = useRef(0);
  const transcriptSaveFailed = useRef(false);
  const transcriptChain = useRef<Promise<unknown>>(Promise.resolve());
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const speakerMenuRef = useRef<HTMLDivElement>(null);
  const speakersMenuRef = useRef<HTMLDivElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const playbackRateRef = useRef(1);
  const streamTranscriptRef = useRef(item.transcript ?? "");
  const scrubWasPlayingRef = useRef(false);
  const scrubValueRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const isScrubbingRef = useRef(false);
  const isPlayingRef = useRef(false);
  const lastTimestampNavRef = useRef(0);
  const transcriptAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const segmentsVirtuosoRef = useRef<VirtuosoHandle | null>(null);
  const streamVirtuosoRef = useRef<VirtuosoHandle | null>(null);
  const segmentsScrollerRef = useRef<HTMLElement | null>(null);
  const followScrollRafRef = useRef<number | null>(null);

  const modelLabel =
    resolveSpeechModelLabel(models, item.speech_model) ?? item.speech_model;
  const transcriptEditable = item.status.type === "complete";
  const transcriptAvailable =
    transcriptEditable && (item.transcript ?? "").trim().length > 0;
  const canShowTimestamps = !!item.segments && item.segments.length > 0;
  const speakers = useMemo(
    () =>
      (item.speakers ?? []).map((speaker, index) => ({
        ...speaker,
        color: speaker.color ?? SPEAKER_COLORS[index % SPEAKER_COLORS.length],
      })),
    [item.speakers],
  );
  const canAddSpeaker = speakers.length < MAX_SPEAKERS;
  const isBusy =
    item.status.type === "transcribing" ||
    item.status.type === "cancelling" ||
    item.status.type === "pending" ||
    item.status.type === "importing";
  const importStatusText =
    item.status.type === "importing"
      ? shouldShowImportProgress(item.status.progress)
        ? t({
            id: "library.modal.import_status.converting_progress",
            message: `Converting audio... ${Math.round(clampProgress(item.status.progress) * 100)}%`,
          })
        : t({
            id: "library.modal.import_status.converting",
            message: "Converting audio...",
          })
      : t({
          id: "library.modal.import_status.queued",
          message: "Queued for transcription...",
        });

  const createdAtLabel = useMemo(() => {
    const date = new Date(item.created_at);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }, [item.created_at]);

  const audioUrl = useMemo(
    () => convertFileSrc(item.audio_path),
    [item.audio_path],
  );

  const stopSeekLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const updateIsPlaying = useCallback((value: boolean) => {
    isPlayingRef.current = value;
    setIsPlaying(value);
  }, []);

  const updateIsScrubbing = useCallback((value: boolean) => {
    isScrubbingRef.current = value;
    setIsScrubbing(value);
  }, []);

  const releaseAudioSource = useCallback(() => {
    stopSeekLoop();
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    updateIsPlaying(false);
    return audio;
  }, [stopSeekLoop, updateIsPlaying]);

  const setPlaybackRateValue = useCallback((value: number) => {
    playbackRateRef.current = value;
    setPlaybackRate(value);
    if (audioRef.current) audioRef.current.playbackRate = value;
  }, []);

  const playAudio = useCallback(
    (audio: HTMLAudioElement) => {
      void audio.play().catch((err) => {
        console.error("Audio play error:", err);
        setAudioError(
          t({
            id: "library.modal.audio_unavailable",
            message: "Audio unavailable",
          }),
        );
        setAudioReady(false);
        updateIsPlaying(false);
        stopSeekLoop();
      });
    },
    [stopSeekLoop, t, updateIsPlaying],
  );

  const startSeekLoop = useCallback(() => {
    stopSeekLoop();
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        const playing = !audio.paused && !audio.ended;
        if (playing !== isPlayingRef.current) {
          isPlayingRef.current = playing;
          setIsPlaying(playing);
        }
        if (playing && !isScrubbingRef.current) {
          setAudioCurrentTime(audio.currentTime);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stopSeekLoop]);

  useEffect(() => {
    if (!isEditingName) {
      setNameDraft(item.name);
    }
  }, [isEditingName, item.name]);

  useEffect(() => {
    setShowTimestamps(item.show_timestamps && canShowTimestamps);
  }, [item.show_timestamps, canShowTimestamps]);

  useEffect(() => {
    stopSeekLoop();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    updateIsPlaying(false);
    updateIsScrubbing(false);
    setAudioReady(false);
    setAudioError(null);
    setAudioCurrentTime(0);
    setAudioDuration(item.duration_seconds || 0);
    scrubWasPlayingRef.current = false;
    scrubValueRef.current = null;

    const audio = new Audio(audioUrl);
    audio.preload = "auto";
    audio.playbackRate = playbackRateRef.current;

    const handleReady = () => {
      setAudioDuration(
        Number.isFinite(audio.duration)
          ? audio.duration
          : item.duration_seconds || 0,
      );
      setAudioReady(true);
    };
    const handleLoadError = () => {
      console.error("Audio load error:", audio.error);
      setAudioError(
        t({
          id: "library.modal.audio_unavailable",
          message: "Audio unavailable",
        }),
      );
      setAudioReady(false);
    };
    const handlePlay = () => {
      updateIsPlaying(true);
      startSeekLoop();
    };
    const handlePause = () => {
      updateIsPlaying(false);
      stopSeekLoop();
    };
    const handleEnded = () => {
      updateIsPlaying(false);
      stopSeekLoop();
      if (Number.isFinite(audio.duration)) {
        setAudioCurrentTime(audio.duration);
      }
    };
    const handleSeeked = () => {
      if (!isScrubbingRef.current) setAudioCurrentTime(audio.currentTime);
    };

    audio.addEventListener("canplay", handleReady);
    audio.addEventListener("error", handleLoadError);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("seeked", handleSeeked);
    audioRef.current = audio;
    audio.load();

    return () => {
      stopSeekLoop();
      audio.removeEventListener("canplay", handleReady);
      audio.removeEventListener("error", handleLoadError);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("seeked", handleSeeked);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (audioRef.current === audio) audioRef.current = null;
    };
  }, [
    audioUrl,
    item.duration_seconds,
    startSeekLoop,
    stopSeekLoop,
    updateIsPlaying,
    updateIsScrubbing,
  ]);

  const handlePlaybackRateStep = useCallback(
    (direction: -1 | 1) => {
      const currentIndex = PLAYBACK_RATES.indexOf(playbackRate);
      const safeIndex =
        currentIndex === -1 ? PLAYBACK_RATES.indexOf(1) : currentIndex;
      const nextIndex = Math.min(
        PLAYBACK_RATES.length - 1,
        Math.max(0, safeIndex + direction),
      );
      setPlaybackRateValue(PLAYBACK_RATES[nextIndex]);
    },
    [playbackRate, setPlaybackRateValue],
  );

  const handleRateScrubStart = useCallback(
    (
      event:
        React.MouseEvent<HTMLSpanElement> | React.TouchEvent<HTMLSpanElement>,
    ) => {
      event.preventDefault();
      const startX =
        "touches" in event ? event.touches[0].clientX : event.clientX;
      const startIndex = PLAYBACK_RATES.indexOf(playbackRateRef.current);
      const initialIndex =
        startIndex === -1 ? PLAYBACK_RATES.indexOf(1) : startIndex;

      const handleMove = (e: MouseEvent | TouchEvent) => {
        const currentX =
          "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
        const diffX = currentX - startX;
        const steps = Math.round(diffX / 15);

        const nextIndex = Math.min(
          PLAYBACK_RATES.length - 1,
          Math.max(0, initialIndex + steps),
        );

        if (PLAYBACK_RATES[nextIndex] !== playbackRateRef.current) {
          setPlaybackRateValue(PLAYBACK_RATES[nextIndex]);
        }
      };

      const handleEnd = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleEnd);
        window.removeEventListener("touchmove", handleMove);
        window.removeEventListener("touchend", handleEnd);
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleEnd);
      window.addEventListener("touchmove", handleMove, { passive: false });
      window.addEventListener("touchend", handleEnd);
    },
    [setPlaybackRateValue],
  );

  useEffect(() => {
    if (transcriptPending.current !== null || transcriptSaves.current > 0)
      return;
    setTranscriptDraft(item.transcript ?? "");
  }, [item.transcript]);

  useEffect(() => {
    if (item.status.type !== "transcribing") {
      setStreamChunks([]);
      streamTranscriptRef.current = item.transcript ?? "";
    }
  }, [item.status.type, item.transcript]);

  useEffect(() => {
    if (item.status.type !== "transcribing") return;
    const nextTranscript = item.transcript ?? "";
    const previousTranscript = streamTranscriptRef.current;
    if (!nextTranscript || nextTranscript === previousTranscript) return;

    if (nextTranscript.startsWith(previousTranscript)) {
      const appended = nextTranscript
        .slice(previousTranscript.length)
        .replace(/^\n+/, "");
      const cleaned = appended.trimStart();
      if (cleaned.trim().length > 0) {
        setStreamChunks((prev) => [...prev, cleaned]);
      }
    } else {
      const cleaned = nextTranscript.trim();
      setStreamChunks(cleaned.length > 0 ? [cleaned] : []);
    }

    streamTranscriptRef.current = nextTranscript;
  }, [item.status.type, item.transcript]);

  const writeTranscript = useCallback(() => {
    const written = transcriptPending.current;
    if (written === null) return;
    transcriptPending.current = null;
    transcriptSent.current = written;
    transcriptSaves.current += 1;
    transcriptChain.current = transcriptChain.current
      .then(() => onUpdateRef.current({ transcript: written }))
      .then(() => {
        transcriptSaveFailed.current = false;
      })
      .catch((err) => {
        console.error("failed to save transcript:", err);
        if (
          transcriptPending.current === null &&
          transcriptSent.current === written
        ) {
          transcriptPending.current = written;
        }
        if (transcriptSaveFailed.current) return;
        transcriptSaveFailed.current = true;
        invoke("debug_show_toast", {
          toastType: "error",
          message: t({
            id: "library.detail.transcript.save_failed",
            message:
              "Couldn't save this transcript. Your changes are still here.",
          }),
        }).catch(() => {});
      })
      .finally(() => {
        transcriptSaves.current -= 1;
        if (transcriptSaves.current === 0) transcriptSent.current = null;
      });
  }, []);

  useEffect(() => {
    if (!transcriptEditable) {
      transcriptPending.current = null;
      return;
    }
    const stored =
      transcriptSaves.current > 0 && transcriptSent.current !== null
        ? transcriptSent.current
        : (item.transcript ?? "");
    if (transcriptDraft === stored) {
      transcriptPending.current = null;
      return;
    }
    transcriptPending.current = transcriptDraft;
    transcriptTimer.current = setTimeout(() => {
      transcriptTimer.current = null;
      writeTranscript();
    }, 600);
    return () => {
      if (transcriptTimer.current) clearTimeout(transcriptTimer.current);
    };
  }, [transcriptDraft, transcriptEditable, item.transcript, writeTranscript]);

  useEffect(() => writeTranscript, [writeTranscript]);
  useClickOutside(tagMenuRef, () => setTagMenuOpen(false), tagMenuOpen);
  useClickOutside(exportMenuRef, () => setExportOpen(false), exportOpen);
  useClickOutside(overflowMenuRef, () => setOverflowOpen(false), overflowOpen);
  useClickOutside(
    speakerMenuRef,
    () => setSpeakerMenuSegment(null),
    speakerMenuSegment !== null,
  );
  useClickOutside(
    speakersMenuRef,
    () => {
      setSpeakersMenuOpen(false);
      setRenamingSpeakerId(null);
      setSpeakerNameDraft("");
    },
    speakersMenuOpen,
  );
  useClickOutside(
    filterMenuRef,
    () => setFilterMenuOpen(false),
    filterMenuOpen,
  );

  const handleNameCommit = async () => {
    const value = nameDraft.trim();
    if (!value || value === item.name) {
      setNameDraft(item.name);
      setIsEditingName(false);
      return;
    }
    await onUpdate({ name: value });
    setIsEditingName(false);
  };

  const handleAddTag = async (overrideTag?: string) => {
    const value = (overrideTag ?? tagInput).trim();
    if (!value) return;
    if (item.tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setTagInput("");
      return;
    }
    await onUpdate({ tags: [...item.tags, value] });
    setTagInput("");
  };

  const normalizedTagInput = tagInput.trim().toLowerCase();
  const filteredTagOptions = availableTags.filter((tag) => {
    const tagLower = tag.toLowerCase();
    if (item.tags.some((existing) => existing.toLowerCase() === tagLower)) {
      return false;
    }
    if (!normalizedTagInput) return true;
    return tagLower.includes(normalizedTagInput);
  });

  const handleRemoveTag = async (tag: string) => {
    await onUpdate({ tags: item.tags.filter((entry) => entry !== tag) });
  };

  const handleAddSpeaker = async () => {
    if (!canAddSpeaker) return null;
    const nextIndex = speakers.length + 1;
    const speaker: Speaker = {
      id: crypto.randomUUID(),
      name: t({
        id: "library.detail.speaker_default_name",
        message: `Speaker ${nextIndex}`,
      }),
      color: SPEAKER_COLORS[speakers.length % SPEAKER_COLORS.length],
    };
    await onUpdate({ speakers: [...speakers, speaker] });
    return speaker;
  };

  const handleRenameSpeaker = async (speakerId: string) => {
    const value = speakerNameDraft.trim();
    setRenamingSpeakerId(null);
    setSpeakerNameDraft("");
    if (!value) return;
    const next = speakers.map((speaker) =>
      speaker.id === speakerId ? { ...speaker, name: value } : speaker,
    );
    await onUpdate({ speakers: next });
  };

  const handleRemoveSpeaker = async (speakerId: string) => {
    if (speakerFilter === speakerId) setSpeakerFilter(null);
    const nextSpeakers = speakers.filter((entry) => entry.id !== speakerId);
    const patch: LibraryItemPatch = { speakers: nextSpeakers };
    if (item.segments?.some((segment) => segment.speaker_id === speakerId)) {
      patch.segments = item.segments.map((segment) =>
        segment.speaker_id === speakerId
          ? { ...segment, speaker_id: null }
          : segment,
      );
    }
    await onUpdate(patch);
  };

  const handleAssignSpeaker = async (
    segmentIndex: number,
    speakerId: string | null,
  ) => {
    setSpeakerMenuSegment(null);
    const segments = item.segments ?? [];
    if (!segments[segmentIndex]) return;
    const next = segments.map((segment, idx) =>
      idx === segmentIndex ? { ...segment, speaker_id: speakerId } : segment,
    );
    await onUpdate({ segments: next });
  };

  const speakerById = useMemo(() => {
    const map = new Map<string, Speaker>();
    for (const speaker of speakers) map.set(speaker.id, speaker);
    return map;
  }, [speakers]);

  const visibleSegments = useMemo(() => {
    const entries = (item.segments ?? []).map((segment, index) => ({
      segment,
      index,
    }));
    if (!speakerFilter) return entries;
    return entries.filter(
      (entry) => entry.segment.speaker_id === speakerFilter,
    );
  }, [item.segments, speakerFilter]);

  const handleExport = async (format: ExportFormat) => {
    setIsExporting(true);
    try {
      const ext = format;
      const safeName =
        sanitizeFileName(item.name || "transcript") || "transcript";
      const suggested = `${safeName}.${ext}`;
      const outputPath = await save({
        title: t({
          id: "library.modal.export.title",
          message: "Export transcription",
        }),
        defaultPath: suggested,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!outputPath) return;
      const finalPath = outputPath.toLowerCase().endsWith(`.${ext}`)
        ? outputPath
        : `${outputPath}.${ext}`;
      await onExport(format, finalPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Export failed:", message);
      const lower = message.toLowerCase();
      let toastMessage =
        message ||
        t({
          id: "library.modal.export.failed",
          message: "Export failed. Try again.",
        });
      if (lower.includes("no timestamp segments")) {
        toastMessage = t({
          id: "library.modal.export.no_timestamps",
          message:
            "This item doesn't have timestamps. Retranscribe with timestamps to export subtitles.",
        });
      } else if (lower.includes("failed to write export file")) {
        toastMessage = t({
          id: "library.modal.export.write_failed",
          message: "Couldn't write the export file. Try a different location.",
        });
      } else if (lower.includes("library item not found")) {
        toastMessage = t({
          id: "library.modal.export.item_not_found",
          message: "Couldn't find this library item. Try reopening it.",
        });
      }
      invoke("debug_show_toast", {
        toastType: "error",
        message: toastMessage,
      }).catch(() => {});
    } finally {
      setIsExporting(false);
      setExportOpen(false);
    }
  };

  const handleCopy = () => {
    if (transcriptDraft.trim()) copyTranscript(transcriptDraft);
  };

  const handleTogglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audioError || !audioReady) return;
    if (!audio.paused) {
      audio.pause();
    } else {
      playAudio(audio);
    }
  }, [audioError, audioReady, playAudio]);

  const handleScrubChange = (nextValue: string) => {
    const audio = audioRef.current;
    if (!audio || audioError || !audioReady) return;
    const nextTime = Number(nextValue);
    if (!Number.isFinite(nextTime)) return;
    scrubValueRef.current = nextTime;
    if (isScrubbing) {
      setAudioCurrentTime(nextTime);
      audio.currentTime = nextTime;
      return;
    }
    audio.currentTime = nextTime;
    setAudioCurrentTime(nextTime);
  };

  const handleScrubStart = () => {
    const audio = audioRef.current;
    if (!audio || audioError || !audioReady) return;
    scrubWasPlayingRef.current = !audio.paused;
    updateIsScrubbing(true);
    audio.pause();
  };

  const handleScrubEnd = () => {
    const audio = audioRef.current;
    if (!audio || audioError || !audioReady) return;
    updateIsScrubbing(false);
    if (
      typeof scrubValueRef.current === "number" &&
      Number.isFinite(scrubValueRef.current)
    ) {
      audio.currentTime = scrubValueRef.current;
      setAudioCurrentTime(scrubValueRef.current);
    }
    scrubValueRef.current = null;
    if (scrubWasPlayingRef.current) {
      playAudio(audio);
    }
    scrubWasPlayingRef.current = false;
  };

  const handleTimestampClick = (startMs: number) => {
    const audio = audioRef.current;
    if (!audio || audioError || !audioReady) return;
    const nextTime = Math.max(0, startMs / 1000);
    audio.currentTime = nextTime;
    setAudioCurrentTime(nextTime);
    if (audio.paused) {
      playAudio(audio);
    }
  };
  const scrubberMax = audioDuration > 0 ? audioDuration : 1;
  const scrubberValue = Math.min(audioCurrentTime, scrubberMax);
  const scrubberPercent =
    scrubberMax > 0 ? (scrubberValue / scrubberMax) * 100 : 0;
  const minPlaybackRate = PLAYBACK_RATES[0];
  const maxPlaybackRate = PLAYBACK_RATES[PLAYBACK_RATES.length - 1];
  const canDecreasePlaybackRate = playbackRate > minPlaybackRate;
  const canIncreasePlaybackRate = playbackRate < maxPlaybackRate;
  const showStreaming = item.status.type === "transcribing" && !showTimestamps;
  const showSegmentView = showTimestamps && canShowTimestamps;
  const followTimestampsActive = followTimestamps && showSegmentView;
  const normalizedSearchQuery = searchQuery.trim();
  const activeSegmentIndex = useMemo(() => {
    if (!showTimestamps || !canShowTimestamps) return -1;
    const targetMs = Math.max(0, Math.round(audioCurrentTime * 1000));
    const segments = item.segments ?? [];
    let match = -1;
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i].start_ms <= targetMs) {
        match = i;
        continue;
      }
      break;
    }
    return match;
  }, [audioCurrentTime, showTimestamps, canShowTimestamps, item.segments]);

  const itemWords = item.words ?? null;

  // Whisper word and segment clocks overlap and backtrack, so words are
  // assigned to rows by sequential text alignment, not by time. Rows that
  // fail to align (chunk seams, edited text) get null and fall back.
  const segmentWordStarts = useMemo(() => {
    const segments = item.segments ?? [];
    if (!itemWords?.length || !segments.length) return null;
    const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, "");
    const SCAN_AHEAD = 24;
    const starts: (number | null)[] = [];
    let pointer = 0;
    for (const segment of segments) {
      const tokenCount = segment.text
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
      const target = normalize(segment.text);
      let matched: number | null = null;
      for (let offset = 0; tokenCount > 0 && offset < SCAN_AHEAD; offset += 1) {
        const start = pointer + offset;
        if (start + tokenCount > itemWords.length) break;
        let joined = "";
        for (let i = start; i < start + tokenCount; i += 1) {
          joined += itemWords[i].text;
        }
        if (normalize(joined) === target) {
          matched = start;
          pointer = start + tokenCount;
          break;
        }
      }
      starts.push(matched);
    }
    return starts;
  }, [item.segments, itemWords]);

  const activeWordIndex = useMemo(() => {
    if (!showSegmentView || !itemWords?.length || activeSegmentIndex < 0) {
      return -1;
    }
    const wordStart = segmentWordStarts?.[activeSegmentIndex];
    const segment = (item.segments ?? [])[activeSegmentIndex];
    if (wordStart == null || !segment) return -1;
    const count = segment.text.trim().split(/\s+/).filter(Boolean).length;
    const targetMs = Math.max(0, Math.round(audioCurrentTime * 1000));
    let match = -1;
    const limit = Math.min(wordStart + count, itemWords.length);
    for (let i = wordStart; i < limit; i += 1) {
      if (itemWords[i].start_ms <= targetMs) match = i;
    }
    return match;
  }, [
    audioCurrentTime,
    showSegmentView,
    itemWords,
    activeSegmentIndex,
    segmentWordStarts,
    item.segments,
  ]);

  const renderSegmentWords = (
    segment: TranscriptSegment,
    segmentIndex: number,
  ) => {
    const wordStart = segmentWordStarts?.[segmentIndex];
    if (wordStart == null) return null;
    const tokens = segment.text.trim().split(/\s+/).filter(Boolean);
    const activePosition =
      activeWordIndex >= wordStart &&
      activeWordIndex < wordStart + tokens.length
        ? activeWordIndex - wordStart
        : -1;
    return <SegmentWordsRow tokens={tokens} activePosition={activePosition} />;
  };

  const segmentMatchIndexes = useMemo(() => {
    if (!normalizedSearchQuery || !showSegmentView) return [];
    const query = normalizedSearchQuery.toLowerCase();
    const matches: number[] = [];
    for (let i = 0; i < visibleSegments.length; i += 1) {
      if (visibleSegments[i].segment.text.toLowerCase().includes(query)) {
        matches.push(i);
      }
    }
    return matches;
  }, [normalizedSearchQuery, visibleSegments, showSegmentView]);

  const streamMatchIndexes = useMemo(() => {
    if (!normalizedSearchQuery || !showStreaming) return [];
    const query = normalizedSearchQuery.toLowerCase();
    const matches: number[] = [];
    for (let i = 0; i < streamChunks.length; i += 1) {
      if (streamChunks[i].toLowerCase().includes(query)) {
        matches.push(i);
      }
    }
    return matches;
  }, [normalizedSearchQuery, showStreaming, streamChunks]);

  const textMatchIndex = useMemo(() => {
    if (!normalizedSearchQuery || showSegmentView || showStreaming) return -1;
    const query = normalizedSearchQuery.toLowerCase();
    return transcriptDraft.toLowerCase().indexOf(query);
  }, [normalizedSearchQuery, showSegmentView, showStreaming, transcriptDraft]);

  const searchMatchLabel = useMemo(() => {
    if (!normalizedSearchQuery) return null;
    const indexed = (matches: number[]) =>
      `${matches.length ? Math.min(activeSearchIndex, matches.length - 1) + 1 : 0}/${matches.length}`;
    if (showSegmentView) return indexed(segmentMatchIndexes);
    if (showStreaming) return indexed(streamMatchIndexes);
    const query = normalizedSearchQuery.toLowerCase();
    const text = transcriptDraft.toLowerCase();
    let count = 0;
    let cursor = text.indexOf(query);
    while (cursor !== -1) {
      count += 1;
      cursor = text.indexOf(query, cursor + query.length);
    }
    return String(count);
  }, [
    normalizedSearchQuery,
    showSegmentView,
    showStreaming,
    segmentMatchIndexes,
    streamMatchIndexes,
    activeSearchIndex,
    transcriptDraft,
  ]);

  const activeSegmentMatch = segmentMatchIndexes.length
    ? segmentMatchIndexes[
        Math.min(activeSearchIndex, segmentMatchIndexes.length - 1)
      ]
    : -1;
  const activeStreamMatch = streamMatchIndexes.length
    ? streamMatchIndexes[
        Math.min(activeSearchIndex, streamMatchIndexes.length - 1)
      ]
    : -1;

  const renderHighlightedText = useCallback(
    (text: string, isActive: boolean) => {
      if (!normalizedSearchQuery) return text;
      const query = normalizedSearchQuery.toLowerCase();
      const lower = text.toLowerCase();
      const nodes: Array<string | ReactNode> = [];
      let startIndex = 0;
      let matchIndex = lower.indexOf(query);
      let matchCount = 0;
      if (matchIndex === -1) return text;
      while (matchIndex !== -1) {
        if (matchIndex > startIndex) {
          nodes.push(text.slice(startIndex, matchIndex));
        }
        const matchText = text.slice(matchIndex, matchIndex + query.length);
        nodes.push(
          <mark
            key={`${matchIndex}-${matchCount}`}
            className={`transcript-search-hit${isActive ? " transcript-search-hit-active" : ""}`}
          >
            {matchText}
          </mark>,
        );
        startIndex = matchIndex + query.length;
        matchIndex = lower.indexOf(query, startIndex);
        matchCount += 1;
      }
      if (startIndex < text.length) {
        nodes.push(text.slice(startIndex));
      }
      return nodes;
    },
    [normalizedSearchQuery],
  );

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setActiveSearchIndex(0);
  };

  const handleSearchNavigate = useCallback(
    (direction: number) => {
      if (!normalizedSearchQuery) return;
      if (showSegmentView && segmentMatchIndexes.length > 0) {
        setActiveSearchIndex(
          (prev) =>
            (prev + direction + segmentMatchIndexes.length) %
            segmentMatchIndexes.length,
        );
        return;
      }
      if (showStreaming && streamMatchIndexes.length > 0) {
        setActiveSearchIndex(
          (prev) =>
            (prev + direction + streamMatchIndexes.length) %
            streamMatchIndexes.length,
        );
      }
    },
    [
      normalizedSearchQuery,
      showSegmentView,
      showStreaming,
      segmentMatchIndexes,
      streamMatchIndexes,
    ],
  );

  const handleTimestampStep = useCallback(
    (direction: number) => {
      if (!showSegmentView || visibleSegments.length === 0) return;
      const currentPos = visibleSegments.findIndex(
        (entry) => entry.index === activeSegmentIndex,
      );
      let nextPos;
      if (currentPos < 0) {
        nextPos = direction > 0 ? 0 : visibleSegments.length - 1;
      } else {
        nextPos = Math.max(
          0,
          Math.min(visibleSegments.length - 1, currentPos + direction),
        );
      }
      if (nextPos === currentPos) return;
      handleTimestampClick(visibleSegments[nextPos].segment.start_ms);
    },
    [
      activeSegmentIndex,
      visibleSegments,
      showSegmentView,
      handleTimestampClick,
    ],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      const isTextInput =
        tag === "input" || tag === "textarea" || target?.isContentEditable;
      const isInteractiveElement =
        isTextInput ||
        tag === "button" ||
        tag === "a" ||
        tag === "select" ||
        (tag === "input" &&
          (target?.getAttribute("type") === "checkbox" ||
            target?.getAttribute("type") === "radio")) ||
        target?.getAttribute("role") === "button" ||
        target?.getAttribute("role") === "link" ||
        target?.getAttribute("role") === "menuitem";

      if (event.key === "Escape") {
        event.preventDefault();
        if (showDeleteConfirm) {
          setShowDeleteConfirm(false);
        } else {
          onClose();
        }
        return;
      }

      if (event.key === " ") {
        if (isInteractiveElement) return;
        event.preventDefault();
        handleTogglePlayback();
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (!showSegmentView || isTextInput) return;
      const now = performance.now();
      if (now - lastTimestampNavRef.current < 140) return;
      lastTimestampNavRef.current = now;
      event.preventDefault();
      handleTimestampStep(event.key === "ArrowDown" ? 1 : -1);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleTimestampStep,
    handleTogglePlayback,
    onClose,
    showDeleteConfirm,
    showSegmentView,
  ]);

  useEffect(() => {
    if (!normalizedSearchQuery) return;
    if (showSegmentView) {
      if (segmentMatchIndexes.length === 0) return;
      const targetIndex =
        segmentMatchIndexes[
          Math.min(activeSearchIndex, segmentMatchIndexes.length - 1)
        ];
      segmentsVirtuosoRef.current?.scrollToIndex({
        index: targetIndex,
        align: "center",
        behavior: "smooth",
      });
      return;
    }
    if (showStreaming) {
      if (streamMatchIndexes.length === 0) return;
      const targetIndex =
        streamMatchIndexes[
          Math.min(activeSearchIndex, streamMatchIndexes.length - 1)
        ];
      streamVirtuosoRef.current?.scrollToIndex({
        index: targetIndex,
        align: "center",
        behavior: "smooth",
      });
      return;
    }
    if (textMatchIndex >= 0 && transcriptAreaRef.current) {
      const endIndex = textMatchIndex + normalizedSearchQuery.length;
      transcriptAreaRef.current.focus();
      transcriptAreaRef.current.setSelectionRange(textMatchIndex, endIndex);
    }
  }, [
    normalizedSearchQuery,
    showSegmentView,
    showStreaming,
    segmentMatchIndexes,
    streamMatchIndexes,
    activeSearchIndex,
    textMatchIndex,
  ]);

  const stopFollowScroll = useCallback(() => {
    if (followScrollRafRef.current !== null) {
      cancelAnimationFrame(followScrollRafRef.current);
      followScrollRafRef.current = null;
    }
  }, []);

  const animateFollowScroll = useCallback(
    (target: number) => {
      const scroller = segmentsScrollerRef.current;
      if (!scroller) return;
      stopFollowScroll();
      const start = scroller.scrollTop;
      const delta = target - start;
      if (Math.abs(delta) < 1) return;
      // Distance-based duration so short hops glide and long jumps stay quick.
      const duration = Math.min(900, Math.max(450, Math.abs(delta) * 6));
      const startedAt = performance.now();
      const ease = (p: number) =>
        p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        scroller.scrollTop = start + delta * ease(progress);
        followScrollRafRef.current =
          progress < 1 ? requestAnimationFrame(tick) : null;
      };
      followScrollRafRef.current = requestAnimationFrame(tick);
    },
    [stopFollowScroll],
  );

  useEffect(() => {
    if (!followTimestampsActive || activeSegmentIndex < 0) return;
    const visiblePos = visibleSegments.findIndex(
      (entry) => entry.index === activeSegmentIndex,
    );
    if (visiblePos < 0) return;
    const scroller = segmentsScrollerRef.current;
    const row = scroller?.querySelector<HTMLElement>(
      `[data-index="${visiblePos}"]`,
    );
    if (!scroller || !row) {
      segmentsVirtuosoRef.current?.scrollToIndex({
        index: visiblePos,
        align: "center",
        behavior: "smooth",
      });
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const target =
      scroller.scrollTop +
      (rowRect.top - scrollerRect.top) -
      (scroller.clientHeight - rowRect.height) / 2;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    animateFollowScroll(Math.min(maxScroll, Math.max(0, target)));
  }, [
    activeSegmentIndex,
    followTimestampsActive,
    visibleSegments,
    animateFollowScroll,
  ]);

  useEffect(() => {
    const scroller = segmentsScrollerRef.current;
    if (!scroller) return;
    const cancel = () => stopFollowScroll();
    scroller.addEventListener("wheel", cancel, { passive: true });
    scroller.addEventListener("touchmove", cancel, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", cancel);
      scroller.removeEventListener("touchmove", cancel);
      stopFollowScroll();
    };
  }, [showSegmentView, stopFollowScroll]);

  const renderSpeakerChip = (segment: TranscriptSegment, idx: number) => {
    const speaker = segment.speaker_id
      ? speakerById.get(segment.speaker_id)
      : null;
    const menuOpen = speakerMenuSegment === idx;
    return (
      <div className="relative max-w-full">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setSpeakerMenuSegment(menuOpen ? null : idx);
          }}
          title={
            speaker
              ? speaker.name
              : t({
                  id: "library.detail.speaker.unassigned",
                  message: "Assign",
                })
          }
          aria-label={
            speaker
              ? speaker.name
              : t({
                  id: "library.detail.speaker.unassigned",
                  message: "Assign",
                })
          }
          className={`flex items-center justify-center p-1 -m-1 transition-opacity hover:opacity-80 ${
            speaker
              ? ""
              : menuOpen
                ? "opacity-100"
                : "opacity-0 group-hover/seg:opacity-60 focus:opacity-60"
          }`}
        >
          <span
            className={`inline-block h-2 w-2 rounded-full shrink-0 ${
              speaker ? "" : "border border-[var(--color-text-muted)]"
            }`}
            style={{
              backgroundColor: speaker?.color ?? "transparent",
            }}
            aria-hidden="true"
          />
        </button>
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              ref={speakerMenuRef}
              initial={{ opacity: 0, scale: 0.98, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: -4 }}
              transition={{ duration: 0.12 }}
              className="absolute left-0 top-full mt-1 z-[120] w-36 rounded-md border border-border-secondary/80 bg-surface-overlay shadow-lg shadow-black/40 overflow-hidden"
            >
              {speakers.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleAssignSpeaker(idx, entry.id);
                  }}
                  className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 ui-text-meta font-medium text-content-secondary hover:bg-surface-elevated/70 hover:text-content-primary transition-colors"
                >
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: entry.color ?? undefined }}
                    aria-hidden="true"
                  />
                  {entry.name}
                </button>
              ))}
              {segment.speaker_id && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleAssignSpeaker(idx, null);
                  }}
                  className="w-full text-left px-2.5 py-1.5 ui-text-meta text-content-muted hover:bg-surface-elevated/70 hover:text-content-primary transition-colors border-t border-border-primary"
                >
                  {t({
                    id: "library.detail.speaker.clear",
                    message: "Clear speaker",
                  })}
                </button>
              )}
              <button
                type="button"
                onClick={async (event) => {
                  event.stopPropagation();
                  const created = await handleAddSpeaker();
                  if (created) await handleAssignSpeaker(idx, created.id);
                }}
                disabled={!canAddSpeaker}
                className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 ui-text-meta text-content-muted hover:bg-surface-elevated/70 hover:text-content-primary transition-colors border-t border-border-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-muted"
              >
                <UserPlus size={11} />
                {t({
                  id: "library.detail.assign_new_speaker",
                  message: "Assign new speaker",
                })}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[var(--color-border-primary)] px-5 pt-1.5 pb-2">
        <div className="grid grid-cols-3 items-center gap-x-4 gap-y-1">
          <div className="col-start-1 row-start-1 flex items-center gap-1.5 min-w-0">
            <button
              onClick={onClose}
              className="flex items-center justify-center rounded-md p-1.5 -ml-1.5 text-content-muted hover:text-content-primary hover:bg-surface-surface transition-colors"
              aria-label={t({
                id: "library.detail.back",
                message: "Back to library",
              })}
            >
              <ArrowLeft size={15} />
            </button>

            {isEditingName ? (
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <input
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={handleNameCommit}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleNameCommit();
                    }
                  }}
                  className="min-w-0 flex-1 max-w-md bg-transparent border-b border-[var(--color-border-primary)] px-1 py-0.5 ui-text-body-lg font-semibold text-content-primary focus:border-[var(--color-border-hover)] outline-hidden"
                  autoFocus
                />
                <button
                  onClick={handleNameCommit}
                  className="text-content-muted hover:text-content-primary"
                >
                  <Check size={12} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 min-w-0 flex-1 group">
                <h2 className="ui-text-body-lg font-semibold text-content-primary truncate">
                  {formatLibraryName(item.name)}
                </h2>
                <button
                  onClick={() => setIsEditingName(true)}
                  className="opacity-0 group-hover:opacity-100 text-content-muted hover:text-content-primary transition-opacity shrink-0"
                >
                  <Pencil size={11} />
                </button>
              </div>
            )}
          </div>

          <div className="col-start-2 row-start-2 flex items-center justify-center gap-1.5">
            <div className="relative flex w-full max-w-lg items-center gap-2 px-1 py-0.5 border-b border-[var(--color-border-secondary)] focus-within:border-[var(--color-border-hover)] transition-colors">
              <Search
                size={12}
                className="text-content-disabled shrink-0"
                aria-hidden="true"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => handleSearchChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleSearchNavigate(event.shiftKey ? -1 : 1);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    handleSearchChange("");
                  }
                }}
                placeholder={t({
                  id: "library.modal.search.placeholder",
                  message: "Search transcript...",
                })}
                aria-label={t({
                  id: "library.modal.search.aria",
                  message: "Search transcript",
                })}
                className="bg-transparent ui-text-label text-content-secondary placeholder-content-disabled outline-hidden w-full"
              />
              {searchMatchLabel !== null && (
                <span className="ui-text-micro tabular-nums text-content-disabled shrink-0 whitespace-nowrap">
                  {searchMatchLabel}
                </span>
              )}
              {searchQuery && (
                <button
                  onClick={() => handleSearchChange("")}
                  aria-label={t({
                    id: "library.modal.search.clear",
                    message: "Clear search",
                  })}
                  className="text-content-disabled hover:text-content-muted transition-colors shrink-0"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>

            <div className="relative shrink-0" ref={filterMenuRef}>
              <button
                type="button"
                onClick={() => setFilterMenuOpen((prev) => !prev)}
                aria-label={t({
                  id: "library.detail.filter.aria",
                  message: "Filter by speaker",
                })}
                title={t({
                  id: "library.detail.filter.aria",
                  message: "Filter by speaker",
                })}
                className={`flex items-center justify-center rounded-md p-1 transition-colors hover:bg-surface-surface ${
                  speakerFilter
                    ? "text-[var(--color-cloud-dark)]"
                    : "text-content-disabled hover:text-content-primary"
                }`}
              >
                <Funnel size={13} weight={speakerFilter ? "fill" : "regular"} />
              </button>
              <AnimatePresence>
                {filterMenuOpen && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: -4 }}
                    transition={{ duration: 0.12 }}
                    className="absolute left-0 top-full mt-1 z-[120] w-40 rounded-md border border-border-secondary/80 bg-surface-overlay shadow-lg shadow-black/40 overflow-hidden"
                  >
                    {speakers.length === 0 ? (
                      <div className="px-2.5 py-2 ui-text-micro text-content-muted">
                        {t({
                          id: "library.detail.filter.no_speakers",
                          message: "No speakers yet",
                        })}
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setSpeakerFilter(null);
                            setFilterMenuOpen(false);
                          }}
                          className={`w-full text-left px-2.5 py-1.5 ui-text-meta font-medium hover:bg-surface-elevated/70 transition-colors ${
                            speakerFilter === null
                              ? "text-content-primary"
                              : "text-content-secondary hover:text-content-primary"
                          }`}
                        >
                          {t({
                            id: "library.detail.filter.all",
                            message: "All speakers",
                          })}
                        </button>
                        {speakers.map((speaker) => (
                          <button
                            key={speaker.id}
                            type="button"
                            onClick={() => {
                              setSpeakerFilter(speaker.id);
                              setFilterMenuOpen(false);
                            }}
                            className={`w-full flex items-center gap-2 text-left px-2.5 py-1.5 ui-text-meta font-medium hover:bg-surface-elevated/70 transition-colors ${
                              speakerFilter === speaker.id
                                ? "text-content-primary"
                                : "text-content-secondary hover:text-content-primary"
                            }`}
                          >
                            <span
                              className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                              style={{
                                backgroundColor: speaker.color ?? undefined,
                              }}
                              aria-hidden="true"
                            />
                            <span className="truncate">{speaker.name}</span>
                            {speakerFilter === speaker.id && (
                              <Check size={10} className="ml-auto shrink-0" />
                            )}
                          </button>
                        ))}
                      </>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="col-start-3 row-start-1 flex items-center justify-end gap-1">
            <button
              onClick={handleCopy}
              disabled={!transcriptDraft.trim()}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 ui-text-meta disabled:opacity-50 transition-colors ${
                copyConfirmed
                  ? "ui-color-success bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)]"
                  : "text-content-secondary hover:text-content-primary hover:bg-surface-surface"
              }`}
            >
              {copyConfirmed ? <Check size={10} /> : <Copy size={10} />}
              <span className="inline-block min-w-[38px] text-left">
                {copyConfirmed
                  ? t({
                      id: "library.modal.copy.copied",
                      message: "Copied",
                    })
                  : t({
                      id: "library.modal.copy",
                      message: "Copy",
                    })}
              </span>
            </button>

            <div className="relative" ref={exportMenuRef}>
              <button
                onClick={() => setExportOpen(!exportOpen)}
                disabled={isExporting || !transcriptAvailable}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1 ui-text-meta text-content-secondary hover:text-content-primary hover:bg-surface-surface disabled:opacity-50"
              >
                {t({
                  id: "library.modal.export",
                  message: "Export",
                })}
                <ChevronDown size={10} />
              </button>
              <AnimatePresence>
                {exportOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    transition={{ duration: 0.1 }}
                    className="absolute right-0 top-full mt-1 w-36 rounded-lg border border-[var(--color-border-secondary)] bg-[var(--color-bg-overlay)] shadow-xl overflow-hidden z-[120]"
                  >
                    {(["txt", "md", "srt", "vtt"] as ExportFormat[]).map(
                      (format) => {
                        const requiresSegments =
                          format === "srt" || format === "vtt";
                        const disabled =
                          requiresSegments &&
                          !(item.segments && item.segments.length);
                        return (
                          <button
                            key={format}
                            onClick={() => handleExport(format)}
                            disabled={disabled}
                            className="w-full px-3 py-1.5 text-left ui-text-meta text-content-secondary hover:bg-surface-overlay disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {format.toUpperCase()}
                          </button>
                        );
                      },
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="relative" ref={overflowMenuRef}>
              <button
                onClick={() => setOverflowOpen((prev) => !prev)}
                className="flex items-center justify-center rounded-md p-1.5 text-content-muted hover:text-content-primary hover:bg-surface-surface transition-colors"
                aria-label={t({
                  id: "library.detail.more_actions",
                  message: "More actions",
                })}
              >
                <DotsThreeVertical size={14} weight="bold" />
              </button>
              <AnimatePresence>
                {overflowOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    transition={{ duration: 0.1 }}
                    className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-[var(--color-border-secondary)] bg-[var(--color-bg-overlay)] shadow-xl overflow-hidden z-[120]"
                  >
                    <button
                      onClick={() => {
                        setOverflowOpen(false);
                        setShowRetranscribe(true);
                      }}
                      disabled={isBusy}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-left ui-text-meta text-content-secondary hover:bg-surface-overlay hover:text-content-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <RotateCw size={11} />
                      {t({
                        id: "library.modal.retranscribe",
                        message: "Retranscribe",
                      })}
                    </button>
                    {isBusy && (
                      <button
                        onClick={() => {
                          setOverflowOpen(false);
                          onCancel();
                        }}
                        className="w-full px-3 py-1.5 text-left ui-text-meta text-content-secondary hover:bg-surface-overlay hover:text-content-primary transition-colors"
                      >
                        {t({
                          id: "library.modal.cancel",
                          message: "Cancel",
                        })}
                      </button>
                    )}
                    {item.status.type === "error" && (
                      <button
                        onClick={() => {
                          setOverflowOpen(false);
                          Promise.resolve(onRetry()).catch((err) => {
                            console.error("failed to retry:", err);
                          });
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left ui-text-meta text-content-secondary hover:bg-surface-overlay hover:text-content-primary transition-colors"
                      >
                        <RotateCw size={11} />
                        {t({
                          id: "library.modal.retry",
                          message: "Retry",
                        })}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setOverflowOpen(false);
                        setShowDeleteConfirm(true);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-left ui-text-meta ui-color-error-soft hover:bg-[var(--color-error)]/10 transition-colors border-t border-border-primary"
                    >
                      <Trash2 size={11} />
                      {t({
                        id: "library.modal.delete",
                        message: "Delete",
                      })}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="col-start-1 row-start-2 flex items-center min-w-0 pl-[30px] ui-text-meta text-content-disabled">
            <span className="whitespace-nowrap">{modelLabel}</span>
          </div>

          <div className="col-start-1 row-start-3 flex items-center gap-2 min-w-0 pl-[30px] ui-text-meta text-content-disabled">
            {createdAtLabel && (
              <span className="whitespace-nowrap">{createdAtLabel}</span>
            )}
            {createdAtLabel && audioDuration > 0 && (
              <span className="opacity-40" aria-hidden="true">
                ·
              </span>
            )}
            {audioDuration > 0 && (
              <span className="tabular-nums">
                {formatDuration(audioDuration)}
              </span>
            )}
          </div>

          <div className="col-start-3 row-start-3 flex items-center justify-end gap-2 min-w-0">
            {item.tags.slice(0, 3).map((tag, idx) => (
              <span
                key={`${tag}-${idx}`}
                onClick={() => {
                  if (shiftHeld) {
                    handleRemoveTag(tag);
                  }
                }}
                title={
                  shiftHeld
                    ? t({
                        id: "library.modal.tags.remove",
                        message: `Remove ${tag}`,
                      })
                    : undefined
                }
                className={`inline-flex items-center cursor-pointer ui-text-meta transition-colors duration-100 ease-out whitespace-nowrap text-content-secondary hover:text-content-primary ${
                  shiftHeld ? "hover:!text-red-500 hover:line-through" : ""
                }`}
              >
                <span className="opacity-40 mr-[1px]">#</span>
                <span>{tag.length > 12 ? `${tag.slice(0, 12)}...` : tag}</span>
              </span>
            ))}
            {item.tags.length > 3 && (
              <button
                type="button"
                onClick={() => setTagMenuOpen(true)}
                className="ui-text-meta text-content-muted hover:text-content-primary transition-colors shrink-0"
              >
                +{item.tags.length - 3}
              </button>
            )}
            <div ref={tagMenuRef} className="relative flex items-center">
              <button
                type="button"
                onClick={() => setTagMenuOpen((prev) => !prev)}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 ui-text-meta text-content-muted hover:text-content-primary hover:bg-surface-surface transition-colors"
                aria-label={t({
                  id: "library.detail.tags.add",
                  message: "Add tag",
                })}
              >
                <Plus size={11} />
                {t({
                  id: "library.detail.tags.label",
                  message: "Tag",
                })}
              </button>
              <AnimatePresence>
                {tagMenuOpen && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: -4 }}
                    transition={{ duration: 0.12 }}
                    className="absolute right-0 top-full mt-1 z-[120] w-40 rounded-md border border-border-secondary/80 bg-surface-overlay shadow-lg shadow-black/40 overflow-hidden"
                  >
                    <div className="px-2 py-1.5 border-b border-border-primary">
                      <input
                        value={tagInput}
                        onChange={(event) => setTagInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            handleAddTag();
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setTagMenuOpen(false);
                            setTagInput("");
                          }
                        }}
                        placeholder={t({
                          id: "library.modal.tags.new_tag",
                          message: "New tag...",
                        })}
                        className="w-full bg-transparent ui-text-meta text-content-secondary outline-hidden placeholder:text-content-disabled"
                        autoFocus
                      />
                    </div>
                    {item.tags.length > 0 && (
                      <div className="max-h-28 overflow-y-auto border-b border-border-primary">
                        {item.tags.map((tag) => (
                          <div
                            key={tag}
                            className="flex items-center justify-between gap-2 px-2.5 py-1 group/tagrow"
                          >
                            <span className="ui-text-meta text-content-secondary truncate">
                              <span className="opacity-40">#</span>
                              {tag}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleRemoveTag(tag)}
                              aria-label={t({
                                id: "library.modal.tags.remove",
                                message: `Remove ${tag}`,
                              })}
                              className="opacity-0 group-hover/tagrow:opacity-100 text-content-disabled hover:text-red-500 transition-opacity shrink-0"
                            >
                              <X size={10} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="max-h-36 overflow-y-auto">
                      {filteredTagOptions.length > 0 ? (
                        filteredTagOptions.map((tag, index) => (
                          <button
                            key={`tag-option-${index}-${tag || "empty"}`}
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => handleAddTag(tag)}
                            className="w-full text-left px-2.5 py-1.5 ui-text-meta font-medium text-content-secondary hover:bg-surface-elevated/70 hover:text-content-primary transition-colors"
                          >
                            {tag}
                          </button>
                        ))
                      ) : (
                        <div className="px-2.5 py-2 ui-text-micro text-content-muted">
                          {availableTags.length === 0
                            ? t({
                                id: "library.modal.tags.no_tags_yet",
                                message: "No tags yet",
                              })
                            : t({
                                id: "library.modal.tags.no_other_tags",
                                message: "No other tags",
                              })}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div
              className="h-3.5 w-px bg-[var(--color-border-primary)] mx-1"
              aria-hidden="true"
            />
            <div className="relative" ref={speakersMenuRef}>
              <button
                type="button"
                onClick={() => setSpeakersMenuOpen((prev) => !prev)}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 ui-text-meta text-content-secondary hover:text-content-primary hover:bg-surface-surface transition-colors"
              >
                <Users size={11} />
                {t({
                  id: "library.detail.speakers",
                  message: "Speakers",
                })}
                <span className="text-content-disabled tabular-nums">
                  {speakers.length}
                </span>
                <ChevronDown
                  size={10}
                  className={`transition-transform duration-150 ${speakersMenuOpen ? "rotate-180" : ""}`}
                />
              </button>
              <AnimatePresence>
                {speakersMenuOpen && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: -4 }}
                    transition={{ duration: 0.12 }}
                    className="absolute right-0 top-full mt-1 z-[120] w-48 rounded-md border border-border-secondary/80 bg-surface-overlay shadow-lg shadow-black/40 overflow-hidden"
                  >
                    {speakers.map((speaker) => (
                      <div
                        key={speaker.id}
                        className="flex items-center gap-2 px-2.5 py-1.5 group/speaker"
                      >
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                          style={{
                            backgroundColor: speaker.color ?? undefined,
                          }}
                          aria-hidden="true"
                        />
                        {renamingSpeakerId === speaker.id ? (
                          <input
                            value={speakerNameDraft}
                            onChange={(event) =>
                              setSpeakerNameDraft(event.target.value)
                            }
                            onBlur={() => handleRenameSpeaker(speaker.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                handleRenameSpeaker(speaker.id);
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                setRenamingSpeakerId(null);
                                setSpeakerNameDraft("");
                              }
                            }}
                            className="flex-1 min-w-0 bg-transparent border-b border-[var(--color-border-primary)] px-0.5 py-0 ui-text-meta font-medium text-content-primary focus:border-[var(--color-border-hover)] outline-hidden"
                            autoFocus
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setRenamingSpeakerId(speaker.id);
                              setSpeakerNameDraft(speaker.name);
                            }}
                            title={t({
                              id: "library.detail.speaker.rename",
                              message: "Click to rename",
                            })}
                            className="flex-1 min-w-0 flex items-center gap-1.5 text-left ui-text-meta font-medium text-content-secondary hover:text-content-primary transition-colors border-b border-transparent px-0.5 py-0"
                          >
                            <span className="truncate">{speaker.name}</span>
                            <Pencil
                              size={10}
                              className="shrink-0 text-content-disabled opacity-0 group-hover/speaker:opacity-100 transition-opacity"
                              aria-hidden="true"
                            />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemoveSpeaker(speaker.id)}
                          aria-label={t({
                            id: "library.detail.speaker.remove",
                            message: `Remove ${speaker.name}`,
                          })}
                          className="opacity-0 group-hover/speaker:opacity-100 text-content-disabled hover:text-red-500 transition-opacity shrink-0"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => handleAddSpeaker()}
                      disabled={!canAddSpeaker}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left ui-text-meta text-content-muted hover:bg-surface-elevated/70 hover:text-content-primary transition-colors border-t border-border-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-muted"
                    >
                      <UserPlus size={11} />
                      {t({
                        id: "library.detail.add_speaker",
                        message: "Add speaker",
                      })}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden px-4">
        {item.status.type === "error" ? (
          <div className="flex h-full items-center justify-center">
            {(() => {
              const details = getLibraryErrorDetails(item.status.message);
              return (
                <div className="max-w-[280px] rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-2 ui-color-error-tint">
                    <AlertTriangle size={14} />
                    <span className="ui-text-label font-medium">
                      {t({
                        id: "library.modal.import_failed",
                        message: "Import failed",
                      })}
                    </span>
                  </div>
                  <p className="mt-2 ui-text-meta leading-[14px] ui-color-error-tint select-text cursor-text">
                    {details.message}
                  </p>
                  {details.showFfmpegHelp && (
                    <button
                      type="button"
                      onClick={() =>
                        invoke("open_ffmpeg_install").catch(() => {})
                      }
                      className="mt-2 ui-text-meta ui-color-error-faint underline decoration-red-400/60 ui-hover-error-50"
                    >
                      {t({
                        id: "library.modal.ffmpeg_help",
                        message: "FFmpeg Help",
                      })}
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="relative h-full mx-auto w-full max-w-3xl">
            <div
              className="pointer-events-none absolute left-0 right-3 bottom-0 h-6 z-10"
              style={{
                background:
                  "linear-gradient(to top, var(--color-bg-tertiary), transparent)",
              }}
              aria-hidden="true"
            />
            {showSegmentView ? (
              <Virtuoso
                ref={segmentsVirtuosoRef}
                scrollerRef={(ref) => {
                  segmentsScrollerRef.current = (ref as HTMLElement) ?? null;
                }}
                style={{ height: "100%" }}
                data={visibleSegments}
                overscan={200}
                className="custom-scrollbar ui-text-body text-content-secondary leading-relaxed"
                computeItemKey={(
                  _index: number,
                  entry: { segment: TranscriptSegment; index: number },
                ) => `${entry.segment.start_ms}-${entry.index}`}
                components={{
                  Header: () => <div className="h-2" />,
                  Footer: () => <div className="h-2" />,
                }}
                itemContent={(idx, entry) => {
                  const segment = entry.segment;
                  const isActive = entry.index === activeSegmentIndex;
                  const wordSpans =
                    isActive && !normalizedSearchQuery
                      ? renderSegmentWords(segment, entry.index)
                      : null;
                  return (
                    <div className="pb-1.5 pr-4">
                      <div
                        className={`group/seg grid w-full grid-cols-[auto_1fr] gap-3 rounded-md px-2 py-1 select-none transcript-segment${
                          isActive ? " transcript-segment-active" : ""
                        }`}
                      >
                        <div className="relative flex items-center gap-1.5 self-start">
                          <span
                            className="transcript-segment-time text-content-disabled font-mono ui-text-label pt-0.5 select-none cursor-pointer hover:text-content-primary transition-colors"
                            role="button"
                            tabIndex={0}
                            onClick={() =>
                              handleTimestampClick(segment.start_ms)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                handleTimestampClick(segment.start_ms);
                              }
                            }}
                          >
                            {formatTimestamp(segment.start_ms)}
                          </span>
                          {renderSpeakerChip(segment, entry.index)}
                        </div>
                        <div className="min-w-0 select-none w-fit">
                          <span className="select-text">
                            {wordSpans ??
                              renderHighlightedText(
                                segment.text,
                                idx === activeSegmentMatch,
                              )}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                }}
              />
            ) : showStreaming ? (
              streamChunks.length === 0 ? (
                <div className="flex flex-col h-full w-full items-center justify-center gap-5">
                  <IntelligencePixel active size="md" />
                  <div className="ui-text-label font-medium text-content-disabled">
                    {t({
                      id: "library.modal.transcribing",
                      message: "Transcribing...",
                    })}
                  </div>
                </div>
              ) : (
                <Virtuoso
                  ref={streamVirtuosoRef}
                  style={{ height: "100%" }}
                  data={streamChunks}
                  overscan={200}
                  className="custom-scrollbar ui-text-body text-content-secondary leading-relaxed"
                  computeItemKey={(index: number) =>
                    `${item.id}-chunk-${index}`
                  }
                  components={{
                    Header: () => <div className="h-2" />,
                    Footer: () => <div className="h-2" />,
                  }}
                  itemContent={(idx, chunk) => (
                    <div className="pb-2 pr-4">
                      <motion.p
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                        className="select-text"
                      >
                        {renderHighlightedText(
                          chunk,
                          idx === activeStreamMatch,
                        )}
                      </motion.p>
                    </div>
                  )}
                />
              )
            ) : item.status.type === "importing" ||
              item.status.type === "pending" ? (
              <div className="flex flex-col h-full w-full items-center justify-center gap-5">
                <IntelligencePixel active size="md" />
                <div className="ui-text-label font-medium text-content-disabled">
                  {importStatusText}
                </div>
              </div>
            ) : (
              <textarea
                ref={transcriptAreaRef}
                value={transcriptDraft}
                onChange={(event) => setTranscriptDraft(event.target.value)}
                disabled={!transcriptEditable}
                placeholder={t({
                  id: "library.modal.transcript_placeholder",
                  message: "Transcript will appear here.",
                })}
                className="h-full w-full resize-none bg-transparent ui-text-body text-content-secondary leading-relaxed outline-hidden disabled:opacity-60 custom-scrollbar select-text pr-4 pt-2 pb-4"
              />
            )}
          </div>
        )}
      </main>

      <footer className="shrink-0 border-t border-[var(--color-border-primary)] px-4 pt-2.5 pb-1">
        <div className="flex items-center gap-4">
          <button
            onClick={handleTogglePlayback}
            disabled={!audioReady || !!audioError}
            className={`text-content-primary hover:text-content-secondary transition-colors shrink-0 translate-y-[2px] ${
              !audioReady || audioError ? "opacity-50 cursor-not-allowed" : ""
            }`}
            aria-label={
              isPlaying
                ? t({
                    id: "library.modal.pause_audio",
                    message: "Pause audio",
                  })
                : t({
                    id: "library.modal.play_audio",
                    message: "Play audio",
                  })
            }
          >
            {isPlaying ? (
              <Pause size={16} className="fill-current" />
            ) : (
              <Play size={16} className="fill-current" />
            )}
          </button>

          <span className="ui-text-micro tabular-nums text-content-disabled font-medium tracking-wide shrink-0">
            {formatDuration(audioCurrentTime)}{" "}
            <span className="opacity-50">
              / {formatDuration(audioDuration)}
            </span>
          </span>

          <div className="flex-1 min-w-0">
            {audioError ? (
              <span className="ui-text-meta text-content-disabled">
                {audioError}
              </span>
            ) : (
              <input
                type="range"
                min={0}
                max={scrubberMax}
                step={0.01}
                value={scrubberValue}
                onChange={(event) => handleScrubChange(event.target.value)}
                onMouseDown={handleScrubStart}
                onTouchStart={handleScrubStart}
                onMouseUp={handleScrubEnd}
                onTouchEnd={handleScrubEnd}
                className="library-scrubber w-full"
                disabled={!audioReady || !!audioError}
                style={{
                  background: `linear-gradient(to right, var(--color-toggle-on) 0%, var(--color-toggle-on) ${scrubberPercent}%, var(--color-border-secondary) ${scrubberPercent}%, var(--color-border-secondary) 100%)`,
                }}
                aria-label={t({
                  id: "library.modal.audio_scrubber",
                  message: "Audio scrubber",
                })}
              />
            )}
          </div>

          <div className="flex items-center gap-0.5 ui-text-micro leading-none shrink-0">
            <button
              type="button"
              onClick={() => handlePlaybackRateStep(-1)}
              disabled={!audioReady || !!audioError || !canDecreasePlaybackRate}
              aria-label={t({
                id: "library.modal.playback.decrease",
                message: "Decrease playback speed",
              })}
              className={`transition-colors p-0.5 ${
                !audioReady || audioError || !canDecreasePlaybackRate
                  ? "text-content-disabled"
                  : "text-content-muted hover:text-content-primary"
              }`}
            >
              <ChevronLeft size={10} />
            </button>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={playbackRate}
                initial={{ opacity: 0, y: -2, scale: 0.92 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 2, scale: 0.92 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                onMouseDown={handleRateScrubStart}
                onTouchStart={handleRateScrubStart}
                className="w-[26px] min-w-[26px] text-center font-medium text-content-secondary tabular-nums cursor-ew-resize select-none"
              >
                {formatPlaybackRate(playbackRate)}x
              </motion.span>
            </AnimatePresence>
            <button
              type="button"
              onClick={() => handlePlaybackRateStep(1)}
              disabled={!audioReady || !!audioError || !canIncreasePlaybackRate}
              aria-label={t({
                id: "library.modal.playback.increase",
                message: "Increase playback speed",
              })}
              className={`transition-colors p-0.5 ${
                !audioReady || audioError || !canIncreasePlaybackRate
                  ? "text-content-disabled"
                  : "text-content-muted hover:text-content-primary"
              }`}
            >
              <ChevronRight size={10} />
            </button>
          </div>

          <div
            className="h-4 w-px bg-[var(--color-border-primary)] shrink-0"
            aria-hidden="true"
          />

          <div className="flex items-center gap-2 shrink-0 translate-y-[2px]">
            <span
              className={`ui-text-meta ${canShowTimestamps ? "text-content-secondary" : "text-content-disabled"}`}
            >
              {t({
                id: "library.modal.timestamps",
                message: "Timestamps",
              })}
            </span>
            <ToggleSwitch
              enabled={showTimestamps}
              onToggle={() => {
                if (!canShowTimestamps) return;
                const nextValue = !showTimestamps;
                setShowTimestamps(nextValue);
                if (!nextValue) {
                  onFollowTimestampsChange(false);
                }
                Promise.resolve(onUpdate({ show_timestamps: nextValue })).catch(
                  (err) => {
                    console.error("failed to save timestamps setting:", err);
                  },
                );
              }}
              ariaLabel={t({
                id: "library.modal.timestamps",
                message: "Timestamps",
              })}
              disabled={!canShowTimestamps}
              size="sm"
            />
          </div>

          <div className="flex items-center gap-2 shrink-0 translate-y-[2px]">
            <span
              className={`ui-text-meta ${showSegmentView ? "text-content-secondary" : "text-content-disabled"}`}
            >
              {t({
                id: "library.modal.follow_timestamp",
                message: "Follow timestamp",
              })}
            </span>
            <ToggleSwitch
              enabled={followTimestampsActive}
              onToggle={() => {
                if (!showSegmentView) return;
                onFollowTimestampsChange((prev) => !prev);
              }}
              ariaLabel={t({
                id: "library.modal.follow_timestamp",
                message: "Follow timestamp",
              })}
              disabled={!showSegmentView}
              size="sm"
            />
          </div>
        </div>
      </footer>

      {createPortal(
        <AnimatePresence>
          {showDeleteConfirm && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-xs px-6"
              onClick={(event) => {
                event.stopPropagation();
                setShowDeleteConfirm(false);
              }}
            >
              <motion.div
                initial={{ scale: 0.96, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.96, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="w-full max-w-sm rounded-2xl border border-border-primary bg-surface-tertiary p-5 ui-shadow-modal-deep"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
              >
                <div className="flex items-center gap-3 mb-3">
                  <AlertTriangle
                    size={20}
                    className="ui-color-warning-strong shrink-0"
                  />
                  <div>
                    <p className="ui-text-body-lg font-semibold text-content-primary">
                      {t({
                        id: "library.modal.delete_confirm.title",
                        message: "Delete this item?",
                      })}
                    </p>
                    <p className="ui-text-label text-content-disabled">
                      {t({
                        id: "library.modal.delete_confirm.description",
                        message:
                          "This removes the transcript and audio from your library.",
                      })}
                    </p>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="rounded-lg border border-border-secondary px-4 py-2 ui-text-body-sm font-medium text-content-secondary hover:border-border-hover transition-colors"
                  >
                    {t({
                      id: "library.modal.cancel",
                      message: "Cancel",
                    })}
                  </button>
                  <button
                    onClick={() => {
                      setShowDeleteConfirm(false);
                      const audio = releaseAudioSource();
                      void onDelete().catch(() => {
                        if (audio) {
                          audio.src = audioUrl;
                          audioRef.current = audio;
                          audio.load();
                        }
                      });
                    }}
                    className="rounded-lg bg-red-500/90 px-4 py-2 ui-text-body-sm font-semibold ui-color-on-solid hover:bg-red-500 transition-colors"
                  >
                    {t({
                      id: "library.modal.delete",
                      message: "Delete",
                    })}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {createPortal(
        <AnimatePresence>
          {showRetranscribe && (
            <LibraryRetranscribeModal
              item={item}
              models={models}
              onCancel={() => setShowRetranscribe(false)}
              onConfirm={async (options) => {
                try {
                  await onUpdate({
                    speech_model: options.model_key,
                    llm_cleanup_enabled: false,
                    show_timestamps: options.show_timestamps,
                    detect_speakers: options.detect_speakers,
                  });
                  await onRetry();
                  setShowRetranscribe(false);
                } catch (err) {
                  console.error("Failed to retranscribe:", err);
                }
              }}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
};

export default LibraryDetail;
