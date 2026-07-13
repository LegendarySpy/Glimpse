import { useLingui } from "@lingui/react/macro";
import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MagnifyingGlass as Search,
  X,
  ArrowsDownUp as ArrowDownUp,
  Check,
} from "@phosphor-icons/react";
import { Virtuoso } from "react-virtuoso";
import {
  useTranscriptionList,
  useDeleteTranscription,
  useRetryTranscription,
  useRetryLlmCleanup,
  useUndoLlmCleanup,
} from "../queries";
import TranscriptionItem from "./TranscriptionItem";
import DotMatrix from "../../../shared/ui/DotMatrix";
import { useDebouncedValue } from "../../../shared/hooks/useDebouncedValue";
import { useShiftHeld } from "../../../shared/hooks/useShiftHeld";
import { useClickOutside } from "../../../shared/hooks/useClickOutside";
import type { TranscriptionRecord } from "../../../types";
import {
  parseTranscriptionSearch,
  withSortToken,
  withTimePreset,
  currentTimePreset,
  type TranscriptionSort,
  type TimePreset,
} from "../searchQuery";

interface TranscriptionListProps {
  showLlmButtons?: boolean;
  isActive?: boolean;
}

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const areSameDay = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

const VirtualListHeader = () => <div className="h-3" />;
const VirtualListFooter = () => <div className="h-3" />;
const virtuosoComponents = {
  Header: VirtualListHeader,
  Footer: VirtualListFooter,
};

const TranscriptionList: React.FC<TranscriptionListProps> = ({
  showLlmButtons = false,
  isActive = true,
}) => {
  const { t } = useLingui();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 300);
  const shiftHeld = useShiftHeld(isActive);

  useClickOutside(filterRef, () => setFilterOpen(false), filterOpen);
  useClickOutside(
    searchRef,
    () => {
      if (!searchQuery.trim()) setSearchOpen(false);
    },
    searchOpen,
  );

  useEffect(() => {
    if (!searchOpen) return;
    const id = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [searchOpen]);

  const parsed = useMemo(
    () => parseTranscriptionSearch(searchQuery),
    [searchQuery],
  );
  const debouncedText = useMemo(
    () => parseTranscriptionSearch(debouncedSearchQuery).text,
    [debouncedSearchQuery],
  );
  const filter = useMemo(
    () => ({
      search: debouncedText.trim() || undefined,
      afterMs: parsed.after?.getTime(),
      beforeMs: parsed.before?.getTime(),
      sort: parsed.sort,
    }),
    [debouncedText, parsed.after, parsed.before, parsed.sort],
  );

  const {
    records,
    totalCount,
    recordAt,
    previousTimestampAt,
    requestRange,
    isLoading,
    isFetched,
  } = useTranscriptionList(filter, isActive);
  const deleteMutation = useDeleteTranscription();
  const {
    retry: retryMutation,
    cancelRetry: cancelRetryMutation,
    retryingIds,
  } = useRetryTranscription(isActive);
  const retryLlmMutation = useRetryLlmCleanup();
  const undoLlmMutation = useUndoLlmCleanup();
  const retryingIdSet = useMemo(() => new Set(retryingIds), [retryingIds]);
  const overflowByIdRef = useRef(new Map<string, boolean>());
  const rememberOverflow = useCallback((id: string, overflowing: boolean) => {
    overflowByIdRef.current.set(id, overflowing);
  }, []);

  const freshIdsRef = useRef<{
    data: TranscriptionRecord[] | null;
    seen: Set<string>;
  }>({ data: null, seen: new Set() });

  const freshIds = useMemo(() => {
    if (!isFetched) return new Set<string>();
    const cache = freshIdsRef.current;
    if (cache.data === records) return new Set<string>();
    const fresh = new Set<string>();
    for (const record of records) {
      if (cache.data !== null && !cache.seen.has(record.id)) {
        fresh.add(record.id);
      }
      cache.seen.add(record.id);
    }
    cache.data = records;
    return fresh;
  }, [records, isFetched]);

  useEffect(() => {
    if (freshIds.size === 0) return;
    const timer = setTimeout(() => freshIds.clear(), 600);
    return () => clearTimeout(timer);
  }, [freshIds]);

  const isTimeSorted = parsed.sort === "recent" || parsed.sort === "oldest";

  const formatGroupLabel = useCallback(
    (date: Date) => {
      const now = new Date();
      const today = startOfDay(now);
      const target = startOfDay(date);
      const diffDays = Math.round(
        (today.getTime() - target.getTime()) / 86400000,
      );
      if (diffDays === 0)
        return t({ id: "transcriptions.group.today", message: "Today" });
      if (diffDays === 1)
        return t({
          id: "transcriptions.group.yesterday",
          message: "Yesterday",
        });
      if (diffDays > 1 && diffDays < 7) {
        return target.toLocaleDateString([], { weekday: "long" });
      }
      if (target.getFullYear() === now.getFullYear()) {
        return target.toLocaleDateString([], {
          month: "long",
          day: "numeric",
        });
      }
      return target.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    },
    [t],
  );

  const deleteTranscription = useCallback(
    async (id: string) => {
      await deleteMutation.mutateAsync(id);
    },
    [deleteMutation],
  );

  const retryTranscription = useCallback(
    async (id: string) => {
      await retryMutation.mutateAsync(id);
    },
    [retryMutation],
  );

  const cancelRetryTranscription = useCallback(
    async (id: string) => {
      await cancelRetryMutation.mutateAsync(id);
    },
    [cancelRetryMutation],
  );

  const retryLlmCleanup = useCallback(
    async (id: string) => {
      await retryLlmMutation.mutateAsync(id);
    },
    [retryLlmMutation],
  );

  const undoLlmCleanup = useCallback(
    async (id: string) => {
      await undoLlmMutation.mutateAsync(id);
    },
    [undoLlmMutation],
  );

  const sortOptions: { value: TranscriptionSort; label: string }[] = [
    {
      value: "recent",
      label: t({
        id: "transcriptions.sort.recent",
        message: "Newest first",
      }),
    },
    {
      value: "oldest",
      label: t({
        id: "transcriptions.sort.oldest",
        message: "Oldest first",
      }),
    },
    {
      value: "longest",
      label: t({
        id: "transcriptions.sort.longest",
        message: "Longest",
      }),
    },
    {
      value: "shortest",
      label: t({
        id: "transcriptions.sort.shortest",
        message: "Shortest",
      }),
    },
  ];

  const timeOptions: { value: TimePreset; label: string }[] = [
    {
      value: "any",
      label: t({ id: "transcriptions.time.any", message: "Any time" }),
    },
    {
      value: "today",
      label: t({ id: "transcriptions.time.today", message: "Today" }),
    },
    {
      value: "7d",
      label: t({ id: "transcriptions.time.7d", message: "Past 7 days" }),
    },
  ];

  const activeTimePreset = currentTimePreset(parsed.after, parsed.before);

  const renderEntry = useCallback(
    (index: number) => {
      const record = recordAt(index);
      if (!record) {
        return <div className="h-[124px]" aria-hidden="true" />;
      }
      const timestamp = new Date(record.timestamp);
      const previousTimestamp = previousTimestampAt(index);
      const startsGroup =
        isTimeSorted &&
        (!previousTimestamp ||
          !areSameDay(timestamp, new Date(previousTimestamp)));

      return (
        <div
          className={
            freshIds.has(record.id)
              ? "transcription-entry transcription-entry-fade"
              : "transcription-entry"
          }
        >
          {startsGroup && (
            <div
              className={`flex items-center gap-3 pb-2 px-1 ${index === 0 ? "pt-1" : "pt-6"}`}
            >
              <span className="ui-text-body-sm-strong ui-color-secondary shrink-0">
                {formatGroupLabel(timestamp)}
              </span>
              <div className="ui-divider-trailing flex-1" aria-hidden="true" />
            </div>
          )}
          <TranscriptionItem
            record={record}
            initialOverflowing={overflowByIdRef.current.get(record.id)}
            onOverflowChange={rememberOverflow}
            isRetrying={retryingIdSet.has(record.id)}
            onDelete={deleteTranscription}
            onRetry={retryTranscription}
            onCancelRetry={cancelRetryTranscription}
            onRetryLlm={retryLlmCleanup}
            onUndoLlm={undoLlmCleanup}
            showLlmButtons={showLlmButtons}
            shiftHeld={shiftHeld}
            showDate={!isTimeSorted}
          />
        </div>
      );
    },
    [
      freshIds,
      formatGroupLabel,
      isTimeSorted,
      previousTimestampAt,
      recordAt,
      retryingIdSet,
      rememberOverflow,
      deleteTranscription,
      retryTranscription,
      cancelRetryTranscription,
      retryLlmCleanup,
      undoLlmCleanup,
      showLlmButtons,
      shiftHeld,
    ],
  );

  const hasQuery = searchQuery.trim().length > 0;
  const resultSearchText = parsed.text.trim();
  const showInitialLoading = isLoading && !isFetched;
  const hasAnyResults = totalCount > 0;
  const showEmptyState = isFetched && totalCount === 0 && !hasQuery;
  const showNoResults = isFetched && !hasAnyResults && hasQuery;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="w-full flex-1 min-h-0 h-0 flex flex-col"
    >
      <div className="mb-2 h-8 shrink-0 flex justify-end" ref={searchRef}>
        <AnimatePresence initial={false} mode="wait">
          {searchOpen ? (
            <motion.div
              key="search-input"
              initial={{ opacity: 0, width: 32 }}
              animate={{ opacity: 1, width: 272 }}
              exit={{ opacity: 0, width: 32 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="flex items-center gap-2 h-8 px-0.5 border-b border-border-secondary bg-transparent transition-colors focus-within:border-content-primary"
            >
              <Search
                size={12}
                className="text-content-disabled shrink-0"
                aria-hidden="true"
              />
              <input
                ref={searchInputRef}
                type="text"
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchQuery("");
                    setSearchOpen(false);
                    setFilterOpen(false);
                  }
                }}
                placeholder={t({
                  id: "transcriptions.list.search.placeholder_short",
                  message: "Search",
                })}
                aria-label={t({
                  id: "transcriptions.list.search.aria",
                  message: "Search transcriptions",
                })}
                className="bg-transparent ui-text-body-sm ui-color-secondary placeholder-content-disabled outline-hidden flex-1 min-w-0"
              />
              {hasQuery && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                  aria-label={t({
                    id: "transcriptions.list.search.clear",
                    message: "Clear search",
                  })}
                  className="p-0.5 rounded text-content-disabled hover:text-content-muted transition-colors shrink-0"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
              <div className="relative shrink-0" ref={filterRef}>
                <button
                  type="button"
                  onClick={() => setFilterOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={filterOpen}
                  aria-label={t({
                    id: "transcriptions.list.filter.aria",
                    message: "Sort and filter transcriptions",
                  })}
                  className="ui-button-ghost h-7 w-7"
                >
                  <ArrowDownUp size={13} aria-hidden="true" />
                </button>
                <AnimatePresence>
                  {filterOpen && (
                    <motion.div
                      role="menu"
                      initial={{ opacity: 0, scale: 0.98, y: -2 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.98, y: -2 }}
                      transition={{ duration: 0.12 }}
                      className="ui-surface-menu absolute right-0 top-full mt-1.5 z-30 min-w-[170px] py-1"
                    >
                      <div className="px-3 pt-1 pb-1 ui-text-uppercase-micro ui-color-muted">
                        {t({
                          id: "transcriptions.filter.sort",
                          message: "Sort",
                        })}
                      </div>
                      {sortOptions.map((opt) => {
                        const selected = opt.value === parsed.sort;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            onClick={() =>
                              setSearchQuery((q) => withSortToken(q, opt.value))
                            }
                            className={`flex w-full items-center justify-between gap-3 px-3 py-1 ui-text-body-sm transition-colors ${
                              selected
                                ? "ui-color-primary bg-[var(--surface-interactive-strong)]"
                                : "ui-color-secondary hover:bg-[var(--surface-interactive)] hover:text-content-primary"
                            }`}
                          >
                            <span>{opt.label}</span>
                            <span className="w-3 flex items-center justify-center shrink-0">
                              {selected && (
                                <Check size={12} aria-hidden="true" />
                              )}
                            </span>
                          </button>
                        );
                      })}
                      <div className="my-1 mx-3 border-t border-border-secondary" />
                      <div className="px-3 pt-1 pb-1 ui-text-uppercase-micro ui-color-muted">
                        {t({
                          id: "transcriptions.filter.when",
                          message: "When",
                        })}
                      </div>
                      {timeOptions.map((opt) => {
                        const selected = opt.value === activeTimePreset;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            onClick={() =>
                              setSearchQuery((q) =>
                                withTimePreset(q, opt.value),
                              )
                            }
                            className={`flex w-full items-center justify-between gap-3 px-3 py-1 ui-text-body-sm transition-colors ${
                              selected
                                ? "ui-color-primary bg-[var(--surface-interactive-strong)]"
                                : "ui-color-secondary hover:bg-[var(--surface-interactive)] hover:text-content-primary"
                            }`}
                          >
                            <span>{opt.label}</span>
                            <span className="w-3 flex items-center justify-center shrink-0">
                              {selected && (
                                <Check size={12} aria-hidden="true" />
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          ) : (
            <motion.button
              key="search-button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              onClick={() => setSearchOpen(true)}
              aria-label={t({
                id: "transcriptions.list.search.open",
                message: "Search transcriptions",
              })}
              className="ui-button-ghost h-8 w-8"
            >
              <Search size={13} aria-hidden="true" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div
          className="pointer-events-none absolute left-0 right-3 top-0 h-6 z-10"
          style={{
            background:
              "linear-gradient(to bottom, var(--color-bg-tertiary), transparent)",
          }}
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute left-0 right-3 bottom-0 h-8 z-10"
          style={{
            background:
              "linear-gradient(to top, var(--color-bg-tertiary), transparent)",
          }}
          aria-hidden="true"
        />
        {showEmptyState ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <DotMatrix
              rows={4}
              cols={4}
              activeDots={[0, 3, 5, 6, 9, 10, 12, 15]}
              dotSize={4}
              gap={4}
              color="var(--color-text-disabled)"
              className="opacity-40 mb-4"
              aria-hidden="true"
            />
            <p className="ui-text-body ui-color-muted max-w-xs">
              {t({
                id: "transcriptions.list.empty",
                message: "Your recent transcriptions will appear here",
              })}
            </p>
          </div>
        ) : showNoResults ? (
          <div className="h-full flex flex-col items-center justify-center">
            <Search
              size={18}
              className="text-content-disabled mb-2"
              aria-hidden="true"
            />
            <p className="ui-text-body-sm ui-color-muted">
              {resultSearchText
                ? t({
                    id: "transcriptions.list.no_results",
                    message: `No results for "${resultSearchText}"`,
                  })
                : t({
                    id: "transcriptions.list.no_results_filters",
                    message: "No results for selected filters",
                  })}
            </p>
          </div>
        ) : (
          <>
            {showInitialLoading && (
              <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                <DotMatrix
                  rows={2}
                  cols={8}
                  activeDots={[0, 1, 2, 3, 4, 5, 6, 7]}
                  dotSize={3}
                  gap={3}
                  color="var(--color-text-muted)"
                  animated
                  className="opacity-50"
                />
              </div>
            )}
            <Virtuoso
              style={{ height: "100%" }}
              totalCount={showInitialLoading ? 0 : totalCount}
              defaultItemHeight={124}
              overscan={400}
              increaseViewportBy={400}
              computeItemKey={(index) =>
                recordAt(index)?.id ?? `loading-${index}`
              }
              components={virtuosoComponents}
              itemContent={renderEntry}
              rangeChanged={requestRange}
              className="custom-scrollbar scrollbar-gutter"
            />
          </>
        )}
      </div>
    </motion.div>
  );
};

export default React.memo(TranscriptionList);
