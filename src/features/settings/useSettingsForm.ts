import { msg } from "@lingui/core/macro";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  checkMacAccessibilityPermission,
  checkMacInputMonitoringPermission,
} from "../../shared/lib/macosPermissions";
import { getPlatformCapabilities } from "../../platform/service";
import {
  getProviderPreset,
  resolvedLlmEndpoint,
} from "../../shared/lib/llmProviders";
import {
  getSpeechProviderPreset,
  resolvedSpeechEndpoint,
  resolvedSpeechModel,
} from "../../shared/lib/speechProviders";
import {
  parseTextSizeMode,
  TEXT_SIZE_MODE_STORAGE_KEY,
} from "../../shared/lib/textSize";
import {
  hasModelCapability,
  MODEL_CAPABILITY_DICTIONARY,
} from "../../shared/lib/modelCapabilities";
import { useModelDownloadEvents } from "../../shared/hooks/useModelDownloadEvents";
import { useLicenseGate, useLicenseState } from "../license/queries";
import {
  buildActiveTranscriptionLanguageOptions,
  collectAllTranscriptionLanguages,
  languageSupportedByModel,
} from "../../shared/lib/transcriptionLanguages";
import { useShortcutCapture } from "../../shared/hooks/useShortcutCapture";
import { i18n } from "../../i18n";
import { useAppInfo, useInputDevices, useSettings } from "./queries";
import * as modelsApi from "./models-api";
import {
  applyModelDiscoveryFailure,
  applyModelDiscoverySuccess,
  beginModelDiscovery,
  EMPTY_MODEL_DISCOVERY_STATE,
  resetModelDiscovery,
  type ModelDiscoveryState,
} from "./modelDiscovery";
import {
  modelKeys,
  useFetchLlmModels,
  useFetchRemoteSpeechModels,
  useCliInstallStatus,
  useInstallCli,
  useModelCatalog,
  useModelStatuses,
  useRemoveCli,
} from "./models-queries";
import type {
  TranscriptionMode,
  TextSizeMode,
  ThemeMode,
  StoredSettings,
  ShortcutBinding,
  ShortcutBindings,
  DownloadEvent,
  LlmProvider,
  RecordingPrunePolicy,
  AutoDeleteTarget,
  MediaAction,
  AppLocaleSetting,
  LocalApiLogEntry,
  LocalApiStatus,
  ModelStatus,
  RemoteSpeechProvider,
} from "../../types";

type ActiveTab =
  | "general"
  | "models"
  | "providers"
  | "local-api"
  | "about"
  | "account"
  | "app";
type ShortcutMode = "smart" | "hold" | "toggle";
type CaptureTarget = { mode: ShortcutMode; index: number } | null;
type ShortcutTarget = { mode: ShortcutMode; index: number };
type ShortcutOverrides = Partial<
  Record<"smartShortcut" | "holdShortcut" | "toggleShortcut", string>
>;
type SettingsErrorSourceTab = Exclude<ActiveTab, "account">;
type InvalidShortcutDrafts = Partial<
  Record<ShortcutMode, Record<number, string>>
>;
type InvalidShortcutDraft = { target: ShortcutTarget; message: string } | null;

type SaveSettingsOverrides = ShortcutOverrides & {
  localModel?: string;
  localApiModel?: string;
  language?: string;
  shortcutBindings?: ShortcutBindings;
  shortcutDraftTarget?: ShortcutTarget;
};

async function waitForLocalApiStopped(
  timeoutMs = 10000,
): Promise<LocalApiStatus> {
  const started = Date.now();
  let latest = await modelsApi.getLocalApiStatus();
  while (latest.running && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    latest = await modelsApi.getLocalApiStatus();
  }
  return latest;
}

const defaultShortcutBindings = (): ShortcutBindings => ({
  smart: [
    { shortcut: "Control+Space", temporary: false, cleanup_enabled: false },
  ],
  hold: [
    {
      shortcut: "Control+Shift+Space",
      temporary: false,
      cleanup_enabled: false,
    },
  ],
  toggle: [
    { shortcut: "Control+Alt+Space", temporary: false, cleanup_enabled: false },
  ],
});

const bindingsFromSettings = (settings: StoredSettings): ShortcutBindings => ({
  smart:
    settings.shortcut_bindings?.smart?.length > 0
      ? settings.shortcut_bindings.smart
      : [
          {
            shortcut: settings.smart_shortcut,
            temporary: false,
            cleanup_enabled: settings.cleanup_enabled ?? false,
          },
        ],
  hold:
    settings.shortcut_bindings?.hold?.length > 0
      ? settings.shortcut_bindings.hold
      : [
          {
            shortcut: settings.hold_shortcut,
            temporary: false,
            cleanup_enabled: settings.cleanup_enabled ?? false,
          },
        ],
  toggle:
    settings.shortcut_bindings?.toggle?.length > 0
      ? settings.shortcut_bindings.toggle
      : [
          {
            shortcut: settings.toggle_shortcut,
            temporary: false,
            cleanup_enabled: settings.cleanup_enabled ?? false,
          },
        ],
});

const withoutShortcutCleanup = (
  bindings: ShortcutBindings,
): ShortcutBindings => ({
  smart: bindings.smart.map((binding) => ({
    ...binding,
    cleanup_enabled: false,
  })),
  hold: bindings.hold.map((binding) => ({
    ...binding,
    cleanup_enabled: false,
  })),
  toggle: bindings.toggle.map((binding) => ({
    ...binding,
    cleanup_enabled: false,
  })),
});

const primaryShortcut = (
  bindings: ShortcutBindings,
  mode: ShortcutMode,
  fallback: string,
) => bindings[mode][0]?.shortcut ?? fallback;

const sanitizeInvalidShortcutDraft = (
  bindings: ShortcutBindings,
  invalidDraft: InvalidShortcutDraft,
  persistedBindings: ShortcutBindings,
): ShortcutBindings => {
  if (!invalidDraft) return bindings;

  const { mode, index } = invalidDraft.target;
  const modeBindings = bindings[mode];
  if (!modeBindings[index]) return bindings;

  const persistedBinding = persistedBindings[mode][index];
  if (!persistedBinding && index > 0) {
    return {
      ...bindings,
      [mode]: modeBindings.filter((_, bindingIndex) => bindingIndex !== index),
    };
  }
  if (!persistedBinding) return bindings;

  return {
    ...bindings,
    [mode]: modeBindings.map((binding, bindingIndex) =>
      bindingIndex === index ? persistedBinding : binding,
    ),
  };
};

interface UseSettingsFormOptions {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: ActiveTab;
  transcriptionMode: TranscriptionMode;
}

export function useSettingsForm({
  isOpen,
  onClose,
  initialTab = "general",
  transcriptionMode: initialTranscriptionMode,
}: UseSettingsFormOptions) {
  const [smartShortcut, setSmartShortcut] = useState("Control+Space");
  const [smartEnabled, setSmartEnabled] = useState(true);
  const [holdShortcut, setHoldShortcut] = useState("Control+Shift+Space");
  const [holdEnabled, setHoldEnabled] = useState(false);
  const [toggleShortcut, setToggleShortcut] = useState("Control+Alt+Space");
  const [toggleEnabled, setToggleEnabled] = useState(false);
  const [shortcutBindings, setShortcutBindings] = useState<ShortcutBindings>(
    defaultShortcutBindings,
  );
  const shortcutBindingsRef = useRef<ShortcutBindings>(
    defaultShortcutBindings(),
  );
  const persistedShortcutBindingsRef = useRef<ShortcutBindings>(
    defaultShortcutBindings(),
  );
  const [invalidShortcutDraft, setInvalidShortcutDraftState] =
    useState<InvalidShortcutDraft>(null);
  const invalidShortcutDraftRef = useRef<InvalidShortcutDraft>(null);
  const [transcriptionMode, setTranscriptionModeRaw] =
    useState<TranscriptionMode>(initialTranscriptionMode);
  const [localModel, setLocalModel] = useState("");
  const [remoteSpeechEnabled, setRemoteSpeechEnabled] = useState(false);
  const [remoteSpeechProvider, setRemoteSpeechProviderRaw] =
    useState<RemoteSpeechProvider>("openai");
  const [remoteSpeechEndpoint, setRemoteSpeechEndpointRaw] = useState(
    "https://api.openai.com/v1",
  );
  const [remoteSpeechApiKey, setRemoteSpeechApiKey] = useState("");
  const [remoteSpeechModel, setRemoteSpeechModel] = useState("auto");
  const [microphoneDevice, setMicrophoneDevice] = useState<string | null>(null);
  const [language, setLanguage] = useState("en");
  const [appLocale, setAppLocale] = useState<AppLocaleSetting>("system");
  const [downloadState, setDownloadState] = useState<
    Record<string, DownloadEvent>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [errorSourceTab, setErrorSourceTab] =
    useState<SettingsErrorSourceTab | null>(null);
  const [captureActive, setCaptureActive] = useState<CaptureTarget>(null);
  const [capturePreview, setCapturePreview] = useState<string>("");
  const captureActiveRef = useRef<CaptureTarget>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("general");
  const [llmEnabled, setLlmEnabledRaw] = useState(false);
  const [llmProvider, setLlmProviderRaw] = useState<LlmProvider>("none");
  const [llmEndpoint, setLlmEndpointRaw] = useState("");
  const [llmApiKey, setLlmApiKeyRaw] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [modelDiscovery, setModelDiscoveryState] =
    useState<ModelDiscoveryState>(EMPTY_MODEL_DISCOVERY_STATE);
  const [speechModelDiscovery, setSpeechModelDiscoveryState] =
    useState<ModelDiscoveryState>(EMPTY_MODEL_DISCOVERY_STATE);
  const modelDiscoveryRef = useRef(EMPTY_MODEL_DISCOVERY_STATE);
  const speechModelDiscoveryRef = useRef(EMPTY_MODEL_DISCOVERY_STATE);
  const setModelDiscovery = useCallback(
    (updater: (state: ModelDiscoveryState) => ModelDiscoveryState) => {
      const next = updater(modelDiscoveryRef.current);
      modelDiscoveryRef.current = next;
      setModelDiscoveryState(next);
      return next;
    },
    [],
  );
  const beginModelDiscoveryRequest = useCallback(() => {
    const next = beginModelDiscovery(modelDiscoveryRef.current);
    modelDiscoveryRef.current = next.state;
    setModelDiscoveryState(next.state);
    return next.requestSeq;
  }, []);
  const setSpeechModelDiscovery = useCallback(
    (updater: (state: ModelDiscoveryState) => ModelDiscoveryState) => {
      const next = updater(speechModelDiscoveryRef.current);
      speechModelDiscoveryRef.current = next;
      setSpeechModelDiscoveryState(next);
      return next;
    },
    [],
  );
  const beginSpeechModelDiscoveryRequest = useCallback(() => {
    const next = beginModelDiscovery(speechModelDiscoveryRef.current);
    speechModelDiscoveryRef.current = next.state;
    setSpeechModelDiscoveryState(next.state);
    return next.requestSeq;
  }, []);
  const [editModeEnabled, setEditModeEnabled] = useState(false);
  const [autoDictionaryEnabled, setAutoDictionaryEnabled] = useState(false);
  const [mediaAction, setMediaAction] = useState<MediaAction>("off");
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false);
  const [autoLaunchEnabled, setAutoLaunchEnabledState] = useState(false);
  const [startInBackground, setStartInBackground] = useState(false);
  const [autoDeleteTarget, setAutoDeleteTarget] =
    useState<AutoDeleteTarget>("transcripts");
  const [autoDeleteDuration, setAutoDeleteDuration] =
    useState<RecordingPrunePolicy>("never");
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true);
  const [localApiKey, setLocalApiKey] = useState("");
  const [localApiPort, setLocalApiPort] = useState(11435);
  const [localApiModel, setLocalApiModel] = useState("auto");
  const [localApiHost, setLocalApiHost] = useState("127.0.0.1");
  const [localApiStartOnLaunch, setLocalApiStartOnLaunch] = useState(false);
  const [localApiCors, setLocalApiCors] = useState(false);
  const [localApiStatus, setLocalApiStatus] = useState<LocalApiStatus | null>(
    null,
  );
  const [localApiBusy, setLocalApiBusy] = useState(false);
  const [textSizeMode, setTextSizeModeRaw] = useState<TextSizeMode>(() =>
    parseTextSizeMode(localStorage.getItem(TEXT_SIZE_MODE_STORAGE_KEY)),
  );
  const [themeMode, setThemeModeRaw] = useState<ThemeMode>("system");
  const [showFAQModal, setShowFAQModal] = useState(false);
  const [micPermission, setMicPermission] = useState<boolean | null>(null);
  const [accessibilityPermission, setAccessibilityPermission] = useState<
    boolean | null
  >(null);
  const [inputMonitoringPermission, setInputMonitoringPermission] = useState<
    boolean | null
  >(null);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const didHydrateRef = useRef(false);
  const isSavingRef = useRef(false);
  const settingsSaveRef = useRef(Promise.resolve(true));
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadResetTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(
    new Set(),
  );
  const queryClient = useQueryClient();
  const settingsQuery = useSettings(undefined, isOpen);
  const licenseStateQuery = useLicenseState();
  const licenseGateActive = useLicenseGate();
  const activeLicense = licenseStateQuery.data?.status === "active";
  const appInfoQuery = useAppInfo(isOpen);
  const inputDevicesQuery = useInputDevices(isOpen);
  const modelCatalogQuery = useModelCatalog(isOpen);
  const cliInstallQuery = useCliInstallStatus(isOpen);
  const installCliMutation = useInstallCli();
  const removeCliMutation = useRemoveCli();
  const { mutateAsync: installCliAsync } = installCliMutation;
  const { mutateAsync: removeCliAsync } = removeCliMutation;
  const fetchLlmModelsMutation = useFetchLlmModels();
  const fetchRemoteSpeechModelsMutation = useFetchRemoteSpeechModels();
  const { mutateAsync: fetchLlmModelsAsync } = fetchLlmModelsMutation;
  const { mutateAsync: fetchRemoteSpeechModelsAsync } =
    fetchRemoteSpeechModelsMutation;
  const inputDevices = inputDevicesQuery.data ?? [];
  const modelCatalog = modelCatalogQuery.data ?? [];
  const availableModels = modelDiscovery.models;
  const availableSpeechModels = speechModelDiscovery.models;
  const cliInstallStatus = cliInstallQuery.data ?? null;
  const cliInstallBusy =
    installCliMutation.isPending || removeCliMutation.isPending;

  const cliInstallError = cliInstallQuery.error;
  useEffect(() => {
    if (cliInstallError) {
      console.error("Failed to load CLI install status:", cliInstallError);
    }
  }, [cliInstallError]);
  const modelKeysForStatus = useMemo(
    () => modelCatalog.map((model) => model.key),
    [modelCatalog],
  );
  const modelStatusesQuery = useModelStatuses(
    modelKeysForStatus,
    isOpen && modelKeysForStatus.length > 0,
  );
  const modelStatus = modelStatusesQuery.statusByModel;
  const appInfo = appInfoQuery.data ?? null;
  const platformCapabilities = useMemo(() => getPlatformCapabilities(), []);
  const loading =
    isOpen &&
    (settingsQuery.isLoading ||
      modelCatalogQuery.isLoading ||
      inputDevicesQuery.isLoading ||
      appInfoQuery.isLoading ||
      licenseStateQuery.isLoading);

  const clearSettingsError = useCallback(() => {
    setError(null);
    setErrorSourceTab(null);
  }, []);

  const clearSettingsErrorIfNoInvalidDrafts = useCallback(() => {
    if (!invalidShortcutDraftRef.current) {
      clearSettingsError();
    }
  }, [clearSettingsError]);

  const showSettingsError = useCallback(
    (
      message: string,
      sourceTab: SettingsErrorSourceTab = activeTab === "account"
        ? "general"
        : activeTab,
    ) => {
      setError(message);
      setErrorSourceTab(sourceTab);
    },
    [activeTab],
  );

  const setInvalidShortcutDraft = useCallback(
    (target: ShortcutTarget, message: string) => {
      const next = { target, message };
      invalidShortcutDraftRef.current = next;
      setInvalidShortcutDraftState(next);
    },
    [],
  );

  const clearInvalidShortcutDraft = useCallback(() => {
    invalidShortcutDraftRef.current = null;
    setInvalidShortcutDraftState(null);
  }, []);

  const invalidShortcutDrafts = useMemo<InvalidShortcutDrafts>(() => {
    if (!invalidShortcutDraft) return {};
    return {
      [invalidShortcutDraft.target.mode]: {
        [invalidShortcutDraft.target.index]: invalidShortcutDraft.message,
      },
    };
  }, [invalidShortcutDraft]);

  const discardInvalidShortcutDraft = useCallback(() => {
    const current = invalidShortcutDraftRef.current;
    if (!current) return;

    const next = sanitizeInvalidShortcutDraft(
      shortcutBindingsRef.current,
      current,
      persistedShortcutBindingsRef.current,
    );

    shortcutBindingsRef.current = next;
    setShortcutBindings(next);
    setSmartShortcut(primaryShortcut(next, "smart", smartShortcut));
    setHoldShortcut(primaryShortcut(next, "hold", holdShortcut));
    setToggleShortcut(primaryShortcut(next, "toggle", toggleShortcut));
    clearInvalidShortcutDraft();
  }, [clearInvalidShortcutDraft, holdShortcut, smartShortcut, toggleShortcut]);

  const setLlmEnabled = useCallback(
    (value: boolean) => {
      setLlmEnabledRaw(value);
      if (!value) {
        setEditModeEnabled(false);
        clearSettingsErrorIfNoInvalidDrafts();
      }
    },
    [clearSettingsErrorIfNoInvalidDrafts],
  );

  const setTranscriptionMode = useCallback(
    (mode: TranscriptionMode) => {
      setTranscriptionModeRaw(mode);
      if (
        mode === "cloud" &&
        (activeTab === "models" || activeTab === "providers")
      ) {
        setActiveTab("general");
      }
    },
    [activeTab],
  );

  const setTextSizeMode = useCallback((mode: TextSizeMode) => {
    setTextSizeModeRaw(mode);
    localStorage.setItem(TEXT_SIZE_MODE_STORAGE_KEY, mode);
    emit("ui:text_size_changed", { mode }).catch(() => {});
  }, []);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeRaw(mode);
    emit("ui:theme_changed", { mode }).catch(() => {});
  }, []);

  const setLlmProvider = useCallback(
    (value: LlmProvider) => {
      setModelDiscovery(resetModelDiscovery);
      setLlmModel("");
      setLlmProviderRaw(value);
    },
    [setModelDiscovery],
  );
  const setLlmEndpoint = useCallback(
    (value: string) => {
      setModelDiscovery(resetModelDiscovery);
      setLlmModel("");
      setLlmEndpointRaw(value);
    },
    [setModelDiscovery],
  );
  const setLlmApiKey = useCallback(
    (value: string) => {
      setModelDiscovery(resetModelDiscovery);
      setLlmModel("");
      setLlmApiKeyRaw(value);
    },
    [setModelDiscovery],
  );
  const setRemoteSpeechProvider = useCallback(
    (value: RemoteSpeechProvider) => {
      setSpeechModelDiscovery(resetModelDiscovery);
      setRemoteSpeechProviderRaw(value);
      setRemoteSpeechModel("auto");
    },
    [setSpeechModelDiscovery],
  );
  const setRemoteSpeechEndpoint = useCallback(
    (value: string) => {
      setSpeechModelDiscovery(resetModelDiscovery);
      setRemoteSpeechEndpointRaw(value);
      setRemoteSpeechModel("auto");
    },
    [setSpeechModelDiscovery],
  );
  const setRemoteSpeechApiKeyRawAndClearModels = useCallback(
    (value: string) => {
      setSpeechModelDiscovery(resetModelDiscovery);
      setRemoteSpeechApiKey(value);
      setRemoteSpeechModel("auto");
    },
    [setSpeechModelDiscovery],
  );

  const hydrateFromSettings = useCallback(
    (s: StoredSettings) => {
      const hydratedBindings = bindingsFromSettings(s);
      persistedShortcutBindingsRef.current = hydratedBindings;
      clearInvalidShortcutDraft();
      setSmartShortcut(s.smart_shortcut);
      setSmartEnabled(s.smart_enabled);
      setHoldShortcut(s.hold_shortcut);
      setHoldEnabled(s.hold_enabled);
      setToggleShortcut(s.toggle_shortcut);
      setToggleEnabled(s.toggle_enabled);
      shortcutBindingsRef.current = hydratedBindings;
      setShortcutBindings(hydratedBindings);
      setTranscriptionModeRaw(s.transcription_mode);
      setLocalModel(s.local_model);
      setRemoteSpeechEnabled(s.remote_speech_enabled ?? false);
      setRemoteSpeechProviderRaw(s.remote_speech_provider ?? "openai");
      setRemoteSpeechEndpointRaw(
        s.remote_speech_endpoint ?? "https://api.openai.com/v1",
      );
      setRemoteSpeechApiKey(s.remote_speech_api_key ?? "");
      setRemoteSpeechModel(s.remote_speech_model ?? "auto");
      setMicrophoneDevice(s.microphone_device);
      setLanguage(s.language);
      setAppLocale(s.app_locale ?? "system");

      setLlmEnabledRaw(s.llm_enabled ?? false);
      setLlmProviderRaw(s.llm_provider ?? "none");
      setLlmEndpointRaw(s.llm_endpoint ?? "");
      setLlmApiKeyRaw(s.llm_api_key ?? "");
      setLlmModel(s.llm_model ?? "");
      setEditModeEnabled(s.edit_mode_enabled ?? false);
      setAutoDictionaryEnabled(s.auto_dictionary_enabled ?? false);
      setMediaAction(s.media_action ?? "off");
      setAutoUpdateEnabled(s.auto_update_enabled ?? false);
      setAutoLaunchEnabledState(s.auto_launch_enabled ?? false);
      setStartInBackground(
        (s.auto_launch_enabled ?? false) && (s.start_in_background ?? false),
      );
      setAutoDeleteTarget(s.auto_delete_target ?? "transcripts");
      setAutoDeleteDuration(s.auto_delete_duration ?? "never");
      setAnalyticsEnabled(s.analytics_enabled ?? true);
      setLocalApiKey(s.local_api_key ?? "");
      setLocalApiPort(s.local_api_port ?? 11435);
      setLocalApiModel(s.local_api_model ?? "auto");
      setLocalApiHost(s.local_api_host ?? "127.0.0.1");
      setLocalApiStartOnLaunch(s.local_api_start_on_launch ?? false);
      setLocalApiCors(s.local_api_cors ?? false);
      setThemeModeRaw(s.theme_mode ?? "system");
    },
    [clearInvalidShortcutDraft],
  );

  const setAutoLaunchEnabled = useCallback((enabled: boolean) => {
    setAutoLaunchEnabledState(enabled);
    setStartInBackground(enabled);
  }, []);

  const activeLocalModel = useMemo(
    () => modelCatalog.find((model) => model.key === localModel),
    [modelCatalog, localModel],
  );
  const autoTranscriptionLanguageLabel = i18n._(
    msg({
      id: "transcription.language.auto",
      message: "Auto",
    }),
  );
  const unsupportedTranscriptionLanguageLabel = i18n._(
    msg({
      id: "transcription.language.unsupported",
      message: "Unsupported",
    }),
  );
  const unsupportedTranscriptionLanguageDescription = i18n._(
    msg({
      id: "transcription.language.unsupported_description",
      message: "Choose a compatible model to enable these.",
    }),
  );
  const llmProviderPreset = useMemo(
    () => getProviderPreset(llmProvider),
    [llmProvider],
  );
  const remoteSpeechProviderPreset = useMemo(
    () => getSpeechProviderPreset(remoteSpeechProvider),
    [remoteSpeechProvider],
  );
  const llmConfigReady = Boolean(
    llmProviderPreset &&
    (llmProviderPreset.onDevice ||
      (resolvedLlmEndpoint(llmProvider, llmEndpoint) &&
        (!llmProviderPreset.apiKeyRequired || llmApiKey.trim()) &&
        llmModel.trim())),
  );
  const remoteSpeechConfigReady = Boolean(
    remoteSpeechProviderPreset &&
    resolvedSpeechEndpoint(remoteSpeechProvider, remoteSpeechEndpoint) &&
    resolvedSpeechModel(remoteSpeechProvider, remoteSpeechModel) &&
    (!remoteSpeechProviderPreset.apiKeyRequired || remoteSpeechApiKey.trim()),
  );
  const remoteSpeechActive = remoteSpeechEnabled && remoteSpeechConfigReady;
  const allTranscriptionLanguages = useMemo(
    () => collectAllTranscriptionLanguages(modelCatalog),
    [modelCatalog],
  );
  const displayedLanguageOptions = useMemo(
    () =>
      buildActiveTranscriptionLanguageOptions(
        activeLocalModel,
        allTranscriptionLanguages,
        remoteSpeechActive,
        autoTranscriptionLanguageLabel,
        unsupportedTranscriptionLanguageLabel,
        unsupportedTranscriptionLanguageDescription,
      ),
    [
      activeLocalModel,
      allTranscriptionLanguages,
      remoteSpeechActive,
      autoTranscriptionLanguageLabel,
      unsupportedTranscriptionLanguageLabel,
      unsupportedTranscriptionLanguageDescription,
    ],
  );
  const displayedLanguage = displayedLanguageOptions.some(
    (option) => option.code === language,
  )
    ? language
    : "";
  const localModelSupportsDictionary = hasModelCapability(
    activeLocalModel,
    MODEL_CAPABILITY_DICTIONARY,
  );
  const autoDictionarySupported =
    remoteSpeechActive || localModelSupportsDictionary;
  const aiFeaturesReady = licenseGateActive && llmEnabled && llmConfigReady;

  useEffect(() => {
    if (!isOpen || loading || !language) return;
    if (
      !remoteSpeechActive &&
      activeLocalModel &&
      !languageSupportedByModel(activeLocalModel, language)
    ) {
      setLanguage("");
    }
  }, [activeLocalModel, isOpen, language, loading, remoteSpeechActive]);

  const buildSettingsArgs = useCallback(
    (overrides: SaveSettingsOverrides = {}) => {
      const rawShortcutBindings =
        overrides.shortcutBindings ?? shortcutBindings;
      const shouldTryDraftShortcut =
        overrides.shortcutBindings !== undefined &&
        overrides.shortcutDraftTarget !== undefined;
      const bindingsForSave = shouldTryDraftShortcut
        ? rawShortcutBindings
        : sanitizeInvalidShortcutDraft(
            rawShortcutBindings,
            invalidShortcutDraftRef.current,
            persistedShortcutBindingsRef.current,
          );
      const savedShortcutBindings = aiFeaturesReady
        ? bindingsForSave
        : withoutShortcutCleanup(bindingsForSave);

      const persistedRemoteEndpoint = resolvedSpeechEndpoint(
        remoteSpeechProvider,
        remoteSpeechEndpoint,
      );
      const persistedLlmEndpoint = resolvedLlmEndpoint(
        llmProvider,
        llmEndpoint,
      );
      const modelToValidate = overrides.localModel
        ? modelCatalog.find((model) => model.key === overrides.localModel)
        : activeLocalModel;
      const persistedLanguage =
        overrides.language ??
        (!remoteSpeechActive &&
        modelToValidate &&
        !languageSupportedByModel(modelToValidate, language)
          ? ""
          : language);

      return {
        smartShortcut:
          overrides.smartShortcut ??
          primaryShortcut(savedShortcutBindings, "smart", smartShortcut),
        smartEnabled,
        holdShortcut:
          overrides.holdShortcut ??
          primaryShortcut(savedShortcutBindings, "hold", holdShortcut),
        holdEnabled,
        toggleShortcut:
          overrides.toggleShortcut ??
          primaryShortcut(savedShortcutBindings, "toggle", toggleShortcut),
        toggleEnabled,
        shortcutBindings: savedShortcutBindings,
        transcriptionMode,
        localModel: overrides.localModel ?? localModel,
        remoteSpeechEnabled,
        remoteSpeechProvider,
        remoteSpeechEndpoint: persistedRemoteEndpoint,
        remoteSpeechApiKey,
        remoteSpeechModel,
        microphoneDevice,
        language: persistedLanguage,
        appLocale,
        themeMode,

        llmEnabled: licenseGateActive && llmEnabled && llmConfigReady,
        cleanupEnabled: false,
        llmProvider,
        llmEndpoint: persistedLlmEndpoint,
        llmApiKey,
        llmModel,
        editModeEnabled: aiFeaturesReady ? editModeEnabled : false,
        autoDictionaryEnabled: autoDictionarySupported
          ? autoDictionaryEnabled
          : false,
        mediaAction,
        autoUpdateEnabled,
        autoLaunchEnabled,
        startInBackground,
        autoDeleteTarget,
        autoDeleteDuration,
        analyticsEnabled,
        localApiKey,
        localApiPort,
        localApiModel: overrides.localApiModel ?? localApiModel,
        localApiHost,
        localApiStartOnLaunch: activeLicense ? localApiStartOnLaunch : false,
        localApiCors,
      };
    },
    [
      smartShortcut,
      shortcutBindings,
      smartEnabled,
      holdShortcut,
      holdEnabled,
      toggleShortcut,
      toggleEnabled,
      transcriptionMode,
      localModel,
      activeLocalModel,
      remoteSpeechEnabled,
      remoteSpeechActive,
      remoteSpeechProvider,
      remoteSpeechEndpoint,
      remoteSpeechApiKey,
      remoteSpeechModel,
      remoteSpeechConfigReady,
      microphoneDevice,
      language,
      appLocale,
      themeMode,
      aiFeaturesReady,
      licenseGateActive,
      activeLicense,
      llmEnabled,
      llmProvider,
      llmEndpoint,
      llmApiKey,
      llmModel,
      editModeEnabled,
      autoDictionarySupported,
      autoDictionaryEnabled,
      mediaAction,
      autoUpdateEnabled,
      autoLaunchEnabled,
      startInBackground,
      autoDeleteTarget,
      autoDeleteDuration,
      analyticsEnabled,
      localApiKey,
      localApiPort,
      localApiModel,
      localApiHost,
      localApiStartOnLaunch,
      localApiCors,
    ],
  );

  const saveSettingsNow = useCallback(
    (overrides?: SaveSettingsOverrides) => {
      const args = buildSettingsArgs(overrides);
      if (overrides?.localModel !== undefined && !args.localModel) {
        return Promise.resolve(false);
      }
      const save = settingsSaveRef.current
        .catch(() => false)
        .then(async () => {
          isSavingRef.current = true;
          try {
            await invoke("update_settings", { args });
            persistedShortcutBindingsRef.current = args.shortcutBindings;
            if (overrides?.shortcutDraftTarget) {
              clearInvalidShortcutDraft();
            }
            clearSettingsErrorIfNoInvalidDrafts();
            return true;
          } catch (err) {
            console.error(err);
            const message = String(err);
            if (overrides?.shortcutDraftTarget) {
              setInvalidShortcutDraft(overrides.shortcutDraftTarget, message);
            }
            showSettingsError(message);
            return false;
          } finally {
            isSavingRef.current = false;
          }
        });

      settingsSaveRef.current = save;
      return save;
    },
    [
      buildSettingsArgs,
      clearInvalidShortcutDraft,
      clearSettingsErrorIfNoInvalidDrafts,
      setInvalidShortcutDraft,
      showSettingsError,
    ],
  );

  const saveSettingsNowRef = useRef(saveSettingsNow);
  saveSettingsNowRef.current = saveSettingsNow;

  const clearPendingSettingsSave = useCallback(() => {
    if (saveTimeoutRef.current === null) return;
    clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = null;
  }, []);

  const flushPendingSettingsSave = useCallback(() => {
    if (saveTimeoutRef.current === null) return;
    clearPendingSettingsSave();
    void saveSettingsNowRef.current();
  }, [clearPendingSettingsSave]);

  const discardEmptyCaptureDraft = useCallback(() => {
    const target = captureActiveRef.current;
    if (target) {
      const current = shortcutBindingsRef.current;
      const binding = current[target.mode][target.index];
      if (
        binding &&
        binding.shortcut.trim() === "" &&
        current[target.mode].length > 1
      ) {
        const next = {
          ...current,
          [target.mode]: current[target.mode].filter(
            (_, bindingIndex) => bindingIndex !== target.index,
          ),
        };
        shortcutBindingsRef.current = next;
        setShortcutBindings(next);
      }
    }
    captureActiveRef.current = null;
  }, []);

  const finalizeCapture = useCallback(async () => {
    flushPendingSettingsSave();
    setCaptureActive(null);
    await invoke("set_shortcut_capture_active", { active: false }).catch(
      () => {},
    );
  }, [flushPendingSettingsSave]);

  const { resetCaptureState } = useShortcutCapture({
    active: captureActive !== null,
    onCancel: finalizeCapture,
    onCaptureCancelled: discardEmptyCaptureDraft,
    onPreviewChange: setCapturePreview,
    onShortcutCaptured: (combo) => {
      clearPendingSettingsSave();
      const target = captureActiveRef.current;
      if (target) {
        setShortcutBindings((current) => {
          const next = {
            ...current,
            [target.mode]: current[target.mode].map((binding, index) =>
              index === target.index
                ? { ...binding, shortcut: combo }
                : binding,
            ),
          };
          shortcutBindingsRef.current = next;
          const primary = primaryShortcut(next, target.mode, combo);
          if (target.mode === "smart") setSmartShortcut(primary);
          if (target.mode === "hold") setHoldShortcut(primary);
          if (target.mode === "toggle") setToggleShortcut(primary);
          void saveSettingsNow({
            shortcutBindings: next,
            shortcutDraftTarget: target,
            smartShortcut: primaryShortcut(next, "smart", smartShortcut),
            holdShortcut: primaryShortcut(next, "hold", holdShortcut),
            toggleShortcut: primaryShortcut(next, "toggle", toggleShortcut),
          });
          return next;
        });
        captureActiveRef.current = null;
      }
      clearSettingsErrorIfNoInvalidDrafts();
    },
    onError: (message) => showSettingsError(message, "general"),
    onCaptureInput: clearSettingsErrorIfNoInvalidDrafts,
  });

  useEffect(() => {
    if (aiFeaturesReady) return;
    setEditModeEnabled(false);
    setShortcutBindings((current) => {
      const next = withoutShortcutCleanup(current);
      shortcutBindingsRef.current = next;
      return next;
    });
  }, [aiFeaturesReady]);

  useEffect(() => {
    if (isOpen && initialTab) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (isOpen) return;
    flushPendingSettingsSave();
    didHydrateRef.current = false;
    if (captureActive) {
      finalizeCapture();
      resetCaptureState();
    }
  }, [
    captureActive,
    finalizeCapture,
    flushPendingSettingsSave,
    isOpen,
    resetCaptureState,
  ]);

  useEffect(() => {
    return () => {
      flushPendingSettingsSave();
      invoke("set_shortcut_capture_active", { active: false }).catch(() => {});
      for (const timeout of downloadResetTimeoutsRef.current) {
        clearTimeout(timeout);
      }
      downloadResetTimeoutsRef.current.clear();
    };
  }, [flushPendingSettingsSave]);

  const refreshPermissionState = useCallback(async () => {
    const [nativeMic, acc, inputMonitoring] = await Promise.allSettled([
      platformCapabilities.requiresNativeMicrophonePermission
        ? invoke<boolean>("check_microphone_permission")
        : Promise.resolve<boolean | null>(null),
      platformCapabilities.requiresAccessibilityPermission
        ? checkMacAccessibilityPermission()
        : Promise.resolve<boolean | null>(null),
      platformCapabilities.requiresInputMonitoringPermission
        ? checkMacInputMonitoringPermission()
        : Promise.resolve<boolean | null>(null),
    ]);

    setMicPermission(
      nativeMic.status === "fulfilled" ? nativeMic.value : false,
    );
    setAccessibilityPermission(acc.status === "fulfilled" ? acc.value : false);
    setInputMonitoringPermission(
      inputMonitoring.status === "fulfilled" ? inputMonitoring.value : false,
    );
  }, [platformCapabilities]);

  useEffect(() => {
    if (activeTab !== "app" || !isOpen) return;

    let cancelled = false;
    let unlistenFocus: UnlistenFn | null = null;

    const refreshPermissions = () => {
      if (!cancelled) {
        void refreshPermissionState();
      }
    };

    refreshPermissions();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshPermissions();
      }
    };

    window.addEventListener("focus", refreshPermissions);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          refreshPermissions();
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlistenFocus = fn;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshPermissions);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unlistenFocus?.();
    };
  }, [activeTab, isOpen, refreshPermissionState]);

  const handleRequestMicrophonePermission = useCallback(async () => {
    try {
      await invoke("request_microphone_permission");
    } catch {
      // Fall through to the settings fallback below.
    }

    try {
      const granted = await invoke<boolean>("check_microphone_permission");
      setMicPermission(granted);
      if (!granted) {
        await invoke("open_microphone_settings");
      }
    } catch {
      setMicPermission(false);
      try {
        await invoke("open_microphone_settings");
      } catch {
        // ignore
      }
    } finally {
      void refreshPermissionState();
    }
  }, [refreshPermissionState]);

  useEffect(() => {
    if (!isOpen) return;

    if (settingsQuery.error) {
      console.error("Failed to load settings:", settingsQuery.error);
      showSettingsError("Failed to load settings", "general");
      return;
    }

    if (!settingsQuery.data || isSavingRef.current) return;

    hydrateFromSettings(settingsQuery.data);
  }, [
    hydrateFromSettings,
    isOpen,
    settingsQuery.data,
    settingsQuery.error,
    showSettingsError,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    let unlistenLog: UnlistenFn | null = null;
    let unlistenStatus: UnlistenFn | null = null;

    modelsApi
      .getLocalApiStatus()
      .then((status) => {
        if (!cancelled) setLocalApiStatus(status);
      })
      .catch((err) => console.error("Failed to load local API status:", err));

    listen<LocalApiLogEntry>("local-api:log", (event) => {
      if (cancelled) return;
      setLocalApiStatus((current) => {
        if (!current) return current;
        const previousLogs = current.logs ?? [];
        return {
          ...current,
          logs: [...previousLogs, event.payload].slice(-200),
        };
      });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenLog = fn;
      })
      .catch(() => {});

    listen<LocalApiStatus>("local-api:status", (event) => {
      if (!cancelled) setLocalApiStatus(event.payload);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenStatus = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlistenLog?.();
      unlistenStatus?.();
    };
  }, [isOpen]);

  const invalidateModelStatus = useCallback(
    (modelKey: string) => {
      void queryClient.invalidateQueries({
        queryKey: modelKeys.status(modelKey),
      });
    },
    [queryClient],
  );

  useEffect(() => {
    if (!isOpen || modelCatalog.length === 0) return;

    setLocalModel((current) =>
      modelCatalog.some((model) => model.key === current)
        ? current
        : (modelCatalog.find((model) => model.downloadable)?.key ?? ""),
    );
  }, [isOpen, modelCatalog]);

  useModelDownloadEvents({
    enabled: isOpen,
    onProgress: (payload) => {
      setDownloadState((prev) => ({
        ...prev,
        [payload.model]: {
          status: "downloading",
          percent: Math.min(100, payload.percent),
          file: payload.file,
          verifying: payload.verifying,
        },
      }));
    },
    onComplete: ({ model }) => {
      setDownloadState((prev) => ({
        ...prev,
        [model]: {
          status: "complete",
          percent: 100,
        },
      }));
      invalidateModelStatus(model);
    },
    onError: ({ model, error }) => {
      setDownloadState((prev) => ({
        ...prev,
        [model]: {
          status: "error",
          message: error,
          percent: prev[model]?.percent ?? 0,
        },
      }));
    },
    onCancelled: ({ model }) => {
      setDownloadState((prev) => ({
        ...prev,
        [model]: { status: "cancelled", percent: 0 },
      }));
      invalidateModelStatus(model);
    },
  });

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      if (captureActiveRef.current) {
        e.preventDefault();
        finalizeCapture();
        discardEmptyCaptureDraft();
        resetCaptureState();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [
    discardEmptyCaptureDraft,
    finalizeCapture,
    isOpen,
    onClose,
    resetCaptureState,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    if (loading) return;
    if (captureActiveRef.current) return;
    if (!didHydrateRef.current) {
      didHydrateRef.current = true;
      return;
    }

    if (saveTimeoutRef.current !== null) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      void saveSettingsNow();
    }, 500);
  }, [isOpen, loading, saveSettingsNow]);

  const handleOpenDataDir = useCallback(async () => {
    if (!appInfo?.data_dir_path) return;
    try {
      await invoke("open_data_dir", { path: appInfo.data_dir_path });
    } catch (err) {
      console.error("Failed to open data directory:", err);
    }
  }, [appInfo?.data_dir_path]);

  const handleStartCapture = useCallback(
    (mode: ShortcutMode, index = 0) => {
      discardInvalidShortcutDraft();
      if (captureActive?.mode === mode && captureActive.index === index) {
        captureActiveRef.current = null;
        setCaptureActive(null);
        finalizeCapture();
        resetCaptureState();
        clearSettingsErrorIfNoInvalidDrafts();
        return;
      }
      resetCaptureState();
      const target = { mode, index };
      captureActiveRef.current = target;
      setCaptureActive(target);
      clearSettingsErrorIfNoInvalidDrafts();
      invoke("set_shortcut_capture_active", { active: true }).catch((err) => {
        console.error("Failed to disable shortcuts for capture", err);
        captureActiveRef.current = null;
        setCaptureActive(null);
        resetCaptureState();
        showSettingsError(String(err), "general");
      });
    },
    [
      captureActive,
      clearSettingsErrorIfNoInvalidDrafts,
      discardInvalidShortcutDraft,
      finalizeCapture,
      resetCaptureState,
      showSettingsError,
    ],
  );

  const updateShortcutBindings = useCallback(
    (updater: (current: ShortcutBindings) => ShortcutBindings) => {
      clearPendingSettingsSave();
      const next = updater(shortcutBindingsRef.current);
      shortcutBindingsRef.current = next;
      setShortcutBindings(next);
      setSmartShortcut(primaryShortcut(next, "smart", smartShortcut));
      setHoldShortcut(primaryShortcut(next, "hold", holdShortcut));
      setToggleShortcut(primaryShortcut(next, "toggle", toggleShortcut));
      void saveSettingsNow({
        shortcutBindings: next,
        smartShortcut: primaryShortcut(next, "smart", smartShortcut),
        holdShortcut: primaryShortcut(next, "hold", holdShortcut),
        toggleShortcut: primaryShortcut(next, "toggle", toggleShortcut),
      });
    },
    [
      clearPendingSettingsSave,
      holdShortcut,
      saveSettingsNow,
      smartShortcut,
      toggleShortcut,
    ],
  );

  const updateShortcutBinding = useCallback(
    (mode: ShortcutMode, index: number, patch: Partial<ShortcutBinding>) => {
      if (patch.shortcut !== undefined) {
        discardInvalidShortcutDraft();
      }
      updateShortcutBindings((current) => ({
        ...current,
        [mode]: current[mode].map((binding, bindingIndex) =>
          bindingIndex === index ? { ...binding, ...patch } : binding,
        ),
      }));
    },
    [discardInvalidShortcutDraft, updateShortcutBindings],
  );

  const addShortcutBinding = useCallback(
    (mode: ShortcutMode) => {
      clearPendingSettingsSave();
      discardInvalidShortcutDraft();
      const current = shortcutBindingsRef.current;
      if (current[mode].length >= 3) return;
      const nextIndex = current[mode].length;
      const next = {
        ...current,
        [mode]: [
          ...current[mode],
          { shortcut: "", temporary: false, cleanup_enabled: false },
        ],
      };
      shortcutBindingsRef.current = next;
      setShortcutBindings(next);
      handleStartCapture(mode, nextIndex);
    },
    [clearPendingSettingsSave, discardInvalidShortcutDraft, handleStartCapture],
  );

  const removeShortcutBinding = useCallback(
    (mode: ShortcutMode, index: number) => {
      if (shortcutBindingsRef.current[mode].length <= 1) return;
      discardInvalidShortcutDraft();
      const activeTarget = captureActiveRef.current;
      if (activeTarget?.mode === mode) {
        if (activeTarget.index === index) {
          captureActiveRef.current = null;
          setCaptureActive(null);
          resetCaptureState();
          void invoke("set_shortcut_capture_active", { active: false }).catch(
            () => {},
          );
        } else if (activeTarget.index > index) {
          const nextTarget = { ...activeTarget, index: activeTarget.index - 1 };
          captureActiveRef.current = nextTarget;
          setCaptureActive(nextTarget);
        }
      }
      updateShortcutBindings((current) => {
        return {
          ...current,
          [mode]: current[mode].filter(
            (_, bindingIndex) => bindingIndex !== index,
          ),
        };
      });
    },
    [discardInvalidShortcutDraft, resetCaptureState, updateShortcutBindings],
  );

  const handleLocalModelChange = useCallback(
    (modelKey: string) => {
      clearPendingSettingsSave();
      const nextModel = modelCatalog.find((model) => model.key === modelKey);
      const nextLanguage =
        remoteSpeechActive || languageSupportedByModel(nextModel, language)
          ? language
          : "";
      setLocalModel(modelKey);
      setLanguage(nextLanguage);
      void saveSettingsNow({ localModel: modelKey, language: nextLanguage });
    },
    [
      clearPendingSettingsSave,
      language,
      modelCatalog,
      remoteSpeechActive,
      saveSettingsNow,
    ],
  );

  const fetchAvailableModels = useCallback(async () => {
    const requestSeq = beginModelDiscoveryRequest();
    try {
      const models = await fetchLlmModelsAsync({
        endpoint: resolvedLlmEndpoint(llmProvider, llmEndpoint),
        apiKey: llmApiKey,
      });
      const previous = modelDiscoveryRef.current;
      const next = setModelDiscovery((state) =>
        applyModelDiscoverySuccess(state, requestSeq, models),
      );
      if (next === previous) return;
      if (errorSourceTab === "providers") clearSettingsError();
    } catch (err) {
      const previous = modelDiscoveryRef.current;
      const next = setModelDiscovery((state) =>
        applyModelDiscoveryFailure(state, requestSeq),
      );
      if (next === previous) return;
      showSettingsError(`Failed to load writing models: ${err}`, "providers");
    }
  }, [
    clearSettingsError,
    errorSourceTab,
    beginModelDiscoveryRequest,
    fetchLlmModelsAsync,
    llmApiKey,
    llmEndpoint,
    llmProvider,
    setModelDiscovery,
    showSettingsError,
  ]);

  const fetchAvailableSpeechModels = useCallback(async () => {
    const requestSeq = beginSpeechModelDiscoveryRequest();
    try {
      const models = await fetchRemoteSpeechModelsAsync({
        endpoint: resolvedSpeechEndpoint(
          remoteSpeechProvider,
          remoteSpeechEndpoint,
        ),
        apiKey: remoteSpeechApiKey,
      });
      const previous = speechModelDiscoveryRef.current;
      const next = setSpeechModelDiscovery((state) =>
        applyModelDiscoverySuccess(state, requestSeq, models),
      );
      if (next === previous) return;
      if (errorSourceTab === "providers") clearSettingsError();
    } catch (err) {
      const previous = speechModelDiscoveryRef.current;
      const next = setSpeechModelDiscovery((state) =>
        applyModelDiscoveryFailure(state, requestSeq),
      );
      if (next === previous) return;
      showSettingsError(`Failed to load speech models: ${err}`, "providers");
    }
  }, [
    clearSettingsError,
    errorSourceTab,
    beginSpeechModelDiscoveryRequest,
    fetchRemoteSpeechModelsAsync,
    remoteSpeechApiKey,
    remoteSpeechEndpoint,
    remoteSpeechProvider,
    setSpeechModelDiscovery,
    showSettingsError,
  ]);

  const handleDownload = useCallback(
    async (modelKey: string, ane?: boolean) => {
      setDownloadState((prev) => ({
        ...prev,
        [modelKey]: {
          status: "downloading",
          percent: 0,
          file: "starting",
        },
      }));
      try {
        const status = await invoke<ModelStatus>("download_model", {
          model: modelKey,
          ane,
        });
        queryClient.setQueryData(modelKeys.status(modelKey), status);
        void queryClient.invalidateQueries({ queryKey: modelKeys.speech() });
      } catch (err) {
        console.error(err);
        setDownloadState((prev) => ({
          ...prev,
          [modelKey]: {
            status: "error",
            message: String(err),
            percent: prev[modelKey]?.percent ?? 0,
          },
        }));
      }
    },
    [queryClient],
  );

  const handleDelete = useCallback(
    async (modelKey: string) => {
      try {
        const status = await invoke<ModelStatus>("delete_model", {
          model: modelKey,
        });
        queryClient.setQueryData(modelKeys.status(modelKey), status);
        setDownloadState((prev) => ({
          ...prev,
          [modelKey]: { status: "idle", percent: 0 },
        }));

        const otherInstalledModel =
          modelCatalog.find(
            (m) =>
              m.key !== modelKey &&
              modelStatus[m.key]?.installed &&
              m.downloadable,
          ) ??
          modelCatalog.find(
            (m) => m.key !== modelKey && modelStatus[m.key]?.installed,
          );
        const settingsUpdates: SaveSettingsOverrides = {};

        if (localModel === modelKey && otherInstalledModel) {
          settingsUpdates.localModel = otherInstalledModel.key;
          setLocalModel(otherInstalledModel.key);
          const nextLanguage =
            remoteSpeechActive ||
            languageSupportedByModel(otherInstalledModel, language)
              ? language
              : "";
          if (nextLanguage !== language) {
            settingsUpdates.language = nextLanguage;
            setLanguage(nextLanguage);
          }
        }

        if (localApiModel === modelKey) {
          const nextLocalApiModel = otherInstalledModel?.key ?? "auto";
          settingsUpdates.localApiModel = nextLocalApiModel;
          setLocalApiModel(nextLocalApiModel);
        }

        if (Object.keys(settingsUpdates).length > 0) {
          clearPendingSettingsSave();
          void saveSettingsNow(settingsUpdates);
        }

        void queryClient.invalidateQueries({ queryKey: modelKeys.speech() });
      } catch (err) {
        console.error(err);
        setDownloadState((prev) => ({
          ...prev,
          [modelKey]: {
            status: "error",
            message: String(err),
            percent: prev[modelKey]?.percent ?? 0,
          },
        }));
      }
    },
    [
      clearPendingSettingsSave,
      queryClient,
      language,
      localApiModel,
      localModel,
      modelCatalog,
      modelStatus,
      remoteSpeechActive,
      saveSettingsNow,
    ],
  );

  const handleCancelDownload = useCallback(async (modelKey: string) => {
    try {
      await invoke("cancel_download", { model: modelKey });
      setDownloadState((prev) => ({
        ...prev,
        [modelKey]: {
          status: "cancelled",
          percent: 0,
        },
      }));
      const resetTimeout = setTimeout(() => {
        downloadResetTimeoutsRef.current.delete(resetTimeout);
        setDownloadState((prev) => {
          if (prev[modelKey]?.status === "cancelled") {
            return {
              ...prev,
              [modelKey]: {
                status: "idle",
                percent: 0,
              },
            };
          }
          return prev;
        });
      }, 1500);
      downloadResetTimeoutsRef.current.add(resetTimeout);
    } catch (err) {
      console.error("Failed to cancel download:", err);
    }
  }, []);

  const handleStartLocalApi = useCallback(async () => {
    flushPendingSettingsSave();
    setLocalApiBusy(true);
    try {
      if (!(await saveSettingsNowRef.current())) return;
      const status = await modelsApi.startLocalApi({
        host: localApiHost,
        port: localApiPort,
        model: localApiModel,
        apiKey: localApiKey,
        cors: localApiCors,
      });
      setLocalApiStatus(status);
      clearSettingsError();
    } catch (err) {
      console.error(err);
      showSettingsError(String(err), "local-api");
    } finally {
      setLocalApiBusy(false);
    }
  }, [
    clearSettingsError,
    flushPendingSettingsSave,
    localApiCors,
    localApiHost,
    localApiKey,
    localApiModel,
    localApiPort,
    showSettingsError,
  ]);

  const handleStopLocalApi = useCallback(async () => {
    setLocalApiBusy(true);
    try {
      await modelsApi.stopLocalApi();
      const status = await waitForLocalApiStopped();
      setLocalApiStatus(status);
      clearSettingsError();
    } catch (err) {
      console.error(err);
      showSettingsError(String(err), "local-api");
    } finally {
      setLocalApiBusy(false);
    }
  }, [clearSettingsError, showSettingsError]);

  const handleRestartLocalApi = useCallback(async () => {
    setLocalApiBusy(true);
    try {
      if (!(await saveSettingsNowRef.current())) return;
      await modelsApi.stopLocalApi();
      const stopped = await waitForLocalApiStopped();
      if (stopped.running) {
        throw new Error("API server did not stop before restart");
      }
      const status = await modelsApi.startLocalApi({
        host: localApiHost,
        port: localApiPort,
        model: localApiModel,
        apiKey: localApiKey,
        cors: localApiCors,
      });
      setLocalApiStatus(status);
      clearSettingsError();
    } catch (err) {
      console.error(err);
      showSettingsError(String(err), "local-api");
    } finally {
      setLocalApiBusy(false);
    }
  }, [
    clearSettingsError,
    localApiCors,
    localApiHost,
    localApiKey,
    localApiModel,
    localApiPort,
    showSettingsError,
  ]);

  const handleClearLocalApiLogs = useCallback(async () => {
    try {
      const status = await modelsApi.clearLocalApiLogs();
      setLocalApiStatus(status);
    } catch (err) {
      console.error(err);
      showSettingsError(String(err), "local-api");
    }
  }, [showSettingsError]);

  const handleInstallCli = useCallback(async () => {
    try {
      await installCliAsync();
    } catch (err) {
      console.error(err);
      showSettingsError(String(err), "local-api");
    }
  }, [installCliAsync, showSettingsError]);

  const handleRemoveCli = useCallback(async () => {
    try {
      await removeCliAsync();
    } catch (err) {
      console.error(err);
      showSettingsError(String(err), "local-api");
    }
  }, [removeCliAsync, showSettingsError]);

  const formatBytes = useCallback((bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const decimals = i >= 3 ? 1 : 0;
    return (
      parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i]
    );
  }, []);

  return {
    activeTab,
    setActiveTab,
    loading,
    error,
    errorSourceTab,

    smartShortcut,
    shortcutBindings,
    invalidShortcutDrafts,
    smartEnabled,
    setSmartEnabled,
    holdShortcut,
    holdEnabled,
    setHoldEnabled,
    toggleShortcut,
    toggleEnabled,
    setToggleEnabled,
    transcriptionMode,
    setTranscriptionMode,
    localModel,
    setLocalModel: handleLocalModelChange,
    remoteSpeechEnabled,
    setRemoteSpeechEnabled,
    remoteSpeechProvider,
    setRemoteSpeechProvider,
    remoteSpeechEndpoint,
    setRemoteSpeechEndpoint,
    remoteSpeechApiKey,
    setRemoteSpeechApiKey: setRemoteSpeechApiKeyRawAndClearModels,
    remoteSpeechModel,
    setRemoteSpeechModel,
    microphoneDevice,
    setMicrophoneDevice,
    language: displayedLanguage,
    setLanguage,
    appLocale,
    setAppLocale,
    languages: displayedLanguageOptions,

    inputDevices,
    modelCatalog,
    modelStatus,
    downloadState,
    appInfo,

    captureActive,
    capturePreview,
    handleStartCapture,
    updateShortcutBinding,
    addShortcutBinding,
    removeShortcutBinding,

    llmEnabled,
    setLlmEnabled,
    llmProvider,
    setLlmProvider,
    llmEndpoint,
    setLlmEndpoint,
    llmApiKey,
    setLlmApiKey,
    llmModel,
    setLlmModel,
    llmConfigReady,
    aiFeaturesReady,
    licenseGateActive,
    activeLicense,
    availableModels,
    fetchAvailableModels,
    availableSpeechModels,
    fetchAvailableSpeechModels,
    editModeEnabled,
    setEditModeEnabled,
    autoDictionaryEnabled,
    autoDictionarySupported,
    setAutoDictionaryEnabled,
    mediaAction,
    setMediaAction,
    autoUpdateEnabled,
    setAutoUpdateEnabled,
    autoLaunchEnabled,
    setAutoLaunchEnabled,
    startInBackground,
    setStartInBackground,
    autoDeleteTarget,
    setAutoDeleteTarget,
    autoDeleteDuration,
    setAutoDeleteDuration,
    analyticsEnabled,
    setAnalyticsEnabled,
    localApiKey,
    setLocalApiKey,
    localApiPort,
    setLocalApiPort,
    localApiModel,
    setLocalApiModel,
    localApiHost,
    setLocalApiHost,
    localApiStartOnLaunch,
    setLocalApiStartOnLaunch,
    localApiCors,
    setLocalApiCors,
    localApiStatus,
    localApiBusy,
    cliInstallStatus,
    cliInstallBusy,
    handleStartLocalApi,
    handleStopLocalApi,
    handleRestartLocalApi,
    handleClearLocalApiLogs,
    handleInstallCli,
    handleRemoveCli,
    platformCapabilities,

    micPermission,
    accessibilityPermission,
    inputMonitoringPermission,
    handleRequestMicrophonePermission,
    textSizeMode,
    setTextSizeMode,
    themeMode,
    setThemeMode,

    showFAQModal,
    setShowFAQModal,
    whatsNewOpen,
    setWhatsNewOpen,

    handleDownload,
    handleDelete,
    handleCancelDownload,
    handleOpenDataDir,
    formatBytes,
  };
}
