import { useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  WarningCircle as AlertCircle,
  CaretDown as ChevronDown,
  DotsThree as MoreHorizontal,
  PencilSimple as Pencil,
  ArrowClockwise as RotateCw,
  Trash as Trash2,
  X,
} from "@phosphor-icons/react";
import {
  clampProgress,
  formatBytes,
  formatDuration,
  getLibraryErrorDetails,
  shouldShowImportProgress,
  formatLibraryName,
} from "./library-utils";
import { useClickOutside } from "../../../shared/hooks/useClickOutside";
import { IntelligencePixel } from "../../../shared/ui/IntelligencePixel";
import type { LibraryItem } from "../../../types";

const LibraryCard = ({
  item,
  onOpen,
  onRemoveTag,
  onClickTag,
  editingNameId,
  editingNameDraft,
  onStartNameEdit,
  onChangeNameDraft,
  onCommitNameEdit,
  onCancelNameEdit,
  onRetry,
  onCancel,
  onDelete,
  editingTagId,
  tagDraft,
  onStartTagEdit,
  onChangeTagDraft,
  onCommitTagAdd,
  onCancelTagEdit,
  shiftHeld,
  availableTags,
}: {
  item: LibraryItem;
  onOpen: () => void;
  onRemoveTag: (tag: string) => Promise<void>;
  onClickTag?: (tag: string) => void;
  editingNameId: string | null;
  editingNameDraft: string;
  onStartNameEdit: () => void;
  onChangeNameDraft: (value: string) => void;
  onCommitNameEdit: () => void;
  onCancelNameEdit: () => void;
  onRetry: () => Promise<void>;
  onCancel: () => Promise<void>;
  onDelete: () => Promise<void>;
  editingTagId: string | null;
  tagDraft: string;
  onStartTagEdit: () => void;
  onChangeTagDraft: (value: string) => void;
  onCommitTagAdd: (value?: string) => void;
  onCancelTagEdit: () => void;
  shiftHeld: boolean;
  availableTags: string[];
}) => {
  const { t } = useLingui();
  const status = item.status;

  const showImportProgress =
    status.type === "importing" && shouldShowImportProgress(status.progress);
  const isTranscribing = status.type === "transcribing" || showImportProgress;
  const isComplete = status.type === "complete";
  const isError = status.type === "error";

  const showProgressBar = isTranscribing;
  const progress = showProgressBar ? clampProgress(status.progress) : 0;

  const isEditingName = editingNameId === item.id;
  const isAddingTag = editingTagId === item.id;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const errorDetails =
    status.type === "error" ? getLibraryErrorDetails(status.message) : null;

  const normalizedDraft = tagDraft.trim().toLowerCase();
  const filteredTagOptions = availableTags.filter((tag) => {
    const tagLower = tag.toLowerCase();
    if (item.tags.some((existing) => existing.toLowerCase() === tagLower)) {
      return false;
    }
    if (!normalizedDraft) return true;
    return tagLower.includes(normalizedDraft);
  });

  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);
  useClickOutside(tagMenuRef, () => setTagMenuOpen(false), tagMenuOpen);

  const handleDelete = async () => {
    setMenuOpen(false);
    try {
      await onDelete();
    } catch (err) {
      console.error("Failed to delete library item:", err);
    }
  };

  const handleRetry = async () => {
    setMenuOpen(false);
    try {
      await onRetry();
    } catch (err) {
      console.error("Failed to retry library transcription:", err);
    }
  };

  const handleCancel = async () => {
    setMenuOpen(false);
    try {
      await onCancel();
    } catch (err) {
      console.error("Failed to cancel library transcription:", err);
    }
  };

  return (
    <div
      onClick={() => {
        if (!isEditingName && !isAddingTag) {
          onOpen();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (shiftHeld) {
          void handleDelete();
        } else {
          setMenuOpen(true);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (!isEditingName && !isAddingTag) {
            onOpen();
          }
        }
      }}
      role="button"
      tabIndex={0}
      className={`ui-card-liftable group relative z-0 flex min-w-0 flex-col h-[220px] outline-none hover:z-10 ${
        shiftHeld
          ? "!border-[var(--color-error)]/30 hover:!border-[var(--color-error)]/60 !bg-[var(--color-error)]/5"
          : ""
      }`}
    >
      <div className="px-4 pt-2 pb-2.5 flex flex-col h-full relative w-full min-w-0">
        <div className="mb-0.5 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <IntelligencePixel
              active={isTranscribing}
              statusType={item.status.type}
            />

            <div className="flex min-w-0 flex-col gap-1 pt-[1px] min-h-[24px]">
              <div className="flex items-center gap-1.5 h-3">
                <span
                  className={`ui-text-label-strong ${
                    isError
                      ? "ui-color-error-strong font-semibold"
                      : isTranscribing
                        ? "ui-color-accent font-semibold"
                        : isComplete
                          ? "ui-color-secondary"
                          : "ui-color-muted"
                  }`}
                >
                  {isTranscribing
                    ? status.type === "importing"
                      ? t({
                          id: "library.card.status.converting",
                          message: `Converting ${(progress * 100).toFixed(0)}%`,
                        })
                      : t({
                          id: "library.card.status.thinking",
                          message: `Thinking ${(progress * 100).toFixed(0)}%`,
                        })
                    : isError
                      ? t({
                          id: "library.card.status.failed",
                          message: "Failed",
                        })
                      : isComplete
                        ? t({
                            id: "library.card.status.ready",
                            message: "Ready",
                          })
                        : t({
                            id: "library.card.status.queued",
                            message: "Queued",
                          })}
                </span>

                {isError && errorDetails && (
                  <div
                    className="relative group/tooltip flex items-center cursor-default min-w-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <AlertCircle size={12} className="ui-color-error-strong" />
                    <div className="absolute top-0 left-[calc(100%+8px)] w-56 p-3 bg-[var(--color-bg-overlay)] border border-[var(--color-border-hover)] rounded-lg shadow-xl opacity-0 -translate-x-2 group-hover/tooltip:opacity-100 group-hover/tooltip:translate-x-0 transition-all duration-150 ease-out pointer-events-none z-[100]">
                      <p className="ui-text-body-sm ui-color-primary normal-case tracking-normal">
                        {errorDetails.message}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {isTranscribing && (
                <div className="w-16 h-[2px] bg-[var(--color-border-hover)] rounded-full overflow-hidden flex">
                  <motion.div
                    className="h-full bg-[var(--color-accent)]"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress * 100}%` }}
                    transition={{ ease: "linear", duration: 0.5 }}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center -mr-1 -mt-1 overflow-visible h-6">
            <div
              ref={menuRef}
              data-no-press
              className="flex relative items-center justify-center"
            >
              <button
                data-no-press
                onPointerDown={(e) => {
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  if (shiftHeld) {
                    handleDelete();
                  } else {
                    setMenuOpen((prev) => !prev);
                  }
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (e.repeat) return;
                    if (shiftHeld) {
                      handleDelete();
                    } else {
                      setMenuOpen((prev) => !prev);
                    }
                  }
                }}
                onKeyUp={(e) => e.stopPropagation()}
                className={`p-1 ml-1 rounded transition-colors duration-200 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-hover)] flex items-center justify-center ${
                  shiftHeld
                    ? "ui-color-error hover:bg-[var(--color-error)]/10"
                    : menuOpen
                      ? "ui-color-primary bg-[var(--color-bg-elevated)]"
                      : "ui-color-muted hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-elevated)]"
                }`}
                aria-label={t({
                  id: "library.card.more_options",
                  message: "More options",
                })}
              >
                {shiftHeld ? (
                  <Trash2 size={14} className="shrink-0 transform-gpu" />
                ) : (
                  <MoreHorizontal
                    size={14}
                    className="shrink-0 transform-gpu"
                  />
                )}
              </button>
              <AnimatePresence>
                {menuOpen && (
                  <motion.div
                    data-no-press
                    initial={{ opacity: 0, scale: 0.95, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -4 }}
                    transition={{ duration: 0.12 }}
                    className="absolute right-0 top-full mt-2 z-[100] min-w-[160px] rounded-lg border border-[var(--color-border-secondary)] bg-[var(--color-bg-overlay)] shadow-xl shadow-[var(--color-shadow-soft-50)] overflow-hidden"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        onStartNameEdit();
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 ui-text-menu-item ui-color-secondary hover:bg-[var(--color-bg-elevated)] transition-colors"
                    >
                      <Pencil size={12} className="ui-color-muted" />
                      <span>
                        {t({ id: "library.card.rename", message: "Rename" })}
                      </span>
                    </button>

                    {status.type === "transcribing" ||
                    status.type === "cancelling" ||
                    status.type === "pending" ||
                    status.type === "importing" ? (
                      <button
                        onClick={handleCancel}
                        className="flex w-full items-center gap-2.5 px-3 py-2 ui-text-menu-item ui-color-secondary hover:bg-[var(--color-bg-elevated)] transition-colors"
                      >
                        <X size={12} className="ui-color-warning" />
                        <span>
                          {t({ id: "library.card.cancel", message: "Cancel" })}
                        </span>
                      </button>
                    ) : (
                      <button
                        onClick={handleRetry}
                        className="flex w-full items-center gap-2.5 px-3 py-2 ui-text-menu-item ui-color-secondary hover:bg-[var(--color-bg-elevated)] transition-colors"
                      >
                        <RotateCw size={12} className="ui-color-cloud" />
                        <span>
                          {status.type === "error"
                            ? t({
                                id: "library.card.retry",
                                message: "Retry",
                              })
                            : t({
                                id: "library.card.retranscribe",
                                message: "Retranscribe",
                              })}
                        </span>
                      </button>
                    )}

                    <div className="h-px bg-[var(--color-border-secondary)] mx-2 my-1" />

                    <button
                      onClick={handleDelete}
                      className="flex w-full items-center gap-2.5 px-3 py-2 ui-text-menu-item ui-color-error-strong hover:bg-[var(--color-error)]/10 transition-colors"
                    >
                      <Trash2 size={12} />
                      <span>
                        {t({ id: "library.card.delete", message: "Delete" })}
                      </span>
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col justify-start overflow-hidden w-full relative">
          {isEditingName ? (
            <input
              value={editingNameDraft}
              onChange={(event) => onChangeNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onCommitNameEdit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onCancelNameEdit();
                }
              }}
              onBlur={onCommitNameEdit}
              onClick={(event) => event.stopPropagation()}
              className="w-full min-w-0 bg-transparent p-0 ui-text-title-lg font-medium leading-snug ui-color-primary border-0 border-b border-[var(--color-border-primary)] outline-hidden focus:border-[var(--color-border-hover)]"
              autoFocus
            />
          ) : (
            <h3 className="ui-text-title-lg font-medium leading-snug ui-color-primary line-clamp-3 break-words">
              {formatLibraryName(item.name)}
            </h3>
          )}
        </div>

        <div className="mt-auto shrink-0 flex flex-col gap-2 pt-2.5 border-t border-[var(--color-border-primary)]">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 ui-text-label ui-color-muted">
            <span>{formatDuration(item.duration_seconds)}</span>
            <span className="opacity-40">&bull;</span>
            <span>{formatBytes(item.file_size_bytes)}</span>
            {item.source_path && (
              <>
                <span className="opacity-40">&bull;</span>
                <span>
                  {t({ id: "library.card.imported", message: "Imported" })}
                </span>
              </>
            )}
          </div>

          <div className="relative w-full h-6 overflow-visible">
            {isAddingTag ? (
              <div
                className="flex items-center gap-1.5 h-6"
                onClick={(event) => event.stopPropagation()}
              >
                <div ref={tagMenuRef} className="relative flex items-center">
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setTagMenuOpen((prev) => !prev)}
                    className="flex items-center justify-center w-[16px] h-[16px] shrink-0 ui-color-primary hover:text-[var(--color-text-secondary)] transition-colors"
                    aria-label={t({
                      id: "library.card.select_existing_tag",
                      message: "Select existing tag",
                    })}
                    title={t({
                      id: "library.card.select_existing_tag",
                      message: "Select existing tag",
                    })}
                  >
                    <ChevronDown
                      size={12}
                      className={`translate-y-[1px] transition-transform duration-150 ${tagMenuOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  <AnimatePresence>
                    {tagMenuOpen && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.98, y: -4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98, y: -4 }}
                        transition={{ duration: 0.12 }}
                        className="absolute left-0 top-full mt-1 z-[120] w-36 rounded-md border border-[var(--color-border-secondary)] bg-[var(--color-bg-overlay)] shadow-lg shadow-[var(--color-shadow-soft-40)] overflow-hidden"
                      >
                        <div className="max-h-36 overflow-y-auto custom-scrollbar">
                          {filteredTagOptions.length > 0 ? (
                            filteredTagOptions.map((tag, index) => (
                              <button
                                key={`tag-option-${index}-${tag || "empty"}`}
                                type="button"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  onCommitTagAdd(tag);
                                  setTagMenuOpen(false);
                                }}
                                className="w-full text-left px-2.5 py-1.5 ui-text-button-sm ui-color-secondary hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-primary)] transition-colors"
                              >
                                {tag}
                              </button>
                            ))
                          ) : (
                            <div className="px-2.5 py-2 ui-text-micro ui-color-muted">
                              {availableTags.length === 0
                                ? t({
                                    id: "library.card.no_tags_yet",
                                    message: "No tags yet",
                                  })
                                : t({
                                    id: "library.card.no_other_tags",
                                    message: "No other tags",
                                  })}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <input
                  value={tagDraft}
                  onChange={(event) => onChangeTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onCommitTagAdd();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onCancelTagEdit();
                    }
                  }}
                  onBlur={onCancelTagEdit}
                  placeholder={t({
                    id: "library.card.new_tag",
                    message: "New tag...",
                  })}
                  className="tag-input-intro flex-1 min-w-0 h-6 box-border bg-transparent border-b border-[var(--color-border-primary)] px-0.5 py-0 ui-text-meta leading-none ui-color-secondary outline-hidden focus:border-[var(--color-border-hover)] placeholder:text-[var(--color-text-disabled)]"
                  autoFocus
                />
              </div>
            ) : (
              <div className="flex items-center gap-1.5 absolute inset-0 mask-fade-right w-[95%]">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartTagEdit();
                  }}
                  className="flex items-center justify-center w-[16px] h-[16px] shrink-0 ui-color-primary hover:text-[var(--color-text-secondary)] transition-colors text-[14px] leading-none"
                >
                  +
                </button>
                {item.tags.map((tag, index) => (
                  <span
                    key={`tag-${index}-${tag || "empty"}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (shiftHeld) {
                        void onRemoveTag(tag);
                      } else if (onClickTag) {
                        onClickTag(tag);
                      }
                    }}
                    className={`ui-color-secondary hover:text-[var(--color-text-primary)] cursor-pointer ui-text-meta transition-colors duration-100 ease-out whitespace-nowrap ${
                      shiftHeld
                        ? "hover:!text-[var(--color-error)] hover:line-through"
                        : ""
                    }`}
                    title={
                      shiftHeld
                        ? t({
                            id: "library.card.remove_tag",
                            message: `Remove ${tag}`,
                          })
                        : undefined
                    }
                  >
                    <span className="opacity-40 mr-[1px]">#</span>
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default LibraryCard;
