import { useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import {
  useState,
  useCallback,
  useId,
  useRef,
  type Dispatch,
  type CSSProperties,
  type SetStateAction,
} from "react";
import {
  Warning as AlertTriangle,
  ArrowRight,
  Trash as Trash2,
} from "@phosphor-icons/react";
import DotMatrix from "../../../shared/ui/DotMatrix";
import ScreenHeader from "../../../shared/ui/ScreenHeader";
import {
  hasModelCapability,
  MODEL_CAPABILITY_DICTIONARY,
} from "../../../shared/lib/modelCapabilities";
import { isRemoteSpeechConfigured } from "../../../shared/lib/speechProviders";
import { useShiftHeld } from "../../../shared/hooks/useShiftHeld";
import { useModelCatalog } from "../../settings/models-queries";
import { useSettings } from "../../settings/queries";
import * as dictionaryApi from "../api";
import {
  setDictionaryEntriesCache,
  setDictionaryReplacementsCache,
  useReplacements,
} from "../queries";
import type { Replacement } from "../../../types";

const normalizeEntry = (value: string) => value.trim();
const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const DICTIONARY_ENTRY_LIMIT = 64;

type QueuedPersistOptions<T> = {
  value: T;
  persist: (next: T) => Promise<T>;
  setError: Dispatch<SetStateAction<string | null>>;
  setValue: (next: T) => void;
};

function useQueuedPersist<T>({
  value,
  persist,
  setError,
  setValue,
}: QueuedPersistOptions<T>) {
  const [pending, setPending] = useState(false);
  const currentRef = useRef(value);
  const persistedRef = useRef(value);
  const queuedRef = useRef<T | null>(null);
  const isPersistingRef = useRef(false);

  currentRef.current = value;
  if (!isPersistingRef.current && queuedRef.current === null) {
    persistedRef.current = value;
  }

  const persistNext = useCallback(
    async (next: T) => {
      queuedRef.current = next;
      currentRef.current = next;
      setValue(next);

      if (isPersistingRef.current) return;

      isPersistingRef.current = true;
      setPending(true);
      setError(null);

      try {
        while (queuedRef.current !== null) {
          const queuedValue = queuedRef.current;
          queuedRef.current = null;
          const cleaned = await persist(queuedValue);
          if (
            queuedRef.current === null ||
            Object.is(queuedRef.current, queuedValue)
          ) {
            currentRef.current = cleaned;
            persistedRef.current = cleaned;
            setValue(cleaned);
          }
        }
      } catch (error) {
        console.error(error);
        queuedRef.current = null;
        const fallbackValue = persistedRef.current;
        currentRef.current = fallbackValue;
        setValue(fallbackValue);
        setError(toErrorMessage(error));
      } finally {
        isPersistingRef.current = false;
        setPending(false);
      }
    },
    [persist, setError, setValue],
  );

  return { currentRef, pending, persistNext };
}

const DictionaryView = ({ isActive = true }: { isActive?: boolean }) => {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const shiftHeld = useShiftHeld(isActive);
  const settingsQuery = useSettings(undefined, isActive);
  const modelsQuery = useModelCatalog(isActive);
  const replacementsQuery = useReplacements(isActive);

  const [newEntry, setNewEntry] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const [newFrom, setNewFrom] = useState("");
  const [newTo, setNewTo] = useState("");
  const [editingReplacementIndex, setEditingReplacementIndex] = useState<
    number | null
  >(null);
  const [editingFrom, setEditingFrom] = useState("");
  const [editingTo, setEditingTo] = useState("");

  const [error, setError] = useState<string | null>(null);
  const warningTooltipId = useId();

  const settings = settingsQuery.data ?? null;
  const models = modelsQuery.data ?? [];
  const entries = settings?.dictionary ?? [];
  const replacements = replacementsQuery.data ?? [];
  const bootstrapError =
    settingsQuery.error ?? modelsQuery.error ?? replacementsQuery.error;
  const loading =
    isActive &&
    (settingsQuery.isLoading ||
      modelsQuery.isLoading ||
      replacementsQuery.isLoading);

  const {
    currentRef: entriesRef,
    pending: entriesPending,
    persistNext: persistEntriesNext,
  } = useQueuedPersist({
    value: entries,
    persist: dictionaryApi.setDictionary,
    setError,
    setValue: (next) => setDictionaryEntriesCache(queryClient, next),
  });
  const {
    currentRef: replacementsRef,
    pending: replacementsPending,
    persistNext: persistReplacementsNext,
  } = useQueuedPersist({
    value: replacements,
    persist: dictionaryApi.setReplacements,
    setError,
    setValue: (next) => setDictionaryReplacementsCache(queryClient, next),
  });

  const searchQuery = newEntry.trim().toLowerCase();
  const filteredEntries = searchQuery
    ? entries.filter((entry) => entry.toLowerCase().includes(searchQuery))
    : entries;
  const isSearching = searchQuery.length > 0;

  const persistEntries = useCallback(
    async (next: string[]) => {
      setEditingIndex(null);
      setEditingValue("");
      setNewEntry("");
      await persistEntriesNext(next);
    },
    [persistEntriesNext],
  );

  const persistReplacements = useCallback(
    async (next: Replacement[]) => {
      setEditingReplacementIndex(null);
      setEditingFrom("");
      setEditingTo("");
      setNewFrom("");
      setNewTo("");
      await persistReplacementsNext(next);
    },
    [persistReplacementsNext],
  );

  const handleAdd = async () => {
    const value = normalizeEntry(newEntry);
    const currentEntries = entriesRef.current;
    if (
      !value ||
      currentEntries.length >= DICTIONARY_ENTRY_LIMIT ||
      currentEntries.includes(value)
    )
      return;
    await persistEntries([...currentEntries, value]);
  };

  const handleEditCommit = async () => {
    if (editingIndex === null) return;
    const currentEntries = entriesRef.current;
    const value = normalizeEntry(editingValue);
    if (!value) {
      const next = currentEntries.filter((_, idx) => idx !== editingIndex);
      await persistEntries(next);
      return;
    }
    const next = currentEntries.map((entry, idx) =>
      idx === editingIndex ? value : entry,
    );
    await persistEntries(next);
  };

  const handleDelete = async (idx: number) => {
    const next = entriesRef.current.filter((_, i) => i !== idx);
    await persistEntries(next);
  };

  const startEditing = (idx: number) => {
    const currentEntries = entriesRef.current;
    setEditingIndex(idx);
    setEditingValue(currentEntries[idx] ?? "");
  };

  const handleAddReplacement = async () => {
    const currentReplacements = replacementsRef.current;
    const from = normalizeEntry(newFrom);
    const to = normalizeEntry(newTo);
    if (!from) return;
    const exists = currentReplacements.some(
      (r) => r.from.toLowerCase() === from.toLowerCase(),
    );
    if (exists) return;
    await persistReplacements([...currentReplacements, { from, to }]);
  };

  const handleEditReplacementCommit = async () => {
    if (editingReplacementIndex === null) return;
    const currentReplacements = replacementsRef.current;
    const from = normalizeEntry(editingFrom);
    const to = normalizeEntry(editingTo);
    if (!from) {
      const next = currentReplacements.filter(
        (_, idx) => idx !== editingReplacementIndex,
      );
      await persistReplacements(next);
      return;
    }
    const next = currentReplacements.map((r, idx) =>
      idx === editingReplacementIndex ? { from, to } : r,
    );
    await persistReplacements(next);
  };

  const handleDeleteReplacement = async (idx: number) => {
    const next = replacementsRef.current.filter((_, i) => i !== idx);
    await persistReplacements(next);
  };

  const startEditingReplacement = (idx: number) => {
    const currentReplacements = replacementsRef.current;
    setEditingReplacementIndex(idx);
    setEditingFrom(currentReplacements[idx]?.from ?? "");
    setEditingTo(currentReplacements[idx]?.to ?? "");
  };

  const currentModel = models.find((m) => m.key === settings?.local_model);
  const isLocal = settings?.transcription_mode === "local";
  const remoteSpeechActive = isRemoteSpeechConfigured({
    enabled: Boolean(settings?.remote_speech_enabled),
    provider: settings?.remote_speech_provider ?? "custom",
    endpoint: settings?.remote_speech_endpoint ?? "",
    model: settings?.remote_speech_model ?? "",
  });
  const supportsDictionary = hasModelCapability(
    currentModel,
    MODEL_CAPABILITY_DICTIONARY,
  );
  const showWarning = Boolean(
    isLocal && !remoteSpeechActive && currentModel && !supportsDictionary,
  );
  const entryCountLabel =
    entries.length === 1
      ? t({
          id: "dictionary.entry_count.single",
          message: "1 entry",
        })
      : t({
          id: "dictionary.entry_count.multiple",
          message: `${entries.length} entries`,
        });
  const replacementCountLabel =
    replacements.length === 1
      ? t({
          id: "dictionary.replacements.count.single",
          message: "1 replacement",
        })
      : t({
          id: "dictionary.replacements.count.multiple",
          message: `${replacements.length} replacements`,
        });
  const dictionaryMetaLabel =
    isSearching && entries.length > 0
      ? t({
          id: "dictionary.search_matches",
          message: `${filteredEntries.length} of ${entries.length} matches`,
        })
      : entryCountLabel;
  const isEditingDictionary = editingIndex !== null;
  const isEditingReplacement = editingReplacementIndex !== null;
  const isDictionaryFull = entries.length >= DICTIONARY_ENTRY_LIMIT;
  const editHintLabel = t({
    id: "dictionary.edit_hint",
    message: "Press Enter to save · Esc to cancel",
  });
  const dictionaryHintLabel = isEditingDictionary
    ? editHintLabel
    : isDictionaryFull
      ? t({
          id: "dictionary.full_hint",
          message: "Dictionary is full",
        })
      : isSearching && entries.length > 0
        ? t({
            id: "dictionary.press_enter_to_add_match",
            message: "Press Enter to add this word",
          })
        : t({
            id: "dictionary.press_enter_to_add",
            message: "Press Enter to add",
          });
  const replacementHintLabel = isEditingReplacement
    ? editHintLabel
    : t({
        id: "dictionary.replacements.press_enter_to_add",
        message: "Press Enter in either field to add",
      });
  const dictionaryInputPlaceholder = isDictionaryFull
    ? t({
        id: "dictionary.search_only",
        message: "Search dictionary...",
      })
    : t({
        id: "dictionary.search_or_add",
        message: "Search or add a word...",
      });
  const panelBodyClassName =
    "mt-4 min-h-[16rem] max-h-[calc(100vh-330px)] overflow-x-hidden overflow-y-auto custom-scrollbar";
  const panelBodyFadeClassName = "pb-20";
  const itemRowClassName =
    "group relative flex min-h-[42px] items-center overflow-hidden rounded-lg transition-colors hover:bg-[var(--surface-interactive)]";
  const editRowClassName =
    "group relative flex min-h-[42px] items-center rounded-lg bg-[var(--surface-interactive)]";
  const actionGradientStyle: CSSProperties = {
    backgroundImage:
      "linear-gradient(to left, var(--color-row-action-fade) 62%, transparent)",
  };
  const resolvedError =
    error ?? (bootstrapError ? toErrorMessage(bootstrapError) : null);
  const deleteButtonClassName =
    "rounded p-1 text-content-muted transition-colors hover:bg-[color-mix(in_srgb,var(--color-error)_16%,transparent)] hover:text-error";
  const deleteButtonActiveClassName =
    "rounded p-1 text-error bg-[color-mix(in_srgb,var(--color-error)_16%,transparent)] transition-colors";
  const FADE_ITEM_THRESHOLD = 6;

  return (
    <div className="w-full min-w-0 max-w-7xl mx-auto px-0 text-left">
      <ScreenHeader
        className="mb-6 mt-2 md:-mt-6"
        icon={
          <DotMatrix
            rows={2}
            cols={3}
            activeDots={[0, 1, 2, 3]}
            dotSize={3}
            gap={3}
            color="var(--color-section-marker)"
          />
        }
        title={t({
          id: "dictionary.combined.title",
          message: "Dictionary & Replacements",
        })}
        description={t({
          id: "dictionary.combined.description",
          message:
            "Add custom words the system should recognize, and set automatic word replacements.",
        })}
        titleAdornment={
          showWarning && (
            <span className="group relative inline-flex shrink-0 items-center justify-center self-center translate-y-[3px]">
              <button
                type="button"
                aria-describedby={warningTooltipId}
                aria-label={t({
                  id: "dictionary.warning_aria",
                  message: "Warning: model compatibility issue",
                })}
                className="inline-flex items-center justify-center ui-color-warning opacity-90 hover:opacity-100 cursor-default outline-hidden"
              >
                <AlertTriangle size={18} aria-hidden="true" />
              </button>
              <span
                id={warningTooltipId}
                role="tooltip"
                className="pointer-events-none absolute left-1/2 top-full z-50 hidden w-80 -translate-x-1/2 pt-2 text-left font-sans tracking-normal group-hover:block group-focus-within:block"
              >
                <span
                  className="block rounded-lg border bg-surface-overlay p-3 ui-color-warning shadow-xl leading-relaxed ui-text-body-sm shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
                  style={{
                    borderColor:
                      "color-mix(in srgb, var(--color-warning) 30%, transparent)",
                  }}
                >
                  {t({
                    id: "dictionary.warning",
                    message: `Dictionary works only for models with dictionary support. Current model ${currentModel?.label ?? settings?.local_model} will ignore these entries until you switch to a compatible model.`,
                  })}
                </span>
              </span>
            </span>
          )
        }
      />

      <div className="grid w-full min-w-0 grid-cols-1 gap-0 md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="min-w-0 pb-6 md:pr-6 md:pb-0 lg:pr-8">
          <div className="min-w-0">
            <p className="ui-text-title-strong ui-color-primary text-balance">
              {t({
                id: "dictionary.section.dictionary_title",
                message: "Dictionary",
              })}
            </p>
            <p className="mt-1 ui-text-body-sm ui-color-muted text-pretty">
              {t({
                id: "dictionary.section.dictionary_description",
                message: "Add custom words Glimpse should recognize.",
              })}
            </p>
          </div>

          <div className="mt-4 border-b border-border-primary pb-2 transition-colors focus-within:border-border-hover">
            <input
              value={newEntry}
              onChange={(e) => setNewEntry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              placeholder={dictionaryInputPlaceholder}
              aria-label={t({
                id: "dictionary.search_or_add_aria",
                message: "Add or search dictionary entry",
              })}
              className="h-8 w-full min-w-0 bg-transparent ui-text-body-lg ui-color-primary placeholder-content-disabled outline-hidden"
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 ui-text-meta ui-color-muted">
            <span
              className="tabular-nums"
              role={isSearching && entries.length > 0 ? "status" : undefined}
            >
              {dictionaryMetaLabel}
            </span>
            <span>{dictionaryHintLabel}</span>
          </div>

          <div className="relative">
            <div
              aria-busy={entriesPending}
              className={`${panelBodyClassName}${filteredEntries.length > FADE_ITEM_THRESHOLD ? ` ${panelBodyFadeClassName}` : ""}`}
            >
              {loading ? (
                <div className="flex items-center justify-center py-10">
                  <DotMatrix
                    rows={2}
                    cols={6}
                    activeDots={[0, 1, 2, 3, 4, 5]}
                    dotSize={3}
                    gap={3}
                    color="var(--color-content-muted)"
                    animated
                    className="opacity-60"
                  />
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="flex flex-col items-start gap-2 py-6 text-content-muted">
                  {isSearching ? (
                    <>
                      <p className="ui-text-body-lg-strong">
                        {t({
                          id: "dictionary.no_matches",
                          message: "No matches found",
                        })}
                      </p>
                      <p className="ui-text-body-sm ui-color-muted">
                        {isDictionaryFull
                          ? t({
                              id: "dictionary.full_add_prompt",
                              message: "Delete an entry before adding another.",
                            })
                          : t({
                              id: "dictionary.add_prompt",
                              message: `Press Enter to add "${newEntry.trim()}" as a new entry.`,
                            })}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="ui-text-body-lg-strong">
                        {t({
                          id: "dictionary.no_entries",
                          message: "No entries yet",
                        })}
                      </p>
                      <p className="ui-text-body-sm ui-color-muted text-pretty">
                        {t({
                          id: "dictionary.no_entries.description",
                          message:
                            "Add words, phrases, or names above and press Enter to save them here.",
                        })}
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <>
                  {filteredEntries.map((entry, filteredIndex) => {
                    const originalIndex = entries.indexOf(entry);
                    const isEditing = editingIndex === originalIndex;
                    if (isEditing) {
                      return (
                        <div
                          key={`${entry}-${originalIndex}-${filteredIndex}`}
                          className={`${editRowClassName} px-2.5`}
                        >
                          <input
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            autoFocus
                            onFocus={(e) => e.target.select()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleEditCommit();
                              }
                              if (e.key === "Escape") {
                                setEditingIndex(null);
                                setEditingValue("");
                              }
                            }}
                            onBlur={() => handleEditCommit()}
                            className="flex-1 min-w-0 bg-transparent border-0 px-0 py-0 rounded-none ui-text-body-lg ui-color-primary font-medium outline-hidden focus:ring-0"
                            style={{
                              boxShadow:
                                "inset 0 -1px 0 var(--color-border-hover)",
                            }}
                          />
                        </div>
                      );
                    }
                    return (
                      <div
                        key={`${entry}-${originalIndex}-${filteredIndex}`}
                        className={itemRowClassName}
                      >
                        <button
                          onClick={() =>
                            shiftHeld
                              ? handleDelete(originalIndex)
                              : startEditing(originalIndex)
                          }
                          className="flex-1 min-w-0 text-left px-2.5 py-2"
                          title={
                            shiftHeld
                              ? t({
                                  id: "dictionary.delete_entry",
                                  message: `Delete ${entry}`,
                                })
                              : undefined
                          }
                        >
                          <p
                            className={`ui-text-body-lg ui-color-primary leading-tight font-medium truncate transition-colors duration-100 ease-out ${
                              shiftHeld
                                ? "group-hover:!text-error group-hover:line-through"
                                : ""
                            }`}
                          >
                            {entry}
                          </p>
                        </button>
                        <div
                          className="absolute inset-y-0 right-0 flex items-center gap-1 pl-6 pr-2 opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
                          style={{
                            ...actionGradientStyle,
                            willChange: "opacity",
                          }}
                        >
                          <button
                            onClick={() => handleDelete(originalIndex)}
                            className={
                              shiftHeld
                                ? deleteButtonActiveClassName
                                : deleteButtonClassName
                            }
                            title={t({
                              id: "dictionary.delete",
                              message: "Delete",
                            })}
                            aria-label={t({
                              id: "dictionary.delete_entry",
                              message: `Delete ${entry}`,
                            })}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            {filteredEntries.length > FADE_ITEM_THRESHOLD && (
              <div
                className="pointer-events-none absolute bottom-0 left-0 right-0 h-20"
                style={{
                  background:
                    "linear-gradient(to bottom, transparent, var(--color-bg-tertiary))",
                }}
              />
            )}
          </div>
        </div>

        <div className="min-w-0 border-t border-border-primary pt-6 md:border-t-0 md:border-l md:pl-6 md:pt-0 lg:pl-8">
          <div className="min-w-0">
            <p className="ui-text-title-strong ui-color-primary text-balance">
              {t({
                id: "dictionary.section.replacements_title",
                message: "Replacements",
              })}
            </p>
            <p className="mt-1 ui-text-body-sm ui-color-muted text-pretty">
              {t({
                id: "dictionary.section.replacements_description",
                message:
                  "Swap common phrases automatically after transcription.",
              })}
            </p>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end">
            <div className="border-b border-border-primary pb-2 transition-colors focus-within:border-border-hover">
              <input
                value={newFrom}
                onChange={(e) => setNewFrom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddReplacement();
                  }
                }}
                placeholder={t({
                  id: "dictionary.replacements.find",
                  message: "Find word...",
                })}
                aria-label={t({
                  id: "dictionary.replacements.find_aria",
                  message: "Find word to replace",
                })}
                className="h-8 w-full min-w-0 bg-transparent ui-text-body-lg ui-color-primary placeholder-content-disabled outline-hidden"
              />
            </div>
            <div className="hidden sm:flex items-center justify-center pb-2 text-content-muted">
              <ArrowRight size={14} aria-hidden="true" />
            </div>
            <div className="border-b border-border-primary pb-2 transition-colors focus-within:border-border-hover">
              <input
                value={newTo}
                onChange={(e) => setNewTo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddReplacement();
                  }
                }}
                placeholder={t({
                  id: "dictionary.replacements.replace_with",
                  message: "Replace with...",
                })}
                aria-label={t({
                  id: "dictionary.replacements.replace_with_aria",
                  message: "Replace with",
                })}
                className="h-8 w-full min-w-0 bg-transparent ui-text-body-lg ui-color-primary placeholder-content-disabled outline-hidden"
              />
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 ui-text-meta ui-color-muted">
            <span className="tabular-nums">{replacementCountLabel}</span>
            <span>{replacementHintLabel}</span>
          </div>

          <div className="relative">
            <div
              aria-busy={replacementsPending}
              className={`${panelBodyClassName}${replacements.length > FADE_ITEM_THRESHOLD ? ` ${panelBodyFadeClassName}` : ""}`}
            >
              {loading ? (
                <div className="flex items-center justify-center py-10">
                  <DotMatrix
                    rows={2}
                    cols={6}
                    activeDots={[0, 1, 2, 3, 4, 5]}
                    dotSize={3}
                    gap={3}
                    color="var(--color-content-muted)"
                    animated
                    className="opacity-60"
                  />
                </div>
              ) : replacements.length === 0 ? (
                <div className="flex flex-col items-start gap-2 py-6 text-content-muted">
                  <p className="ui-text-body-lg-strong">
                    {t({
                      id: "dictionary.replacements.none",
                      message: "No replacements yet",
                    })}
                  </p>
                  <p className="ui-text-body-sm ui-color-muted text-pretty">
                    {t({
                      id: "dictionary.replacements.none_description",
                      message:
                        "Add word pairs to automatically swap in transcriptions. Matches are case-insensitive.",
                    })}
                  </p>
                </div>
              ) : (
                <>
                  {replacements.map((replacement, idx) => {
                    const isEditing = editingReplacementIndex === idx;
                    if (isEditing) {
                      return (
                        <div
                          key={`${replacement.from}-${idx}`}
                          className={`${editRowClassName} gap-2 px-2.5 py-2`}
                          data-replacement-edit
                        >
                          <input
                            value={editingFrom}
                            onChange={(e) => setEditingFrom(e.target.value)}
                            autoFocus
                            onFocus={(e) => e.target.select()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleEditReplacementCommit();
                              }
                              if (e.key === "Escape") {
                                setEditingReplacementIndex(null);
                                setEditingFrom("");
                                setEditingTo("");
                              }
                            }}
                            onBlur={(e) => {
                              const container = e.currentTarget.closest(
                                "[data-replacement-edit]",
                              );
                              if (
                                !container?.contains(e.relatedTarget as Node)
                              ) {
                                handleEditReplacementCommit();
                              }
                            }}
                            className="min-w-0 flex-1 basis-0 bg-transparent border-0 px-0 py-0 rounded-none ui-text-body-lg ui-color-primary font-medium outline-hidden focus:ring-0"
                            style={{
                              boxShadow:
                                "inset 0 -1px 0 var(--color-border-hover)",
                            }}
                          />
                          <ArrowRight
                            size={14}
                            className="text-content-muted shrink-0"
                            aria-hidden="true"
                          />
                          <input
                            value={editingTo}
                            onChange={(e) => setEditingTo(e.target.value)}
                            onFocus={(e) => e.target.select()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleEditReplacementCommit();
                              }
                              if (e.key === "Escape") {
                                setEditingReplacementIndex(null);
                                setEditingFrom("");
                                setEditingTo("");
                              }
                            }}
                            onBlur={(e) => {
                              const container = e.currentTarget.closest(
                                "[data-replacement-edit]",
                              );
                              if (
                                !container?.contains(e.relatedTarget as Node)
                              ) {
                                handleEditReplacementCommit();
                              }
                            }}
                            placeholder={t({
                              id: "dictionary.replacements.replace_with",
                              message: "Replace with...",
                            })}
                            className="min-w-0 flex-1 basis-0 bg-transparent border-0 px-0 py-0 rounded-none ui-text-body-lg ui-color-primary placeholder-content-disabled outline-hidden focus:ring-0"
                            style={{
                              boxShadow:
                                "inset 0 -1px 0 var(--color-border-hover)",
                            }}
                          />
                        </div>
                      );
                    }
                    return (
                      <div
                        key={`${replacement.from}-${idx}`}
                        className={itemRowClassName}
                      >
                        <button
                          onClick={() =>
                            shiftHeld
                              ? handleDeleteReplacement(idx)
                              : startEditingReplacement(idx)
                          }
                          className="flex flex-1 items-center text-left min-w-0 gap-2 px-2.5 py-2"
                          title={
                            shiftHeld
                              ? t({
                                  id: "dictionary.replacements.delete",
                                  message: `Delete replacement for ${replacement.from}`,
                                })
                              : undefined
                          }
                        >
                          <span
                            className={`ui-text-body-lg ui-color-primary font-medium truncate min-w-0 flex-1 basis-0 transition-colors duration-100 ease-out ${
                              shiftHeld
                                ? "group-hover:!text-error group-hover:line-through"
                                : ""
                            }`}
                          >
                            {replacement.from}
                          </span>
                          <ArrowRight
                            size={14}
                            className={`shrink-0 text-content-muted transition-colors duration-100 ease-out ${
                              shiftHeld ? "group-hover:!text-error" : ""
                            }`}
                            aria-hidden="true"
                          />
                          <span
                            className={`ui-text-body-lg ui-color-primary truncate min-w-0 flex-1 basis-0 transition-colors duration-100 ease-out ${
                              shiftHeld
                                ? "group-hover:!text-error group-hover:line-through"
                                : ""
                            }`}
                          >
                            {replacement.to || (
                              <span className="text-content-muted italic">
                                {t({
                                  id: "dictionary.replacements.remove_value",
                                  message: "remove",
                                })}
                              </span>
                            )}
                          </span>
                        </button>
                        <div
                          className="absolute inset-y-0 right-0 flex items-center gap-1 pl-6 pr-2 opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
                          style={{
                            ...actionGradientStyle,
                            willChange: "opacity",
                          }}
                        >
                          <button
                            onClick={() => handleDeleteReplacement(idx)}
                            className={
                              shiftHeld
                                ? deleteButtonActiveClassName
                                : deleteButtonClassName
                            }
                            title={t({
                              id: "dictionary.delete",
                              message: "Delete",
                            })}
                            aria-label={t({
                              id: "dictionary.replacements.delete",
                              message: `Delete replacement for ${replacement.from}`,
                            })}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            {replacements.length > FADE_ITEM_THRESHOLD && (
              <div
                className="pointer-events-none absolute bottom-0 left-0 right-0 h-20"
                style={{
                  background:
                    "linear-gradient(to bottom, transparent, var(--color-bg-tertiary))",
                }}
              />
            )}
          </div>
        </div>
      </div>

      {resolvedError && (
        <div className="mt-3 border-t border-border-primary pt-3 ui-text-body-sm ui-color-error-soft">
          {resolvedError}
        </div>
      )}
    </div>
  );
};

export default DictionaryView;
