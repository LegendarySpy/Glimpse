import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMachine } from "@xstate/react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { AnimatePresence, MotionConfig } from "framer-motion";
import { CaretLeft as ChevronLeft } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useModelDownloadEvents } from "../../shared/hooks/useModelDownloadEvents";
import { isBuiltInModel } from "../../shared/lib/modelStats";
import { requestMacAccessibilityPermission } from "../../shared/lib/macosPermissions";
import { checkoutUrlFor, type PurchaseTier } from "../license/purchaseConfig";
import { useSettings } from "../settings/queries";
import { getSettings } from "../settings/api";
import {
  modelKeys,
  useModelCatalog,
  useModelStatuses,
} from "../settings/models-queries";
import { onboardingMachine, getSteps } from "./machine";
import { getDefaultShortcuts, getOnboardingPlatform } from "./platform";
import { useImportableApps } from "../import/queries";
import { ImportStep } from "../import/components/ImportStep";
import { WelcomeStep } from "./steps/WelcomeStep";
import { ModelStep } from "./steps/ModelStep";
import { PermissionsStep } from "./steps/PermissionsStep";
import { ReadyStep } from "./steps/ReadyStep";
import { LicenseModal } from "./steps/LicenseModal";
import { StepIndicator } from "./steps/shared";
import { useActivateLicense, useLicenseState } from "../license/queries";
import FAQModal from "../../shared/ui/FAQModal";
import WindowControls from "../../shared/ui/WindowControls";
import type { DownloadEvent, ModelInfo, ModelStatus } from "../../types";

const ONBOARDING_MODEL_KEYS = [
  "whisper_large_v3_turbo_q8",
  "parakeet_tdt_int8",
] as const;

const ONBOARDING_COMPACT_MODEL_KEY = "whisper_small_q5";

const onboardingPermissionKeys = {
  all: ["onboarding", "permissions"] as const,
  microphone: () => [...onboardingPermissionKeys.all, "microphone"] as const,
  accessibility: () =>
    [...onboardingPermissionKeys.all, "accessibility"] as const,
};

const downloadableModels = (models: ModelInfo[]) =>
  models.filter((model) => model.downloadable);

const pickOnboardingModels = (models: ModelInfo[]) => {
  const available = downloadableModels(models);
  const byKey = (key: string) =>
    available.find((model) => model.key === key) ?? null;

  return [
    ...ONBOARDING_MODEL_KEYS.map(byKey),
    available.find(isBuiltInModel) ?? byKey(ONBOARDING_COMPACT_MODEL_KEY),
  ].filter((model): model is ModelInfo => Boolean(model));
};

const pickDefaultOnboardingModel = (
  models: ModelInfo[],
  persistedModel: string,
) => {
  const available = downloadableModels(models);
  if (
    persistedModel &&
    available.some((model) => model.key === persistedModel)
  ) {
    return persistedModel;
  }
  return pickOnboardingModels(models)[0]?.key ?? persistedModel;
};

const checkMicrophonePermission = () =>
  invoke<boolean>("check_microphone_permission");

const checkAccessibilityPermission = () =>
  invoke<boolean>("check_accessibility_permission");

const refreshModelStatus = (queryClient: QueryClient, model: string) =>
  queryClient.invalidateQueries({ queryKey: modelKeys.status(model) });

type OnboardingSettings = Awaited<ReturnType<typeof getSettings>>;

const buildSettingsArgs = (
  latest: OnboardingSettings,
  smartShortcut: string,
  transcriptionMode: string,
  localModel: string,
  autoLaunchEnabled: boolean,
) => {
  const { hold: holdShortcut, toggle: toggleShortcut } = getDefaultShortcuts(
    getOnboardingPlatform().id,
  );
  return {
    smartShortcut,
    smartEnabled: true,
    holdShortcut,
    holdEnabled: false,
    toggleShortcut,
    toggleEnabled: false,
    shortcutBindings: {
      smart: [
        { shortcut: smartShortcut, temporary: false, cleanup_enabled: false },
      ],
      hold: [
        { shortcut: holdShortcut, temporary: false, cleanup_enabled: false },
      ],
      toggle: [
        { shortcut: toggleShortcut, temporary: false, cleanup_enabled: false },
      ],
    },
    transcriptionMode,
    localModel,
    remoteSpeechEnabled: false,
    remoteSpeechProvider: latest.remote_speech_provider ?? "custom",
    remoteSpeechEndpoint: latest.remote_speech_endpoint ?? "",
    remoteSpeechApiKey: latest.remote_speech_api_key ?? "",
    remoteSpeechModel: latest.remote_speech_model ?? "",
    microphoneDevice: latest.microphone_device ?? null,
    language: latest.language ?? "",
    appLocale: latest.app_locale ?? "system",
    themeMode: latest.theme_mode ?? "system",
    llmEnabled: false,
    cleanupEnabled: false,
    llmProvider: latest.llm_provider ?? "none",
    llmEndpoint: latest.llm_endpoint ?? "",
    llmApiKey: latest.llm_api_key ?? "",
    llmModel: latest.llm_model ?? "",
    autoDictionaryEnabled: false,
    mediaAction: "pause",
    autoUpdateEnabled: true,
    autoLaunchEnabled,
    startInBackground: latest.start_in_background ?? false,
    autoDeleteTarget: latest.auto_delete_target ?? "transcripts",
    autoDeleteDuration: latest.auto_delete_duration ?? "never",
    analyticsEnabled: latest.analytics_enabled ?? true,
    localApiKey: latest.local_api_key ?? "",
    localApiPort: latest.local_api_port ?? 11435,
    localApiModel: latest.local_api_model ?? "auto",
    localApiHost: latest.local_api_host ?? "127.0.0.1",
    localApiStartOnLaunch: latest.local_api_start_on_launch ?? false,
    localApiCors: latest.local_api_cors ?? false,
  };
};

interface OnboardingScreenProps {
  onComplete: () => void;
}

const stepTransitionVariants = {
  enter: (direction: 1 | -1) => ({ opacity: 0, x: direction > 0 ? 28 : -28 }),
  center: { opacity: 1, x: 0 },
  exit: (direction: 1 | -1) => ({ opacity: 0, x: direction > 0 ? -28 : 28 }),
};

export default function OnboardingScreen({
  onComplete,
}: OnboardingScreenProps) {
  const { t } = useLingui();
  const [state, send] = useMachine(onboardingMachine);
  const [downloadStatus, setDownloadStatus] = useState<
    Record<string, DownloadEvent>
  >({});
  const [openingLicenseTarget, setOpeningLicenseTarget] =
    useState<PurchaseTier | null>(null);
  const [licenseOpenError, setLicenseOpenError] = useState<string | null>(null);
  const [showLicenseModal, setShowLicenseModal] = useState(false);
  const ctx = state.context;
  const queryClient = useQueryClient();

  const importableAppsQuery = useImportableApps();

  useEffect(() => {
    if (importableAppsQuery.data) {
      send({ type: "SET_IMPORTABLE", apps: importableAppsQuery.data });
    }
  }, [importableAppsQuery.data, send]);

  const hasImportStep =
    ctx.selectedMode === "local" && ctx.importableApps.length > 0;

  const steps = useMemo(
    () => getSteps(ctx.platform, hasImportStep),
    [ctx.platform, hasImportStep],
  );
  const currentStep = state.value as string;
  const currentStepIndex = Math.max(
    0,
    steps.indexOf(currentStep as (typeof steps)[number]),
  );
  useEffect(() => {
    void invoke("track_onboarding_step_viewed", { step: currentStep }).catch(
      () => {},
    );
  }, [currentStep]);
  const settingsQuery = useSettings();
  const modelCatalogQuery = useModelCatalog();
  const licenseQuery = useLicenseState();
  const activateLicense = useActivateLicense();

  const onboardingModelCatalog = useMemo(() => {
    const catalog = modelCatalogQuery.data ?? [];
    const picked = pickOnboardingModels(catalog);
    const importedKey = ctx.localModelChoice;
    if (importedKey && !picked.some((model) => model.key === importedKey)) {
      const imported = catalog.find((model) => model.key === importedKey);
      if (imported) return [...picked, imported];
    }
    return picked;
  }, [modelCatalogQuery.data, ctx.localModelChoice]);
  const persistedLocalModel = settingsQuery.data?.local_model ?? "";
  const persistedSettings = settingsQuery.data;
  const selectedModel =
    ctx.localModelChoice ||
    pickDefaultOnboardingModel(
      modelCatalogQuery.data ?? [],
      persistedLocalModel,
    );
  const selectedModelInfo = useMemo(
    () =>
      onboardingModelCatalog.find((model) => model.key === selectedModel) ??
      modelCatalogQuery.data?.find((model) => model.key === selectedModel) ??
      null,
    [onboardingModelCatalog, modelCatalogQuery.data, selectedModel],
  );
  const statusModelKeys = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...onboardingModelCatalog.map((model) => model.key),
            selectedModel,
          ].filter(Boolean),
        ),
      ),
    [onboardingModelCatalog, selectedModel],
  );
  const { statusByModel: modelStatus } = useModelStatuses(
    statusModelKeys,
    statusModelKeys.length > 0,
  );

  const microphonePermissionQuery = useQuery({
    queryKey: onboardingPermissionKeys.microphone(),
    queryFn: checkMicrophonePermission,
    enabled: ctx.platform.requiresMicrophonePermission,
    refetchOnWindowFocus: currentStep === "permissions" ? "always" : false,
    refetchInterval: (query) =>
      currentStep === "permissions" && query.state.data !== true ? 2000 : false,
    staleTime: 0,
    retry: false,
  });

  const accessibilityPermissionQuery = useQuery({
    queryKey: onboardingPermissionKeys.accessibility(),
    queryFn: checkAccessibilityPermission,
    enabled: ctx.platform.requiresAccessibilityPermission,
    refetchOnWindowFocus: currentStep === "permissions" ? "always" : false,
    refetchInterval: (query) =>
      currentStep === "permissions" && query.state.data !== true ? 2000 : false,
    staleTime: 0,
    retry: false,
  });

  const {
    mutate: requestMicrophonePermission,
    isPending: isRequestingMicrophonePermission,
  } = useMutation({
    mutationFn: async () => {
      await invoke("request_microphone_permission").catch(() => {});
      const granted = await checkMicrophonePermission().catch(() => false);
      if (!granted) {
        await invoke("open_microphone_settings").catch(() => {});
      }
      return granted;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: onboardingPermissionKeys.microphone(),
      });
    },
  });

  const {
    mutate: requestAccessibilityPermission,
    isPending: isRequestingAccessibilityPermission,
  } = useMutation({
    mutationFn: async () => {
      if (ctx.platform.id === "macos") {
        await requestMacAccessibilityPermission().catch(() => {});
      }
      const granted = await checkAccessibilityPermission().catch(() => false);
      if (!granted) {
        await invoke("open_accessibility_settings").catch(() => {});
      }
      return granted;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: onboardingPermissionKeys.accessibility(),
      });
    },
  });

  const updateDownloadStatus = useCallback(
    (modelKey: string, status: DownloadEvent) => {
      setDownloadStatus((prev) => {
        const current = prev[modelKey];
        const detail = (event: DownloadEvent | undefined) =>
          event && "file" in event
            ? event.file
            : event && "message" in event
              ? event.message
              : undefined;
        const verifyingOf = (event: DownloadEvent | undefined) =>
          event && "verifying" in event ? event.verifying : undefined;
        if (
          current?.status === status.status &&
          current?.percent === status.percent &&
          detail(current) === detail(status) &&
          verifyingOf(current) === verifyingOf(status)
        ) {
          return prev;
        }

        return { ...prev, [modelKey]: status };
      });
    },
    [],
  );

  useModelDownloadEvents({
    onProgress: (payload) => {
      updateDownloadStatus(payload.model, {
        status: "downloading",
        percent: Math.min(100, Math.max(0, Math.round(payload.percent))),
        file: payload.file,
        verifying: payload.verifying,
      });
    },
    onComplete: ({ model }) => {
      updateDownloadStatus(model, { status: "complete", percent: 100 });
      void refreshModelStatus(queryClient, model);
    },
    onError: ({ model, error }) => {
      updateDownloadStatus(model, {
        status: "error",
        percent: 0,
        message: error,
      });
    },
    onCancelled: ({ model }) => {
      updateDownloadStatus(model, { status: "cancelled", percent: 0 });
      void refreshModelStatus(queryClient, model);
    },
  });

  const handleDownload = useCallback(
    async (modelKey: string, ane?: boolean) => {
      void invoke("track_onboarding_step_viewed", {
        step: "model_downloading",
      }).catch(() => {});
      updateDownloadStatus(modelKey, {
        status: "downloading",
        percent: 0,
        file: t({
          id: "onboarding.download.starting",
          message: "starting...",
        }),
      });
      try {
        const includeAne =
          ane ??
          modelCatalogQuery.data?.some(
            (model) => model.key === modelKey && model.ane_size_mb != null,
          );
        await invoke("download_model", { model: modelKey, ane: includeAne });
        void refreshModelStatus(queryClient, modelKey);
      } catch {
        updateDownloadStatus(modelKey, {
          status: "error",
          percent: 0,
          message: t({
            id: "onboarding.download.failed",
            message: "Download failed",
          }),
        });
      }
    },
    [modelCatalogQuery.data, queryClient, t, updateDownloadStatus],
  );

  const handleDelete = useCallback(
    async (modelKey: string) => {
      try {
        const status = await invoke<ModelStatus>("delete_model", {
          model: modelKey,
        });
        queryClient.setQueryData(modelKeys.status(modelKey), status);
        updateDownloadStatus(modelKey, { status: "idle", percent: 0 });
      } catch {
        updateDownloadStatus(modelKey, {
          status: "error",
          percent: 0,
          message: t({
            id: "onboarding.delete.failed",
            message: "Delete failed",
          }),
        });
      }
    },
    [queryClient, t, updateDownloadStatus],
  );

  const handleCancelDownload = useCallback(
    async (modelKey: string) => {
      try {
        await invoke("cancel_download", { model: modelKey });
        updateDownloadStatus(modelKey, { status: "cancelled", percent: 0 });
        setTimeout(() => {
          updateDownloadStatus(modelKey, { status: "idle", percent: 0 });
        }, 1500);
      } catch {
        return;
      }
    },
    [updateDownloadStatus],
  );

  const handleRequestMic = useCallback(() => {
    requestMicrophonePermission();
  }, [requestMicrophonePermission]);

  const handleRequestAccessibility = useCallback(() => {
    requestAccessibilityPermission();
  }, [requestAccessibilityPermission]);

  const openLicenseCheckout = useCallback(async (tier: PurchaseTier) => {
    setLicenseOpenError(null);
    setOpeningLicenseTarget(tier);
    try {
      const checkoutUrl = checkoutUrlFor(tier, "onboarding");
      if (!checkoutUrl) {
        throw new Error(
          `${tier === "commercial" ? "Commercial" : "Personal"} checkout link is not configured for this build.`,
        );
      }
      await openUrl(checkoutUrl);
    } catch (err) {
      setLicenseOpenError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningLicenseTarget(null);
    }
  }, []);

  const displayStateByModel = useMemo(() => {
    const buildState = (key: string): DownloadEvent => {
      const installed = modelStatus[key]?.installed;
      const base = downloadStatus[key];
      if (base && base.status !== "complete") return base;
      if (installed) return { status: "complete", percent: 100 };
      return base ?? { status: "idle", percent: 0 };
    };
    return (modelCatalogQuery.data ?? []).reduce<Record<string, DownloadEvent>>(
      (acc, model) => {
        acc[model.key] = buildState(model.key);
        return acc;
      },
      {},
    );
  }, [downloadStatus, modelStatus, modelCatalogQuery.data]);

  const selectedModelReady = useMemo(() => {
    if (!selectedModel) return false;
    const displayState = displayStateByModel[selectedModel];
    return Boolean(
      modelStatus[selectedModel]?.installed ||
      displayState?.status === "complete",
    );
  }, [displayStateByModel, modelStatus, selectedModel]);

  const micPermission = ctx.platform.requiresMicrophonePermission
    ? microphonePermissionQuery.data === true
    : true;
  const accessibilityPermission = ctx.platform.requiresAccessibilityPermission
    ? accessibilityPermissionQuery.data === true
    : true;
  const isCheckingMic =
    ctx.platform.requiresMicrophonePermission &&
    (microphonePermissionQuery.isPending || isRequestingMicrophonePermission);
  const isCheckingAccessibility =
    ctx.platform.requiresAccessibilityPermission &&
    (accessibilityPermissionQuery.isPending ||
      isRequestingAccessibilityPermission);
  const isModelCatalogLoading =
    modelCatalogQuery.isLoading || settingsQuery.isLoading;
  const modelCatalogUnavailable = modelCatalogQuery.isError;

  const handleComplete = useCallback(async () => {
    if (
      settingsQuery.isLoading ||
      settingsQuery.isError ||
      !persistedSettings
    ) {
      send({
        type: "COMPLETE_ERROR",
        error: t({
          id: "onboarding.complete.failed",
          message: "Could not finish setup. Check your settings and try again.",
        }),
      });
      return;
    }

    const resolvedLocalModel = selectedModel;

    send({ type: "COMPLETING" });

    if (!resolvedLocalModel) {
      send({
        type: "COMPLETE_ERROR",
        error: t({
          id: "onboarding.complete.no_model",
          message:
            "Could not load a local model selection. Try reopening onboarding.",
        }),
      });
      return;
    }

    try {
      const latestSettings = await getSettings();
      await invoke("update_settings", {
        args: buildSettingsArgs(
          latestSettings,
          ctx.smartShortcut,
          ctx.selectedMode,
          resolvedLocalModel,
          ctx.autoLaunch,
        ),
      });
      await invoke("complete_onboarding");
      send({ type: "COMPLETE_SUCCESS" });
      onComplete();
    } catch (err) {
      console.error("Failed to finish onboarding", err);
      const message = typeof err === "string" ? err : String(err);
      send({
        type: "COMPLETE_ERROR",
        error:
          message ||
          t({
            id: "onboarding.complete.failed",
            message:
              "Could not finish setup. Check your settings and try again.",
          }),
      });
    }
  }, [
    ctx.autoLaunch,
    ctx.selectedMode,
    ctx.smartShortcut,
    onComplete,
    persistedSettings,
    selectedModel,
    send,
    settingsQuery.isError,
    settingsQuery.isLoading,
    t,
  ]);

  const applySmartShortcut = useCallback(
    async (shortcut: string) => {
      send({ type: "SET_SHORTCUT", shortcut });
      try {
        const latest = await getSettings();
        await invoke("update_settings", {
          args: buildSettingsArgs(
            latest,
            shortcut,
            ctx.selectedMode,
            selectedModel,
            ctx.autoLaunch,
          ),
        });
      } catch {
        return;
      }
    },
    [ctx.autoLaunch, ctx.selectedMode, selectedModel, send],
  );

  const goNext = useCallback(() => {
    send({ type: "NEXT" });
  }, [send]);

  const goBack = useCallback(() => {
    send({ type: "BACK" });
  }, [send]);

  const stepMotionProps = {
    custom: ctx.transitionDirection,
    variants: stepTransitionVariants,
    animate: "center" as const,
    exit: "exit" as const,
    transition: { duration: 0.22, ease: "easeOut" as const },
  };

  const renderStep = () => {
    switch (currentStep) {
      case "welcome":
        return (
          <WelcomeStep
            key="welcome"
            stepMotionProps={stepMotionProps}
            hasStepTransitioned={ctx.hasStepTransitioned}
            onStart={goNext}
            startDisabled={
              ctx.selectedMode === "local" && importableAppsQuery.isLoading
            }
          />
        );
      case "model":
        return (
          <ModelStep
            key="model"
            stepMotionProps={stepMotionProps}
            options={onboardingModelCatalog}
            selectedModel={selectedModelInfo}
            catalog={modelCatalogQuery.data ?? []}
            modelStatus={modelStatus}
            displayStateByModel={displayStateByModel}
            activeModelKey={selectedModel}
            onUse={(key) => send({ type: "SELECT_MODEL", key })}
            isLoading={isModelCatalogLoading}
            unavailable={modelCatalogUnavailable}
            displayState={
              displayStateByModel[selectedModel] ?? {
                status: "idle",
                percent: 0,
              }
            }
            selectedModelReady={selectedModelReady}
            showLocalConfirm={ctx.showLocalConfirm}
            onShowConfirm={(show) => send({ type: "SHOW_LOCAL_CONFIRM", show })}
            onDownload={handleDownload}
            onDelete={handleDelete}
            onCancelDownload={handleCancelDownload}
            onNext={goNext}
          />
        );
      case "import":
        return (
          <ImportStep
            key="import"
            stepMotionProps={stepMotionProps}
            apps={ctx.importableApps}
            onApplied={(result) => {
              if (result.modelKey) {
                send({ type: "SELECT_MODEL", key: result.modelKey });
                if (!modelStatus[result.modelKey]?.installed) {
                  void handleDownload(result.modelKey);
                }
              }
              if (result.shortcut) {
                send({ type: "SET_SHORTCUT", shortcut: result.shortcut });
              }
              if (result.autoLaunch !== null) {
                send({ type: "SET_AUTO_LAUNCH", value: result.autoLaunch });
              }
              goNext();
            }}
            onNext={goNext}
          />
        );
      case "permissions":
        return (
          <PermissionsStep
            key="permissions"
            stepMotionProps={stepMotionProps}
            requiresMicrophone={ctx.platform.requiresMicrophonePermission}
            requiresAccessibility={ctx.platform.requiresAccessibilityPermission}
            micPermission={micPermission}
            accessibilityPermission={accessibilityPermission}
            isCheckingMic={isCheckingMic}
            isCheckingAccessibility={isCheckingAccessibility}
            onRequestMic={handleRequestMic}
            onRequestAccessibility={handleRequestAccessibility}
            onNext={goNext}
          />
        );
      case "done":
        return (
          <ReadyStep
            key="done"
            stepMotionProps={stepMotionProps}
            smartShortcut={ctx.smartShortcut}
            onSetShortcut={applySmartShortcut}
            modelLabel={selectedModelInfo?.label ?? null}
            autoLaunch={ctx.autoLaunch}
            onSetAutoLaunch={(value) =>
              send({ type: "SET_AUTO_LAUNCH", value })
            }
            licenseActive={licenseQuery.data?.status === "active"}
            onOpenLicense={() => {
              activateLicense.reset();
              setLicenseOpenError(null);
              setShowLicenseModal(true);
            }}
            isCompleting={ctx.isCompleting}
            completionError={ctx.completionError}
            onComplete={handleComplete}
          />
        );
      default:
        return null;
    }
  };

  const showChrome = currentStep !== "welcome" && currentStep !== "done";

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface-secondary ui-color-on-solid select-none relative">
        <WindowControls />
        <div data-tauri-drag-region className="h-7 w-full shrink-0" />

        <div className="flex justify-center pt-6">
          <div className="flex h-1.5 items-center">
            {showChrome && (
              <StepIndicator
                currentStep={currentStepIndex}
                total={steps.length}
              />
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center overflow-y-auto px-10 pb-6">
          <AnimatePresence mode="wait" custom={ctx.transitionDirection}>
            {renderStep()}
          </AnimatePresence>
        </div>

        {currentStep !== "welcome" && (
          <button
            onClick={goBack}
            className="absolute left-6 bottom-6 flex items-center gap-1 ui-text-body-sm text-content-muted hover:text-content-primary transition-colors"
          >
            <ChevronLeft size={14} />
            {t({
              id: "onboarding.back",
              message: "Back",
            })}
          </button>
        )}

        <FAQModal
          isOpen={ctx.showFAQModal}
          onClose={() => send({ type: "TOGGLE_FAQ", show: false })}
        />

        <AnimatePresence>
          {showLicenseModal && (
            <LicenseModal
              licenseState={licenseQuery.data ?? null}
              licenseLoading={licenseQuery.isLoading && !licenseQuery.data}
              activating={activateLicense.isPending}
              openingTarget={openingLicenseTarget}
              openError={licenseOpenError}
              activationError={
                activateLicense.error instanceof Error
                  ? activateLicense.error.message
                  : activateLicense.error
                    ? String(activateLicense.error)
                    : null
              }
              onOpenCheckout={openLicenseCheckout}
              onActivateLicense={(key) => activateLicense.mutate(key)}
              onClose={() => setShowLicenseModal(false)}
            />
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
