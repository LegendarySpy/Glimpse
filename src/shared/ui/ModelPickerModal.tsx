import { useLingui } from "@lingui/react/macro";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  WarningCircle as AlertCircle,
  MagnifyingGlass as Search,
  Clock,
  Funnel,
  Check,
  Download,
  Info,
  Square,
  Trash as Trash2,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import {
  deriveModelStats,
  formatModelSize,
  isBuiltInModel,
  variantLabel,
} from "../lib/modelStats";
import {
  hasModelCapability,
  MODEL_CAPABILITY_STREAMING,
  MODEL_CAPABILITY_TIMESTAMPS,
} from "../lib/modelCapabilities";
import { useShiftHeld } from "../hooks/useShiftHeld";
import { useClickOutside } from "../hooks/useClickOutside";
import DotMatrix from "./DotMatrix";
import type { DownloadEvent, ModelInfo } from "../../types";

const CATEGORY_ORDER = ["standard", "experimental", "legacy"] as const;
const VARIANT_ORDER = ["Q5_1", "Q5_0", "Q8_0", "Full", "Int8"];

type ModelGroup = {
  id: string;
  label: string;
  category: string;
  englishOnly: boolean;
  variants: ModelInfo[];
  haystack: string;
};

const variantRank = (variant: string): number => {
  const index = VARIANT_ORDER.indexOf(variant);
  return index === -1 ? VARIANT_ORDER.length : index;
};

const groupModels = (catalog: ModelInfo[]): ModelGroup[] => {
  const byId = new Map<string, ModelInfo[]>();
  for (const model of catalog) {
    const id = model.family;
    const list = byId.get(id);
    if (list) list.push(model);
    else byId.set(id, [model]);
  }
  const groups: ModelGroup[] = [];
  for (const [id, variants] of byId) {
    variants.sort((a, b) => variantRank(a.variant) - variantRank(b.variant));
    const englishOnly = deriveModelStats(variants[0]).englishOnly;
    const category = variants[0].category;
    const label = variants[0].label.replace(/\s*\([^)]*\)\s*/g, "").trim();
    const haystack = [
      label,
      category,
      ...variants.flatMap((v) => [v.engine_id, ...v.tags]),
    ]
      .join(" ")
      .toLowerCase();
    groups.push({ id, label, category, englishOnly, variants, haystack });
  }
  return groups.sort((a, b) => a.variants[0].size_mb - b.variants[0].size_mb);
};

const defaultVariantKey = (group: ModelGroup, activeKey: string): string => {
  const active = group.variants.find((v) => v.key === activeKey);
  if (active) return active.key;
  const q8 = group.variants.find((v) => v.variant === "Q8_0");
  if (q8) return q8.key;
  return group.variants[group.variants.length - 1].key;
};

type ModelPickerData = {
  catalog: ModelInfo[];
  activeKey: string;
  isInstalled: (key: string) => boolean;
  isAneInstalled?: (key: string) => boolean;
  progressFor: (key: string) => DownloadEvent | undefined;
  onUse: (key: string) => void;
  onDownload: (key: string, ane?: boolean) => void;
  onDelete: (key: string) => void;
  onCancel: (key: string) => void;
};

type ModelPickerPanelProps = ModelPickerData & {
  className?: string;
  fadeColor?: string;
};

export function ModelPickerPanel({
  catalog,
  activeKey,
  isInstalled,
  isAneInstalled,
  progressFor,
  onUse,
  onDownload,
  onDelete,
  onCancel,
  className,
  fadeColor = "var(--color-bg-tertiary)",
}: ModelPickerPanelProps) {
  const { t } = useLingui();
  const [modelSearch, setModelSearch] = useState("");
  const [quantByGroup, setQuantByGroup] = useState<Record<string, string>>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const shiftHeld = useShiftHeld();
  useClickOutside(filterRef, () => setFilterOpen(false), filterOpen);

  const categoryLabel = (category: string) => {
    switch (category) {
      case "standard":
        return t({ id: "model_picker.category.standard", message: "Standard" });
      case "experimental":
        return t({
          id: "model_picker.category.experimental",
          message: "Experimental",
        });
      case "legacy":
        return t({ id: "model_picker.category.legacy", message: "Legacy" });
      default:
        return category;
    }
  };

  const groups = useMemo(
    () =>
      groupModels(
        catalog.filter((model) => model.downloadable || isInstalled(model.key)),
      ),
    [catalog, isInstalled],
  );

  const availableCategories = useMemo(() => {
    const present = new Set(groups.map((group) => group.category));
    return CATEGORY_ORDER.filter((category) => present.has(category));
  }, [groups]);

  const filteredGroups = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return groups.filter((group) => {
      if (categoryFilter && group.category !== categoryFilter) return false;
      return query ? group.haystack.includes(query) : true;
    });
  }, [groups, modelSearch, categoryFilter]);

  const sections = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        groups: filteredGroups.filter((group) => group.category === category),
      })).filter((section) => section.groups.length > 0),
    [filteredGroups],
  );

  const renderGroup = (group: ModelGroup) => {
    const selectedKey =
      quantByGroup[group.id] ?? defaultVariantKey(group, activeKey);
    const selected =
      group.variants.find((v) => v.key === selectedKey) ?? group.variants[0];
    return (
      <ModelRow
        key={group.id}
        group={group}
        selected={selected}
        active={selected.key === activeKey}
        installed={isInstalled(selected.key)}
        aneInstalled={isAneInstalled?.(selected.key) ?? false}
        isVariantInstalled={isInstalled}
        shiftHeld={shiftHeld}
        progress={progressFor(selected.key)}
        onSelectVariant={(key) =>
          setQuantByGroup((prev) => ({ ...prev, [group.id]: key }))
        }
        onUse={() => onUse(selected.key)}
        onDownload={(ane) => onDownload(selected.key, ane)}
        onDelete={() => onDelete(selected.key)}
        onCancel={() => onCancel(selected.key)}
      />
    );
  };

  return (
    <div className={`flex min-h-0 flex-col ${className ?? ""}`}>
      <div className="px-2 pb-3 pt-0.5">
        <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-interactive)] px-3 py-1.5 transition-colors focus-within:bg-[var(--surface-interactive-strong)]">
          <Search size={14} className="shrink-0 text-content-muted" />
          <input
            value={modelSearch}
            onChange={(event) => setModelSearch(event.target.value)}
            placeholder={t({
              id: "model_picker.search",
              message: "Search models",
            })}
            aria-label={t({
              id: "model_picker.search_aria",
              message: "Search models",
            })}
            className="min-w-0 flex-1 bg-transparent ui-text-body-sm ui-color-primary placeholder-content-muted outline-none"
          />

          {availableCategories.length > 1 && (
            <div className="relative shrink-0" ref={filterRef}>
              <button
                type="button"
                onClick={() => setFilterOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={filterOpen}
                aria-label={t({
                  id: "model_picker.filter.aria",
                  message: "Filter models by category",
                })}
                className={`ui-button-ghost h-6 w-6 ${
                  categoryFilter ? "text-content-primary" : ""
                }`}
              >
                <Funnel
                  size={13}
                  weight={categoryFilter ? "fill" : "regular"}
                  aria-hidden="true"
                />
              </button>
              <AnimatePresence>
                {filterOpen && (
                  <motion.div
                    role="menu"
                    initial={{ opacity: 0, scale: 0.98, y: -2 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: -2 }}
                    transition={{ duration: 0.12 }}
                    className="ui-surface-menu absolute right-0 top-full z-30 mt-1.5 min-w-[160px] py-1"
                  >
                    {[
                      {
                        value: "all",
                        label: t({
                          id: "model_picker.filter.all",
                          message: "All models",
                        }),
                      },
                      ...availableCategories.map((category) => ({
                        value: category as string,
                        label: categoryLabel(category),
                      })),
                    ].map((opt) => {
                      const selected = opt.value === (categoryFilter ?? "all");
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          onClick={() => {
                            setCategoryFilter(
                              opt.value === "all" ? null : opt.value,
                            );
                            setFilterOpen(false);
                          }}
                          className={`flex w-full items-center justify-between gap-3 px-3 py-1 ui-text-body-sm transition-colors ${
                            selected
                              ? "ui-color-primary bg-[var(--surface-interactive-strong)]"
                              : "ui-color-secondary hover:bg-[var(--surface-interactive)] hover:text-content-primary"
                          }`}
                        >
                          <span>{opt.label}</span>
                          <span className="flex w-3 items-center justify-center shrink-0">
                            {selected && <Check size={12} aria-hidden="true" />}
                          </span>
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto py-3 pl-2 pr-3">
          {filteredGroups.length === 0 ? (
            <p className="py-10 text-center ui-text-body-sm text-content-muted">
              {t({
                id: "model_picker.no_results",
                message: "No models match your search.",
              })}
            </p>
          ) : (
            <div className="flex flex-col">
              {sections.map((section) => (
                <div key={section.category} className="flex flex-col">
                  <div className="flex items-center gap-3 px-1 pb-1.5 pt-3 first:pt-0">
                    <span className="ui-text-body-sm-strong ui-color-secondary shrink-0">
                      {categoryLabel(section.category)}
                    </span>
                    <div
                      className="ui-divider-trailing flex-1"
                      aria-hidden="true"
                    />
                  </div>
                  {section.groups.map((group) => renderGroup(group))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-0 right-3 top-0 h-5"
          style={{
            background: `linear-gradient(to bottom, ${fadeColor}, transparent)`,
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-0 right-3 bottom-0 h-5"
          style={{
            background: `linear-gradient(to top, ${fadeColor}, transparent)`,
          }}
        />
      </div>
    </div>
  );
}

type ModelPickerModalProps = ModelPickerData & {
  open: boolean;
  onClose: () => void;
  title?: string;
};

export default function ModelPickerModal({
  open,
  onClose,
  title,
  ...data
}: ModelPickerModalProps) {
  const { t } = useLingui();

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="model-picker"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6 backdrop-blur-xs"
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-picker-title"
            initial={{ scale: 0.97, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="flex h-[34rem] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border-primary bg-surface-tertiary ui-shadow-modal-deep"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 pt-4">
              <h2
                id="model-picker-title"
                className="ui-text-body-lg font-semibold text-content-primary"
              >
                {title ??
                  t({ id: "model_picker.title", message: "Choose a model" })}
              </h2>
              <button
                type="button"
                onClick={onClose}
                className="flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-elevated hover:text-content-primary"
                aria-label={t({ id: "model_picker.close", message: "Close" })}
              >
                <X size={16} />
              </button>
            </div>

            <ModelPickerPanel
              {...data}
              className="flex-1 px-3 pt-3"
              fadeColor="var(--color-bg-tertiary)"
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function ModelRow({
  group,
  selected,
  active,
  installed,
  aneInstalled,
  isVariantInstalled,
  shiftHeld,
  progress,
  onSelectVariant,
  onUse,
  onDownload,
  onDelete,
  onCancel,
}: {
  group: ModelGroup;
  selected: ModelInfo;
  active: boolean;
  installed: boolean;
  aneInstalled: boolean;
  isVariantInstalled: (key: string) => boolean;
  shiftHeld: boolean;
  progress?: DownloadEvent;
  onSelectVariant: (key: string) => void;
  onUse: () => void;
  onDownload: (ane?: boolean) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [aneUserChoice, setAneUserChoice] = useState<boolean | null>(null);
  const aneChecked = aneUserChoice ?? !installed;
  const isStreaming = hasModelCapability(selected, MODEL_CAPABILITY_STREAMING);
  const hasTimestamps = hasModelCapability(
    selected,
    MODEL_CAPABILITY_TIMESTAMPS,
  );
  const isDownloading = progress?.status === "downloading";
  const isVerifying =
    progress?.status === "downloading" && progress.verifying === true;
  const showError = progress?.status === "error";
  const isCancelled = progress?.status === "cancelled";
  const isBusy = isDownloading || showError || isCancelled;
  const percent = Math.round(progress?.percent ?? 0);
  const showQuants = group.variants.length > 1 && !isBusy;
  const aneAvailable = selected.ane_size_mb != null;
  const aneOn = aneAvailable && (aneInstalled || aneChecked);
  const encoderDownloadPending =
    installed && aneAvailable && aneChecked && !aneInstalled;
  const showAne = aneAvailable && !isBusy;
  const displaySize =
    selected.size_mb + (aneOn ? (selected.ane_size_mb ?? 0) : 0);
  const downloadLabel = installed
    ? t({
        id: "model_picker.ane.download",
        message: "Download Neural Engine encoder",
      })
    : t({ id: "model_picker.download", message: "Download" });

  return (
    <div className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-surface-elevated/40">
      <button
        type="button"
        onClick={
          !installed && selected.downloadable
            ? () => onDownload(aneOn)
            : encoderDownloadPending
              ? () => onDownload(true)
              : onUse
        }
        title={
          encoderDownloadPending
            ? downloadLabel
            : installed && !active
              ? t({ id: "model_picker.use", message: "Use" })
              : undefined
        }
        className="flex min-w-0 items-center gap-2.5 text-left"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
            active
              ? "bg-local"
              : installed
                ? "bg-content-disabled/50"
                : "bg-transparent"
          }`}
        />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5 ui-text-body-sm-strong text-content-primary">
            <span className="truncate">{group.label}</span>
            {active && (
              <span className="sr-only">
                {" "}
                {t({ id: "model_picker.active", message: "Active" })}
              </span>
            )}
            {isStreaming && (
              <span
                className="inline-flex shrink-0 text-content-muted"
                title={t({
                  id: "model_picker.capability.streaming",
                  message: "Live streaming",
                })}
              >
                <Waveform size={13} aria-hidden="true" />
              </span>
            )}
            {hasTimestamps && (
              <span
                className="inline-flex shrink-0 text-content-muted"
                title={t({
                  id: "model_picker.capability.timestamps",
                  message: "Word-level timestamps",
                })}
              >
                <Clock size={13} aria-hidden="true" />
              </span>
            )}
          </span>
          <span className="mt-0.5 block ui-text-meta tabular-nums text-content-muted">
            {group.englishOnly
              ? t({ id: "model_picker.english", message: "English" })
              : t({ id: "model_picker.multilingual", message: "Multilingual" })}
            {"  ·  "}
            {isBuiltInModel(selected)
              ? t({ id: "model_picker.built_in", message: "Built in" })
              : formatModelSize(displaySize)}
          </span>
        </span>
      </button>

      <div className="flex items-center justify-end gap-3">
        {showQuants && (
          <div className="inline-flex items-center overflow-hidden rounded-md border border-border-secondary">
            {group.variants.map((variant, index) => {
              const isSel = variant.key === selected.key;
              const variantInstalled = isVariantInstalled(variant.key);
              return (
                <button
                  key={variant.key}
                  type="button"
                  onClick={() => onSelectVariant(variant.key)}
                  aria-pressed={isSel}
                  className={`px-2.5 py-1 font-mono ui-text-micro tabular-nums transition-colors ${
                    index > 0 ? "border-l border-border-secondary" : ""
                  } ${isSel ? "bg-local-15" : "hover:bg-surface-elevated/60"} ${
                    variantInstalled
                      ? "text-local"
                      : isSel
                        ? "text-content-secondary"
                        : "text-content-muted hover:text-content-primary"
                  }`}
                  title={
                    variantInstalled
                      ? t({
                          id: "model_picker.variant_installed",
                          message: "Model variant (installed)",
                        })
                      : t({
                          id: "model_picker.variant",
                          message: "Model variant",
                        })
                  }
                >
                  {variantLabel(variant.variant)}
                </button>
              );
            })}
          </div>
        )}

        {showAne && (
          <AneCheckbox
            checked={aneOn}
            installed={aneInstalled}
            onToggle={() => setAneUserChoice(!aneChecked)}
          />
        )}

        {isBusy ? (
          <>
            <div className="flex w-[140px] flex-col items-end justify-center">
              <ModelProgressDots percent={percent} status={progress!.status} />
              <div className="mt-1 flex h-3 w-full items-center justify-end">
                {isVerifying ? (
                  <p className="truncate text-right ui-text-micro tabular-nums text-content-disabled">
                    {t({
                      id: "models.card.verifying",
                      message: "Verifying install",
                    })}
                  </p>
                ) : isDownloading ? (
                  <p className="truncate text-right ui-text-micro tabular-nums text-content-disabled">
                    {percent}% ·{" "}
                    {
                      (
                        progress as Extract<
                          DownloadEvent,
                          { status: "downloading" }
                        >
                      ).file
                    }
                  </p>
                ) : null}
                {showError && (
                  <p className="flex w-full items-center justify-end gap-1 ui-text-micro text-error">
                    <AlertCircle size={9} className="shrink-0" />
                    <span className="truncate">
                      {
                        (
                          progress as Extract<
                            DownloadEvent,
                            { status: "error" }
                          >
                        ).message
                      }
                    </span>
                  </p>
                )}
                {isCancelled && (
                  <p className="text-right ui-text-micro text-content-disabled">
                    {t({ id: "model_picker.cancelled", message: "Cancelled" })}
                  </p>
                )}
              </div>
            </div>
            <div className="flex w-7 shrink-0 items-center justify-end">
              {isDownloading && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-error transition-colors hover:bg-error/10"
                  title={t({ id: "model_picker.cancel", message: "Cancel" })}
                >
                  <Square size={10} fill="currentColor" aria-hidden="true" />
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-1">
            <span className="flex h-6 w-6 items-center justify-center">
              {((!installed && selected.downloadable) ||
                (showAne && aneChecked && !aneInstalled)) && (
                <button
                  type="button"
                  onClick={() => onDownload(installed || aneOn)}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-content-secondary transition-colors hover:bg-surface-elevated/60 hover:text-content-primary"
                  title={downloadLabel}
                  aria-label={downloadLabel}
                >
                  <Download size={13} aria-hidden="true" />
                </button>
              )}
            </span>
            <span className="flex h-6 w-6 items-center justify-center">
              {installed && (
                <button
                  type="button"
                  onClick={onDelete}
                  className={`flex h-6 w-6 items-center justify-center rounded-md transition-all hover:bg-error/10 hover:text-error ${
                    shiftHeld
                      ? "text-error opacity-100"
                      : "text-content-disabled opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:text-error"
                  }`}
                  title={t({ id: "model_picker.delete", message: "Delete" })}
                  aria-label={t({
                    id: "model_picker.delete",
                    message: "Delete",
                  })}
                >
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function AneCheckbox({
  checked,
  installed,
  onToggle,
}: {
  checked: boolean;
  installed: boolean;
  onToggle: () => void;
}) {
  const { t } = useLingui();
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);
  useClickOutside(infoRef, () => setInfoOpen(false), infoOpen);

  return (
    <div className="relative flex items-center gap-1" ref={infoRef}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={installed}
        onClick={onToggle}
        title={
          installed
            ? t({
                id: "model_picker.ane.installed",
                message: "Neural Engine encoder installed",
              })
            : t({
                id: "model_picker.ane.toggle",
                message: "Include the Apple Neural Engine encoder",
              })
        }
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors enabled:hover:bg-surface-elevated/60 disabled:cursor-default"
      >
        <span
          aria-hidden="true"
          className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border transition-colors ${
            checked
              ? "border-local bg-local-15 text-local"
              : "border-border-secondary text-transparent"
          }`}
        >
          {checked && <Check size={9} weight="bold" />}
        </span>
        <span
          className={`font-mono ui-text-micro ${
            installed
              ? "text-local"
              : checked
                ? "text-content-secondary"
                : "text-content-muted"
          }`}
        >
          ANE
        </span>
      </button>

      <button
        type="button"
        onClick={() => setInfoOpen((open) => !open)}
        aria-expanded={infoOpen}
        aria-label={t({
          id: "model_picker.ane.info_aria",
          message: "About the Apple Neural Engine encoder",
        })}
        className="flex h-5 w-5 items-center justify-center rounded-md text-content-disabled transition-colors hover:bg-surface-elevated/60 hover:text-content-primary"
      >
        <Info size={12} aria-hidden="true" />
      </button>

      <AnimatePresence>
        {infoOpen && (
          <motion.div
            role="tooltip"
            initial={{ opacity: 0, scale: 0.98, y: -2 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -2 }}
            transition={{ duration: 0.12 }}
            className="ui-surface-menu absolute right-0 top-full z-30 mt-1.5 w-60 px-3 py-2"
          >
            <p className="ui-text-meta text-content-secondary">
              {t({
                id: "model_picker.ane.info",
                message:
                  "Adds a Core ML encoder that runs on the Apple Neural Engine for faster, more power-efficient transcription. The first load takes longer while macOS optimizes it for your chip.",
              })}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ModelProgressDots({
  percent,
  status,
}: {
  percent: number;
  status: DownloadEvent["status"];
}) {
  const cols = 36;
  const rows = 2;
  const total = cols * rows;
  const activeCount = Math.min(Math.round((percent / 100) * total), total);
  const activeDots = Array.from({ length: activeCount }, (_, i) => i);
  const color =
    status === "error"
      ? "var(--color-error)"
      : status === "complete"
        ? "var(--color-success)"
        : "var(--color-local)";
  return (
    <DotMatrix
      rows={rows}
      cols={cols}
      activeDots={activeDots}
      dotSize={2}
      gap={2}
      color={color}
      className={status === "downloading" ? "opacity-80" : "opacity-60"}
      morphOnActive
      activeScale={1}
    />
  );
}
