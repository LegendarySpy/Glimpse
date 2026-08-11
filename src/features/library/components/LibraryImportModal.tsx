import { useLingui } from "@lingui/react/macro";
import { useEffect, useState, type MouseEvent } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { X, Warning, Plus } from "@phosphor-icons/react";
import { Dropdown, type DropdownOption } from "../../../shared/ui/Dropdown";
import ToggleSwitch from "../../../shared/ui/ToggleSwitch";
import { useShiftHeld } from "../../../shared/hooks/useShiftHeld";
import {
  hasModelCapability,
  MODEL_CAPABILITY_DIARIZATION,
  MODEL_CAPABILITY_TIMESTAMPS,
} from "../../../shared/lib/modelCapabilities";
import {
  SUPPORTED_EXTENSIONS,
  uniquePaths,
  formatDuration,
} from "./library-utils";
import { formatBytes } from "../../../shared/lib/format";
import type { LibraryImportOptions, SpeechModel } from "../../../types";

type ImportFileProbe = {
  path: string;
  duration_ms: number | null;
  size_bytes: number | null;
};

type LibraryImportModalProps = {
  paths: string[];
  models: SpeechModel[];
  defaultModelKey?: string;
  onCancel: () => void;
  onConfirm: (
    paths: string[],
    options: LibraryImportOptions,
  ) => Promise<void> | void;
};

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const LibraryImportModal = ({
  paths,
  models,
  defaultModelKey,
  onCancel,
  onConfirm,
}: LibraryImportModalProps) => {
  const { t } = useLingui();
  const [importPaths, setImportPaths] = useState(paths);
  const [showFileList, setShowFileList] = useState(paths.length > 1);
  const [probes, setProbes] = useState<Record<string, ImportFileProbe>>({});
  const [storeOriginal, setStoreOriginal] = useState(true);
  const shiftHeld = useShiftHeld();
  const [selectedModelKey, setSelectedModelKey] = useState<string>(
    defaultModelKey || "",
  );
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [detectSpeakers, setDetectSpeakers] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const modelOptions: DropdownOption<string>[] = models.map((model) => ({
    value: model.id,
    label: model.label,
    description: model.remote
      ? t({
          id: "library.import.remote_provider",
          message: "Remote provider",
        })
      : model.description,
  }));

  useEffect(() => {
    if (!selectedModelKey && modelOptions.length > 0) {
      setSelectedModelKey(modelOptions[0].value);
    }
  }, [modelOptions, selectedModelKey]);

  const selectedModel =
    models.find((model) => model.id === selectedModelKey) ?? null;
  const timestampsSupported =
    Boolean(selectedModel?.remote) ||
    hasModelCapability(selectedModel, MODEL_CAPABILITY_TIMESTAMPS);
  const diarizationSupported = hasModelCapability(
    selectedModel,
    MODEL_CAPABILITY_DIARIZATION,
  );

  useEffect(() => {
    if (!timestampsSupported) {
      setShowTimestamps(false);
    }
  }, [timestampsSupported]);

  useEffect(() => {
    if (!diarizationSupported) {
      setDetectSpeakers(false);
    }
  }, [diarizationSupported]);

  useEffect(() => {
    if (importPaths.length > 1) {
      setShowFileList(true);
    }
  }, [importPaths.length]);

  useEffect(() => {
    const unprobed = importPaths.filter((path) => !(path in probes));
    if (unprobed.length === 0) return;
    let cancelled = false;
    invoke<ImportFileProbe[]>("probe_library_import_files", {
      paths: unprobed,
    })
      .then((results) => {
        if (cancelled) return;
        setProbes((current) => {
          const next = { ...current };
          for (const probe of results) {
            next[probe.path] = probe;
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [importPaths, probes]);

  const fileMeta = (path: string) => {
    const probe = probes[path];
    if (!probe) return "";
    return [
      probe.duration_ms != null
        ? formatDuration(probe.duration_ms / 1000)
        : null,
      probe.size_bytes != null ? formatBytes(probe.size_bytes) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const singleMeta = importPaths.length === 1 ? fileMeta(importPaths[0]) : "";
  const summary =
    importPaths.length === 1
      ? [fileName(importPaths[0]), singleMeta].filter(Boolean).join(" · ")
      : t({
          id: "library.import.summary.multiple",
          message: `${importPaths.length} files`,
        });

  const removePath = (idx: number) => {
    setImportPaths((current) => current.filter((_, i) => i !== idx));
  };

  const handleAddFiles = async () => {
    try {
      const selection = await open({
        multiple: true,
        filters: [
          {
            name: t({
              id: "library.view.file_filter",
              message: "Audio & Video",
            }),
            extensions: SUPPORTED_EXTENSIONS,
          },
        ],
      });
      if (!selection) return;
      const added = Array.isArray(selection) ? selection : [selection];
      setImportPaths((current) => uniquePaths([...current, ...added]));
    } catch (err) {
      console.error("Failed to open add files dialog:", err);
    }
  };

  const handleConfirm = async () => {
    if (!selectedModelKey) return;
    setIsImporting(true);
    try {
      const options: LibraryImportOptions = {
        store_original: storeOriginal,
        model_key: selectedModelKey,
        llm_cleanup_enabled: false,
        show_timestamps: showTimestamps,
        detect_speakers: diarizationSupported ? detectSpeakers : false,
      };
      await onConfirm(importPaths, options);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 px-6 backdrop-blur-xs"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="relative w-[440px] max-w-[92vw] rounded-2xl border border-border-primary bg-surface-tertiary ui-shadow-modal-deep"
        onClick={(e: MouseEvent<HTMLDivElement>) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-4">
          <div className="min-w-0">
            <h2 className="ui-text-body-lg font-semibold text-content-primary">
              {t({
                id: "library.import.title",
                message: "Import to Library",
              })}
            </h2>
            <p className="mt-0.5 truncate ui-text-meta text-content-muted">
              {summary}
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label={t({
              id: "library.import.close",
              message: "Close",
            })}
            className="ml-3 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-elevated hover:text-content-primary"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-col gap-5 px-5 py-5">
          {modelOptions.length === 0 && (
            <div className="flex items-start gap-2 ui-text-body-sm ui-color-warning-strong">
              <Warning
                size={15}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <span>
                {t({
                  id: "library.import.no_models",
                  message:
                    "No models available. Configure a remote provider or download a local model in Settings -> Models before importing.",
                })}
              </span>
            </div>
          )}

          {showFileList && (
            <div className="max-h-24 overflow-y-auto custom-scrollbar">
              {importPaths.map((path, idx) => (
                <div
                  key={`${path}-${idx}`}
                  title={path}
                  className="group flex items-center gap-2 py-0.5"
                >
                  <span className="min-w-0 flex-1 truncate ui-text-body-sm text-content-secondary">
                    {fileName(path)}
                  </span>
                  <span className="shrink-0 ui-text-meta text-content-disabled">
                    {fileMeta(path)}
                  </span>
                  <button
                    onClick={() => removePath(idx)}
                    aria-label={t({
                      id: "library.import.remove_file",
                      message: `Remove ${fileName(path)}`,
                    })}
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-content-disabled transition-all hover:bg-surface-elevated hover:text-content-primary focus-visible:opacity-100 group-hover:opacity-100 ${
                      shiftHeld ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {importPaths.length === 0 && (
                <p className="py-0.5 ui-text-body-sm text-content-disabled">
                  {t({
                    id: "library.import.no_files",
                    message: "No files left to import",
                  })}
                </p>
              )}
            </div>
          )}

          <div>
            <label className="ui-text-label text-content-muted">
              {t({
                id: "library.import.model",
                message: "Model",
              })}
            </label>
            <div className="mt-1.5">
              <Dropdown
                value={selectedModelKey || null}
                onChange={(value) => setSelectedModelKey(value)}
                options={modelOptions}
                placeholder={t({
                  id: "library.import.select_model",
                  message: "Select a model",
                })}
                searchable
                searchPlaceholder={t({
                  id: "library.import.search_models",
                  message: "Search installed models...",
                })}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="ui-text-body-sm text-content-primary">
                {t({
                  id: "library.import.store_original",
                  message: "Store original file",
                })}
              </div>
              <div className="ui-text-meta text-content-disabled">
                {t({
                  id: "library.import.store_original.description",
                  message: "Keep a copy inside the library folder",
                })}
              </div>
            </div>
            <ToggleSwitch
              enabled={storeOriginal}
              onToggle={() => setStoreOriginal(!storeOriginal)}
              ariaLabel={t({
                id: "library.import.store_original.aria",
                message: "Store original",
              })}
              size="md"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="ui-text-body-sm text-content-primary">
                {t({
                  id: "library.import.show_timestamps",
                  message: "Show timestamps",
                })}
              </div>
              <div className="ui-text-meta text-content-disabled">
                {timestampsSupported
                  ? t({
                      id: "library.import.timestamps_supported",
                      message: "Enabled for supported models",
                    })
                  : t({
                      id: "library.import.timestamps_unsupported",
                      message: "Not supported by this model",
                    })}
              </div>
            </div>
            <ToggleSwitch
              enabled={showTimestamps}
              onToggle={() =>
                timestampsSupported && setShowTimestamps(!showTimestamps)
              }
              ariaLabel={t({
                id: "library.import.show_timestamps.aria",
                message: "Show timestamps",
              })}
              disabled={!timestampsSupported}
              size="md"
            />
          </div>

          {diarizationSupported && (
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="ui-text-body-sm text-content-primary">
                  {t({
                    id: "library.import.detect_speakers",
                    message: "Detect speakers",
                  })}
                </div>
                <div className="ui-text-meta text-content-disabled">
                  {t({
                    id: "library.import.detect_speakers.description",
                    message: "Label segments by speaker automatically",
                  })}
                </div>
              </div>
              <ToggleSwitch
                enabled={detectSpeakers}
                onToggle={() => setDetectSpeakers(!detectSpeakers)}
                ariaLabel={t({
                  id: "library.import.detect_speakers.aria",
                  message: "Detect speakers",
                })}
                size="md"
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 pb-4">
          <button
            onClick={handleAddFiles}
            className="flex items-center gap-1.5 rounded-lg px-2 py-2 ui-text-body-sm font-medium text-content-muted transition-colors hover:text-content-primary"
          >
            <Plus size={12} aria-hidden="true" />
            {t({
              id: "library.import.add_files",
              message: "Add files",
            })}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              className="rounded-lg px-3 py-2 ui-text-body-sm font-medium text-content-muted transition-colors hover:text-content-primary"
            >
              {t({
                id: "library.import.cancel",
                message: "Cancel",
              })}
            </button>
            <button
              onClick={handleConfirm}
              disabled={
                isImporting || importPaths.length === 0 || !selectedModelKey
              }
              className="rounded-lg bg-amber-400 px-4 py-2 ui-text-body-sm font-semibold ui-color-on-warning transition-colors hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isImporting
                ? t({
                    id: "library.import.importing",
                    message: "Importing...",
                  })
                : t({
                    id: "library.import.confirm",
                    message: "Import",
                  })}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default LibraryImportModal;
