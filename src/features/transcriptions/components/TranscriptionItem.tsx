import { useLingui } from "@lingui/react/macro";
import React, { useState, useRef, useLayoutEffect } from "react";
import { useCopyToClipboard } from "../../../shared/hooks/useCopyToClipboard";
import { motion, AnimatePresence } from "framer-motion";
import {
  Copy,
  Trash as Trash2,
  ArrowClockwise as RotateCw,
  Check,
  CaretDown as ChevronDown,
  CaretUp as ChevronUp,
  DotsThreeVertical as MoreVertical,
  Warning as AlertTriangle,
  ArrowUUpLeft as Undo2,
  X,
} from "@phosphor-icons/react";
import type { TranscriptionRecord } from "../../../types";
import { isRemoteTranscriptionSpeechModel } from "../../../shared/lib/speechProviders";
import { formatTranscriptionLlmModel } from "../../../shared/lib/llmProviders";
import {
  resolveSpeechModelLabel,
  useSpeechModels,
} from "../../settings/models-queries";
import DotMatrix from "../../../shared/ui/DotMatrix";
import { useClickOutside } from "../../../shared/hooks/useClickOutside";
import TranscriptText from "../../../shared/ui/TranscriptText";

interface TranscriptionItemProps {
  record: TranscriptionRecord;
  onDelete: (id: string) => Promise<void>;
  onRetry: (id: string) => Promise<void>;
  onCancelRetry?: (id: string) => Promise<void>;
  onRetryLlm?: (id: string) => Promise<void>;
  onUndoLlm?: (id: string) => Promise<void>;
  isRetrying?: boolean;
  showLlmButtons?: boolean;
  shiftHeld?: boolean;
  showDate?: boolean;
  initialOverflowing?: boolean;
  onOverflowChange?: (id: string, overflowing: boolean) => void;
}

const TranscriptionItem: React.FC<TranscriptionItemProps> = ({
  record,
  onDelete,
  onRetry,
  onCancelRetry,
  onRetryLlm,
  onUndoLlm,
  isRetrying = false,
  showLlmButtons = false,
  shiftHeld = false,
  showDate = false,
  initialOverflowing = false,
  onOverflowChange,
}) => {
  const { t } = useLingui();
  const { data: speechModels } = useSpeechModels();
  const { copied, copy } = useCopyToClipboard(2000);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isCancellingRetry, setIsCancellingRetry] = useState(false);
  const [isRetryingLlm, setIsRetryingLlm] = useState(false);
  const [isUndoingLlm, setIsUndoingLlm] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(initialOverflowing);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectionText, setSelectionText] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useClickOutside(
    menuRef,
    () => {
      setMenuOpen(false);
      setSelectionText("");
    },
    menuOpen,
  );

  useLayoutEffect(() => {
    if (isExpanded) {
      setIsOverflowing(true);
      return;
    }

    const element = textRef.current;
    if (!element) return;

    const updateOverflow = () => {
      if (element.clientHeight === 0) return;
      const overflowing = element.scrollHeight > element.clientHeight;
      setIsOverflowing(overflowing);
      onOverflowChange?.(record.id, overflowing);
    };

    updateOverflow();

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [record.id, record.text, isExpanded, onOverflowChange]);

  const handleCopy = async () => {
    if (await copy(record.text)) {
      setMenuOpen(false);
      setSelectionText("");
    }
  };

  const handleCopySelection = async () => {
    if (!selectionText.trim()) return;
    try {
      await navigator.clipboard.writeText(selectionText);
      setMenuOpen(false);
      setSelectionText("");
    } catch (err) {
      console.error("Failed to copy selection:", err);
    }
  };

  const handleDelete = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    setMenuOpen(false);
    setSelectionText("");
    try {
      await onDelete(record.id);
    } catch (err) {
      console.error("Failed to delete:", err);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRetry = async () => {
    if (isRetrying) return;
    setMenuOpen(false);
    setSelectionText("");
    try {
      await onRetry(record.id);
    } catch (err) {
      console.error("Failed to retry:", err);
    }
  };

  const handleCancelRetry = async (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (isCancellingRetry || !onCancelRetry) return;
    setIsCancellingRetry(true);
    try {
      await onCancelRetry(record.id);
    } catch (err) {
      console.error("Failed to stop retry:", err);
    } finally {
      setIsCancellingRetry(false);
    }
  };

  const handleRetryLlm = async () => {
    if (isRetryingLlm || !onRetryLlm) return;
    setIsRetryingLlm(true);
    setMenuOpen(false);
    setSelectionText("");
    try {
      await onRetryLlm(record.id);
    } catch (err) {
      console.error("Failed to retry cleanup:", err);
    } finally {
      setIsRetryingLlm(false);
    }
  };

  const handleUndoLlm = async () => {
    if (isUndoingLlm || !onUndoLlm) return;
    setIsUndoingLlm(true);
    setMenuOpen(false);
    setSelectionText("");
    try {
      await onUndoLlm(record.id);
    } catch (err) {
      console.error("Failed to undo cleanup:", err);
    } finally {
      setIsUndoingLlm(false);
    }
  };

  const timestamp = new Date(record.timestamp);
  const timeStr = timestamp.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const dateStr = timestamp.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
  const isError = record.status === "error";
  const canRetryFromAudio = record.audio_available;
  const errorMessage =
    record.error_message ||
    t({
      id: "transcriptions.item.error.default",
      message: "Transcription failed",
    });
  const displayText = isError ? null : record.text;
  const normalizedModel = (record.speech_model ?? "").trim();
  const isRemoteSpeechModel = isRemoteTranscriptionSpeechModel(normalizedModel);
  const isCloudModel =
    normalizedModel.startsWith("cloud-") || isRemoteSpeechModel;
  const speechModelLabel = resolveSpeechModelLabel(
    speechModels,
    normalizedModel,
  );
  const llmModelLabel = record.llm_model
    ? formatTranscriptionLlmModel(record.llm_model)
    : null;
  const modeLabel = record.mode_name?.trim() || null;
  const allowContextMenu = !isRetryingLlm && !isUndoingLlm;

  const captureSelectionText = () => {
    const selection = window.getSelection();
    if (!selection) return "";
    const text = selection.toString();
    if (!text.trim()) return "";
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (
      textRef.current &&
      ((anchor && textRef.current.contains(anchor)) ||
        (focus && textRef.current.contains(focus)))
    ) {
      return text;
    }
    return "";
  };

  const openMenu = () => {
    setSelectionText(captureSelectionText());
    setMenuOpen(true);
  };

  return (
    <div
      className="group relative"
      onContextMenu={(event) => {
        if (!allowContextMenu) return;
        event.preventDefault();
        if (shiftHeld) {
          handleDelete();
        } else {
          openMenu();
        }
      }}
    >
      <div
        className={`flex items-start gap-2 py-2.5 px-3 rounded-lg transition-colors ${isError ? "bg-red-500/[0.03]" : "hover:bg-[var(--surface-interactive)]"}`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-x-2 mb-1 ui-text-meta ui-color-disabled whitespace-nowrap overflow-hidden">
            {showDate && (
              <>
                <span>{dateStr}</span>
                <span aria-hidden="true" className="opacity-60">
                  ·
                </span>
              </>
            )}
            <span>{timeStr}</span>
            {isError && (
              <>
                <span aria-hidden="true" className="opacity-60">
                  ·
                </span>
                <span className="flex items-center gap-1 ui-color-error-strong font-medium">
                  <AlertTriangle
                    size={10}
                    aria-hidden="true"
                    className="opacity-80"
                  />
                  {t({
                    id: "transcriptions.item.failed",
                    message: "Failed",
                  })}
                </span>
              </>
            )}
            {isRetrying && (
              <>
                <span aria-hidden="true" className="opacity-60">
                  ·
                </span>
                <button
                  onClick={(event) => {
                    void handleCancelRetry(event);
                  }}
                  disabled={isCancellingRetry || !onCancelRetry}
                  className="flex items-center gap-1 ui-color-cloud font-medium group/stop hover:text-cloud-hover transition-colors"
                  aria-label={t({
                    id: "transcriptions.item.stop_retry",
                    message: "Stop transcription",
                  })}
                  title={t({
                    id: "transcriptions.item.stop_retry",
                    message: "Stop transcription",
                  })}
                >
                  <span className="relative inline-flex items-center justify-center w-[9px] h-[9px]">
                    <DotMatrix
                      rows={1}
                      cols={1}
                      activeDots={[0]}
                      dotSize={3}
                      gap={1}
                      color="var(--color-warning)"
                      className="opacity-80 transition-opacity group-hover/stop:opacity-0"
                    />
                    <X
                      size={9}
                      className="absolute opacity-0 transition-opacity group-hover/stop:opacity-100"
                      aria-hidden="true"
                    />
                  </span>
                  {t({
                    id: "transcriptions.item.retrying",
                    message: "Retrying...",
                  })}
                </button>
              </>
            )}
          </div>

          {isError ? (
            <p className="ui-text-body-sm ui-color-error-soft">
              {errorMessage}
            </p>
          ) : (
            <>
              <div
                ref={textRef}
                className={`ui-text-body ui-color-primary leading-relaxed select-text cursor-text overflow-hidden break-words ${!isExpanded ? "line-clamp-3" : ""}`}
                onMouseUp={() => setSelectionText(captureSelectionText())}
                onKeyUp={() => setSelectionText(captureSelectionText())}
              >
                <TranscriptText text={displayText || ""} />
              </div>
              {(isOverflowing || isExpanded) && (
                <button
                  onClick={() => setIsExpanded(!isExpanded)}
                  className="flex items-center gap-1 mt-1 -ml-0.5 px-1 py-0.5 ui-text-meta ui-color-muted hover:text-content-secondary transition-colors rounded"
                  aria-label={
                    isExpanded
                      ? t({
                          id: "transcriptions.item.show_less",
                          message: "Show less",
                        })
                      : t({
                          id: "transcriptions.item.show_more",
                          message: "Show more",
                        })
                  }
                >
                  {isExpanded ? (
                    <>
                      <ChevronUp size={11} aria-hidden="true" />
                      <span>
                        {t({
                          id: "transcriptions.item.show_less",
                          message: "Show less",
                        })}
                      </span>
                    </>
                  ) : (
                    <>
                      <ChevronDown size={11} aria-hidden="true" />
                      <span>
                        {t({
                          id: "transcriptions.item.show_more",
                          message: "Show more",
                        })}
                      </span>
                    </>
                  )}
                </button>
              )}
            </>
          )}
        </div>

        {!isRetrying && !isRetryingLlm && !isUndoingLlm && (
          <div
            className="relative shrink-0 flex items-center gap-1"
            ref={menuRef}
          >
            {!isError && (
              <motion.button
                onClick={handleCopy}
                data-no-press
                className={`p-1.5 rounded-md transition-colors opacity-0 group-hover:opacity-100 hover:bg-surface-elevated ${
                  copied ? "bg-surface-elevated" : ""
                }`}
                title={
                  copied
                    ? t({
                        id: "transcriptions.item.copied",
                        message: "Copied",
                      })
                    : t({
                        id: "transcriptions.item.copy_transcription",
                        message: "Copy transcription",
                      })
                }
                aria-label={
                  copied
                    ? t({
                        id: "transcriptions.item.copied",
                        message: "Copied",
                      })
                    : t({
                        id: "transcriptions.item.copy_transcription",
                        message: "Copy transcription",
                      })
                }
              >
                <motion.span
                  className="flex origin-center"
                  whileTap={{ scale: 0.9 }}
                  transition={{ duration: 0.08 }}
                >
                  {copied ? (
                    <Check
                      size={14}
                      className="text-success"
                      aria-hidden="true"
                    />
                  ) : (
                    <Copy
                      size={14}
                      className="text-content-secondary"
                      aria-hidden="true"
                    />
                  )}
                </motion.span>
              </motion.button>
            )}

            <motion.button
              onClick={() => {
                if (shiftHeld) {
                  handleDelete();
                } else {
                  if (menuOpen) {
                    setMenuOpen(false);
                    setSelectionText("");
                  } else {
                    openMenu();
                  }
                }
              }}
              whileTap={{ scale: 0.95 }}
              className={`p-1.5 rounded-md transition-colors ${
                shiftHeld ? "hover:bg-red-500/10" : "hover:bg-surface-elevated"
              }`}
              title={
                shiftHeld
                  ? t({
                      id: "transcriptions.item.delete",
                      message: "Delete",
                    })
                  : t({
                      id: "transcriptions.item.more_options",
                      message: "More options",
                    })
              }
              aria-label={
                shiftHeld
                  ? t({
                      id: "transcriptions.item.delete",
                      message: "Delete",
                    })
                  : t({
                      id: "transcriptions.item.more_options",
                      message: "More options",
                    })
              }
              aria-haspopup="true"
              aria-expanded={menuOpen}
            >
              {shiftHeld ? (
                <Trash2 size={14} className="text-red-400" aria-hidden="true" />
              ) : (
                <MoreVertical
                  size={14}
                  className="text-content-muted"
                  aria-hidden="true"
                />
              )}
            </motion.button>

            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -4 }}
                  transition={{ duration: 0.12 }}
                  className="ui-surface-menu absolute right-0 top-full mt-1 z-[100] min-w-[200px] origin-top-right"
                >
                  {(speechModelLabel || modeLabel || llmModelLabel) && (
                    <>
                      <div className="px-3 pt-2.5 pb-2 space-y-0.5">
                        <div className="ui-text-meta ui-color-disabled">
                          {dateStr} · {timeStr}
                        </div>
                        {speechModelLabel && (
                          <div
                            className={`ui-text-meta truncate ${isCloudModel ? "ui-color-cloud" : "ui-color-secondary"}`}
                          >
                            {speechModelLabel}
                          </div>
                        )}
                        {llmModelLabel && record.llm_cleaned && (
                          <div className="ui-text-meta ui-color-local truncate">
                            {llmModelLabel}
                          </div>
                        )}
                        {modeLabel && (
                          <div className="ui-text-meta ui-color-secondary truncate">
                            {modeLabel}
                          </div>
                        )}
                      </div>
                      <div className="h-px bg-border-secondary mx-2" />
                    </>
                  )}
                  {selectionText.trim().length > 0 && (
                    <>
                      <button
                        onClick={handleCopySelection}
                        className="flex w-full items-center gap-2.5 px-3 py-2 ui-text-menu-item ui-color-secondary hover:bg-surface-elevated transition-colors"
                      >
                        <Copy size={12} className="text-content-muted" />
                        <span>
                          {t({
                            id: "transcriptions.item.copy_selection",
                            message: "Copy selection",
                          })}
                        </span>
                      </button>
                      <div className="h-px bg-border-secondary mx-2" />
                    </>
                  )}
                  {canRetryFromAudio && (
                    <button
                      onClick={handleRetry}
                      disabled={isRetrying}
                      className="flex w-full items-center gap-2.5 px-3 py-2 ui-text-menu-item ui-color-secondary hover:bg-surface-elevated transition-colors disabled:opacity-50"
                    >
                      <RotateCw size={12} className="text-cloud" />
                      <span>
                        {t({
                          id: "transcriptions.item.retry",
                          message: "Retry",
                        })}
                      </span>
                    </button>
                  )}

                  {!isError &&
                    onRetryLlm &&
                    showLlmButtons &&
                    !isCloudModel && (
                      <button
                        onClick={handleRetryLlm}
                        disabled={isRetryingLlm}
                        className="flex w-full items-center gap-2.5 px-3 py-2 ui-text-menu-item ui-color-secondary hover:bg-surface-elevated transition-colors disabled:opacity-50"
                      >
                        <RotateCw size={12} className="text-local" />
                        <span>
                          {record.llm_cleaned
                            ? t({
                                id: "transcriptions.item.retry_cleanup",
                                message: "Retry cleanup",
                              })
                            : t({
                                id: "transcriptions.item.run_cleanup",
                                message: "Run cleanup",
                              })}
                        </span>
                      </button>
                    )}

                  {!isError &&
                    record.llm_cleaned &&
                    record.raw_text &&
                    onUndoLlm &&
                    showLlmButtons &&
                    !isCloudModel && (
                      <button
                        onClick={handleUndoLlm}
                        disabled={isUndoingLlm}
                        className="flex w-full items-center gap-2.5 px-3 py-2 ui-text-menu-item ui-color-secondary hover:bg-surface-elevated transition-colors disabled:opacity-50"
                      >
                        <Undo2 size={12} className="text-warning" />
                        <span>
                          {t({
                            id: "transcriptions.item.restore_original",
                            message: "Restore original transcript",
                          })}
                        </span>
                      </button>
                    )}

                  {(canRetryFromAudio ||
                    (!isError &&
                      onRetryLlm &&
                      showLlmButtons &&
                      !isCloudModel) ||
                    (!isError &&
                      record.llm_cleaned &&
                      record.raw_text &&
                      onUndoLlm &&
                      showLlmButtons &&
                      !isCloudModel)) && (
                    <div className="h-px bg-border-secondary mx-2" />
                  )}
                  <button
                    onClick={handleDelete}
                    disabled={isDeleting}
                    className="flex w-full items-center gap-2.5 px-3 py-2 ui-text-menu-item ui-color-error-strong hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  >
                    <Trash2 size={12} />
                    <span>
                      {t({
                        id: "transcriptions.item.delete",
                        message: "Delete",
                      })}
                    </span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {isRetryingLlm && (
          <div className="flex items-center gap-1.5 ui-text-meta ui-color-local">
            <RotateCw size={12} className="animate-spin" />
            <span>
              {t({
                id: "transcriptions.item.cleaning",
                message: "Cleaning...",
              })}
            </span>
          </div>
        )}
        {isUndoingLlm && (
          <div className="flex items-center gap-1.5 ui-text-meta ui-color-warning">
            <Undo2 size={12} className="animate-pulse" />
            <span>
              {t({
                id: "transcriptions.item.reverting",
                message: "Reverting...",
              })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(TranscriptionItem);
