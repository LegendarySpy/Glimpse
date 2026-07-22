import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import { Download, Square, Trash as Trash2 } from "@phosphor-icons/react";
import ModelCardShell, { WAVE_COLS, waveDots } from "./ModelCardShell";
import ActivityDots from "../../../shared/ui/ActivityDots";
import {
  deriveModelStats,
  formatModelSize,
  formatQuantLabel,
  isBuiltInModel,
} from "../../../shared/lib/modelStats";
import type { DownloadEvent, ModelInfo, ModelStatus } from "../../../types";

type ModelStatCardProps = {
  model: ModelInfo;
  status?: ModelStatus;
  progress?: DownloadEvent;
  width?: number;
  compact?: boolean;
  onDownload: () => void;
  onDelete: () => void;
  onCancel: () => void;
};

const ModelStatCard = ({
  model,
  status,
  progress,
  width,
  compact = false,
  onDownload,
  onDelete,
  onCancel,
}: ModelStatCardProps) => {
  const { t } = useLingui();
  const stats = deriveModelStats(model);

  const builtIn = isBuiltInModel(model);
  const facts = [stats.languagesLabel];
  facts.push(
    builtIn
      ? t({ id: "models.card.built_in", message: "Built into this Mac" })
      : formatModelSize(model.size_mb),
  );
  const quant = formatQuantLabel(model.variant);
  if (quant && !compact) facts.push(quant);

  const installed = status?.installed;
  const isDownloading = progress?.status === "downloading";
  const downloadingFile =
    progress?.status === "downloading"
      ? progress.file.split("/").pop()
      : undefined;
  const percent = progress?.percent ?? 0;
  const isVerifying =
    progress?.status === "downloading" && progress.verifying === true;

  const fullDots = useMemo(() => waveDots(model.key), [model.key]);
  const revealCols = installed
    ? WAVE_COLS
    : isDownloading
      ? Math.round((percent / 100) * WAVE_COLS)
      : 0;
  const dots = fullDots.filter((idx) => idx % WAVE_COLS < revealCols);

  const isNvidia = model.engine_id === "nvidia";
  const accent = isNvidia
    ? "var(--model-wave-nvidia)"
    : "var(--model-wave-whisper)";
  const glowStrong = isNvidia
    ? "var(--model-wave-glow-strong-nvidia)"
    : "var(--model-wave-glow-strong-whisper)";
  const glowSoft = isNvidia
    ? "var(--model-wave-glow-soft-nvidia)"
    : "var(--model-wave-glow-soft-whisper)";

  return (
    <ModelCardShell
      accent={accent}
      glowStrong={glowStrong}
      glowSoft={glowSoft}
      dots={dots}
      animated={isDownloading}
      width={width}
      ariaLabel={t({
        id: "models.card.aria",
        message: `${model.label} model`,
      })}
    >
      <div className="px-5 pb-4 pt-3.5">
        <h3
          className="ui-color-primary"
          style={{
            fontSize: "1.1875rem",
            fontWeight: 650,
            letterSpacing: "-0.015em",
          }}
        >
          {model.label}
        </h3>

        <div className="mt-2 flex items-center justify-between gap-2">
          <p
            className="ui-color-muted min-w-0 truncate font-mono tabular-nums"
            style={{ fontSize: "11.5px" }}
            title={isDownloading && !isVerifying ? downloadingFile : undefined}
          >
            {isVerifying
              ? t({
                  id: "models.card.verifying",
                  message: "Verifying install",
                })
              : isDownloading
                ? downloadingFile ||
                  t({ id: "models.card.downloading", message: "Downloading" })
                : facts.join("  ·  ")}
          </p>

          {isDownloading ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {isVerifying ? (
                <ActivityDots />
              ) : (
                <span
                  className="font-mono tabular-nums ui-color-primary"
                  style={{ fontSize: "11.5px" }}
                >
                  {Math.round(percent)}%
                </span>
              )}
              <button
                type="button"
                onClick={onCancel}
                className="flex h-7 w-7 items-center justify-center rounded-md text-error transition-colors hover:bg-error/10"
                title={t({ id: "models.card.cancel", message: "Cancel" })}
                aria-label={t({
                  id: "models.card.cancel_download",
                  message: "Cancel download",
                })}
              >
                <Square size={11} fill="currentColor" aria-hidden="true" />
              </button>
            </div>
          ) : installed && !builtIn ? (
            <button
              type="button"
              onClick={onDelete}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-content-disabled transition-colors hover:bg-error/10 hover:text-error"
              title={t({ id: "models.card.delete", message: "Delete" })}
              aria-label={t({
                id: "models.card.delete_model",
                message: "Delete model",
              })}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
          ) : model.downloadable ? (
            <button
              type="button"
              onClick={onDownload}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-success)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)]"
              title={t({ id: "models.card.download", message: "Download" })}
              aria-label={t({
                id: "models.card.download_model",
                message: "Download model",
              })}
            >
              <Download size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </ModelCardShell>
  );
};

export default ModelStatCard;
