import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ModelPickerModal from "../../../shared/ui/ModelPickerModal";
import ModelStatCard from "../../settings/components/ModelStatCard";
import { isBuiltInModel, formatModelSize } from "../../../shared/lib/modelStats";
import {
  hasModelCapability,
  MODEL_CAPABILITY_DICTIONARY,
  MODEL_CAPABILITY_TIMESTAMPS,
} from "../../../shared/lib/modelCapabilities";
import type { DownloadEvent, ModelInfo, ModelStatus } from "../../../types";
import {
  OnboardingHeader,
  OnboardingStep,
  PRIMARY_BUTTON_CLASS,
  type StepMotionProps,
} from "./shared";

// The Core ML encoder is a separate download, so fold it into the shown size.
const totalSizeMb = (model: ModelInfo) =>
  model.size_mb + (model.ane_size_mb ?? 0);

interface ModelStepProps {
  stepMotionProps: StepMotionProps;
  options: ModelInfo[];
  selectedModel: ModelInfo | null;
  catalog: ModelInfo[];
  modelStatus: Record<string, ModelStatus>;
  displayStateByModel: Record<string, DownloadEvent>;
  activeModelKey: string;
  onUse: (key: string) => void;
  isLoading: boolean;
  unavailable: boolean;
  displayState: DownloadEvent;
  selectedModelReady: boolean;
  showLocalConfirm: boolean;
  onShowConfirm: (show: boolean) => void;
  onDownload: (key: string, ane?: boolean) => void;
  onDelete: (key: string) => void;
  onCancelDownload: (key: string) => void;
  onNext: () => void;
}

export function ModelStep({
  stepMotionProps,
  options,
  selectedModel,
  catalog,
  modelStatus: modelStatusByKey,
  displayStateByModel,
  activeModelKey,
  onUse,
  isLoading,
  unavailable,
  displayState,
  selectedModelReady,
  showLocalConfirm,
  onShowConfirm,
  onDownload,
  onDelete,
  onCancelDownload,
  onNext,
}: ModelStepProps) {
  const { t } = useLingui();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmDismissed, setConfirmDismissed] = useState(false);

  const realStatus = selectedModel
    ? modelStatusByKey[selectedModel.key]
    : undefined;
  const status: ModelStatus | undefined = selectedModel
    ? {
        key: selectedModel.key,
        installed:
          Boolean(realStatus?.installed) || displayState.status === "complete",
        ane_installed: Boolean(realStatus?.ane_installed),
        bytes_on_disk: realStatus?.bytes_on_disk ?? 0,
        missing_files: realStatus?.missing_files ?? [],
        directory: realStatus?.directory ?? "",
      }
    : undefined;
  const progress =
    displayState.status !== "idle" && displayState.status !== "complete"
      ? displayState
      : undefined;

  const capabilityRow = [
    {
      key: MODEL_CAPABILITY_DICTIONARY,
      label: t({
        id: "onboarding.model.capability.dictionary",
        message: "Custom words",
      }),
    },
    {
      key: MODEL_CAPABILITY_TIMESTAMPS,
      label: t({
        id: "onboarding.model.capability.timestamps",
        message: "Timestamps",
      }),
    },
  ];

  const handleContinue = () => {
    if (isLoading) return;
    if (!selectedModelReady) {
      onShowConfirm(true);
      return;
    }
    onNext();
  };

  return (
    <OnboardingStep
      stepKey="model"
      motionProps={stepMotionProps}
      footer={
        <>
          <button
            type="button"
            onClick={handleContinue}
            disabled={isLoading}
            className={PRIMARY_BUTTON_CLASS}
          >
            {t({ id: "onboarding.model.continue", message: "Continue" })}
          </button>
          <div className="flex h-5 items-center justify-center">
            {catalog.length > 0 && (
              <button
                type="button"
                onClick={() => setShowAdvanced(true)}
                className="ui-text-body-sm text-content-muted underline-offset-4 transition-colors hover:text-content-primary hover:underline"
              >
                {t({
                  id: "onboarding.model.browse",
                  message: "Browse all models",
                })}
              </button>
            )}
          </div>
        </>
      }
    >
      <OnboardingHeader
        title={t({ id: "onboarding.model.title", message: "Choose a model" })}
      />

      <div className="mb-6 flex items-center justify-center gap-1.5">
        {options.map((option) => {
          const selected = selectedModel?.key === option.key;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onUse(option.key)}
              aria-pressed={selected}
              className={`flex flex-col items-center gap-0.5 rounded-lg px-5 py-2 transition-colors ${
                selected
                  ? "bg-surface-tertiary text-content-primary"
                  : "text-content-muted hover:text-content-primary"
              }`}
            >
              <span className="ui-text-body-sm-strong">{option.label}</span>
              <span
                className={`ui-text-meta ${
                  selected ? "text-cloud" : "text-content-disabled"
                }`}
              >
                {isBuiltInModel(option)
                  ? t({
                      id: "onboarding.model.option.no_download",
                      message: "No download",
                    })
                  : formatModelSize(totalSizeMb(option))}
              </span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <div className="w-full overflow-hidden rounded-xl border border-border-secondary bg-surface-surface text-left">
          <p className="p-4 ui-text-body-sm text-content-muted">
            {t({
              id: "onboarding.model.loading",
              message: "Finding a model for your device",
            })}
          </p>
        </div>
      ) : !selectedModel ? (
        <div className="w-full overflow-hidden rounded-xl border border-border-secondary bg-surface-surface text-left">
          <p className="p-4 ui-text-body-sm text-content-muted">
            {unavailable
              ? t({
                  id: "onboarding.model.unavailable",
                  message:
                    "Model list unavailable. You can add one later in Settings.",
                })
              : t({
                  id: "onboarding.model.empty",
                  message:
                    "No models found. You can add one later in Settings.",
                })}
          </p>
        </div>
      ) : (
        <>
          <ModelStatCard
            model={{ ...selectedModel, size_mb: totalSizeMb(selectedModel) }}
            status={status}
            progress={progress}
            onDownload={() => onDownload(selectedModel.key)}
            onDelete={() => onDelete(selectedModel.key)}
            onCancel={() => onCancelDownload(selectedModel.key)}
          />
          <div className="mt-3 flex items-center justify-center gap-4">
            {capabilityRow.map((capability) => {
              const supported = hasModelCapability(
                selectedModel,
                capability.key,
              );
              return (
                <span
                  key={capability.key}
                  className={`ui-text-meta ${
                    supported ? "text-content-muted" : "text-content-disabled"
                  }`}
                >
                  {supported ? "✓" : "○"} {capability.label}
                </span>
              );
            })}
          </div>
        </>
      )}

      <ModelPickerModal
        open={showAdvanced}
        onClose={() => setShowAdvanced(false)}
        catalog={catalog}
        activeKey={activeModelKey}
        isInstalled={(key) =>
          Boolean(modelStatusByKey[key]?.installed) ||
          displayStateByModel[key]?.status === "complete"
        }
        isAneInstalled={(key) => Boolean(modelStatusByKey[key]?.ane_installed)}
        progressFor={(key) => displayStateByModel[key]}
        onUse={onUse}
        onDownload={onDownload}
        onDelete={onDelete}
        onCancel={onCancelDownload}
      />

      {createPortal(
        <AnimatePresence>
          {showLocalConfirm && !confirmDismissed && (
            <ConfirmModelDownload
              onStay={() => onShowConfirm(false)}
              onDownload={() => {
                setConfirmDismissed(true);
                onShowConfirm(false);
                if (selectedModel) onDownload(selectedModel.key);
                onNext();
              }}
              onContinue={() => {
                setConfirmDismissed(true);
                onShowConfirm(false);
                onNext();
              }}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </OnboardingStep>
  );
}

function ConfirmModelDownload({
  onStay,
  onDownload,
  onContinue,
}: {
  onStay: () => void;
  onDownload: () => void;
  onContinue: () => void;
}): ReactNode {
  const { t } = useLingui();
  return (
    <motion.div
      key="model-confirm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 backdrop-blur-xs"
      onClick={onStay}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="w-full max-w-sm rounded-2xl border border-border-secondary bg-surface-secondary p-6 text-left ui-shadow-modal-deep"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-model-confirm-title"
      >
        <p
          id="onboarding-model-confirm-title"
          className="ui-text-body-lg font-semibold text-content-primary"
        >
          {t({
            id: "onboarding.model.confirm.title",
            message: "Continue without a model?",
          })}
        </p>
        <p className="mt-1.5 ui-text-label text-content-muted text-pretty">
          {t({
            id: "onboarding.model.confirm.body",
            message:
              "Glimpse needs one to transcribe. The recommended model can download in the background while you finish setup.",
          })}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onContinue}
            className="rounded-lg border border-border-secondary px-4 py-2 ui-text-body-sm font-medium text-content-primary transition-colors hover:bg-surface-hover"
          >
            {t({
              id: "onboarding.model.confirm.continue",
              message: "Skip for now",
            })}
          </button>
          <button
            type="button"
            onClick={onDownload}
            className="rounded-lg bg-content-primary px-4 py-2 ui-text-body-sm font-semibold text-surface-secondary transition-opacity hover:opacity-90"
          >
            {t({
              id: "onboarding.model.confirm.download",
              message: "Download",
            })}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
