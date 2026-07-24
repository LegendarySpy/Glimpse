import { useLingui } from "@lingui/react/macro";
import { useEffect } from "react";
import { useCopyToClipboard } from "../../../shared/hooks/useCopyToClipboard";
import { motion, AnimatePresence } from "framer-motion";
import {
  AppWindow,
  Check,
  Copy,
  Cpu,
  Info,
  Key,
  SquaresFour,
  HardDrives as Server,
  User,
  X,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import FAQModal from "../../../shared/ui/FAQModal";
import WhatsNewModal from "../../updates/components/WhatsNewModal";
import AboutTab from "./tabs/AboutTab";
import AccountTab from "./tabs/AccountTab";
import GeneralTab from "./tabs/GeneralTab";
import LocalApiTab from "./tabs/LocalApiTab";
import ModelsTab from "./tabs/ModelsTab";
import AppTab from "./tabs/AppTab";
import ProvidersTab from "./tabs/ProvidersTab";
import type { TranscriptionMode } from "../../../types";
import { useSettingsForm } from "../useSettingsForm";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?:
    | "general"
    | "account"
    | "models"
    | "providers"
    | "local-api"
    | "about"
    | "app";
  transcriptionMode: TranscriptionMode;
}

const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

const modalVariants = {
  hidden: { opacity: 0, scale: 0.97, y: 6 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 400, damping: 30 },
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    y: 6,
    transition: { duration: 0.12 },
  },
};

const tabContentVariants = {
  hidden: { opacity: 1, x: 0 },
  visible: { opacity: 1, x: 0, transition: { duration: 0 } },
  exit: { opacity: 1, x: 0, transition: { duration: 0 } },
};

const SettingsModal = ({
  isOpen,
  onClose,
  initialTab = "general",
  transcriptionMode: initialTranscriptionMode,
}: SettingsModalProps) => {
  const { t } = useLingui();
  const form = useSettingsForm({
    isOpen,
    onClose,
    initialTab,
    transcriptionMode: initialTranscriptionMode,
  });
  const { activeTab, activeLicense, setActiveTab } = form;
  const localApiLocked = !activeLicense;
  const localApiLockedReason = t({
    id: "settings.modal.api_server.full_license_required",
    message: "API Server requires a full active license.",
  });

  useEffect(() => {
    if (!localApiLocked) return;
    if (activeTab === "local-api") {
      setActiveTab("general");
    }
  }, [activeTab, localApiLocked, setActiveTab]);

  const handleOpenTab = (
    tab: "general" | "models" | "providers" | "local-api" | "about" | "app",
  ) => {
    if (localApiLocked && tab === "local-api") return;
    setActiveTab(tab);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="settings-modal"
          className="fixed inset-0 z-50 flex items-center justify-center"
          initial="hidden"
          animate="visible"
          exit="hidden"
        >
          <motion.div
            className="absolute inset-0 bg-black/60 backdrop-blur-xs"
            variants={backdropVariants}
            onClick={onClose}
          />

          <motion.div
            className="relative flex h-[655px] w-[850px] max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-border-secondary bg-surface-overlay shadow-2xl shadow-black/50"
            variants={modalVariants}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={t({
              id: "settings.modal.dialog_label",
              message: "Settings",
            })}
          >
            <motion.button
              onClick={onClose}
              className="absolute right-2 top-3 z-20 flex h-7 w-7 items-center justify-center rounded-lg text-content-muted hover:bg-surface-elevated hover:text-content-secondary transition-colors"
              whileTap={{ scale: 0.95 }}
              aria-label={t({
                id: "settings.modal.close_button",
                message: "Close settings",
              })}
            >
              <X size={14} aria-hidden="true" />
            </motion.button>

            <aside className="flex w-44 flex-col border-r border-border-primary bg-surface-surface">
              <div className="px-4 pt-5 pb-4">
                <h2 className="ui-text-title-strong ui-color-primary">
                  {t({
                    id: "settings.modal.title",
                    message: "Settings",
                  })}
                </h2>
              </div>
              <nav className="flex-1 px-2 space-y-4">
                <div className="space-y-1">
                  <ModalNavItem
                    icon={User}
                    label={t({
                      id: "settings.modal.tab.account",
                      message: "Account",
                    })}
                    active={form.activeTab === "account"}
                    onClick={() => form.setActiveTab("account")}
                  />
                </div>

                <div className="space-y-1">
                  <p className="px-2.5 pb-1.5 ui-text-uppercase-meta ui-color-disabled font-semibold">
                    {t({
                      id: "settings.modal.section.core",
                      message: "Core",
                    })}
                  </p>
                  <ModalNavItem
                    icon={SquaresFour}
                    label={t({
                      id: "settings.modal.tab.general",
                      message: "General",
                    })}
                    active={form.activeTab === "general"}
                    onClick={() => form.setActiveTab("general")}
                  />
                  <ModalNavItem
                    icon={AppWindow}
                    label={t({
                      id: "settings.modal.tab.app",
                      message: "App",
                    })}
                    active={form.activeTab === "app"}
                    onClick={() => form.setActiveTab("app")}
                  />
                  <ModalNavItem
                    icon={Info}
                    label={t({
                      id: "settings.modal.tab.about",
                      message: "About",
                    })}
                    active={form.activeTab === "about"}
                    onClick={() => form.setActiveTab("about")}
                  />
                </div>

                {!form.loading && form.transcriptionMode === "local" && (
                  <div className="space-y-1">
                    <p className="px-2.5 pb-1.5 ui-text-uppercase-meta ui-color-disabled font-semibold">
                      {t({
                        id: "settings.modal.section.local",
                        message: "Local",
                      })}
                    </p>
                    <ModalNavItem
                      icon={Cpu}
                      label={t({
                        id: "settings.modal.tab.models",
                        message: "Models",
                      })}
                      active={form.activeTab === "models"}
                      onClick={() => form.setActiveTab("models")}
                    />
                    <ModalNavItem
                      icon={Key}
                      label={t({
                        id: "settings.modal.tab.providers",
                        message: "Providers",
                      })}
                      active={form.activeTab === "providers"}
                      onClick={() => form.setActiveTab("providers")}
                    />
                  </div>
                )}

                <div className="space-y-1">
                  <p className="px-2.5 pb-1.5 ui-text-uppercase-meta ui-color-disabled font-semibold">
                    {t({
                      id: "settings.modal.section.developer",
                      message: "Developer",
                    })}
                  </p>
                  <ModalNavItem
                    icon={Server}
                    label={t({
                      id: "settings.modal.tab.api_server",
                      message: "API Server",
                    })}
                    active={form.activeTab === "local-api"}
                    disabled={localApiLocked}
                    disabledReason={localApiLockedReason}
                    onClick={() => form.setActiveTab("local-api")}
                  />
                </div>
              </nav>
              <div className="px-2 pb-2">
                <SettingsErrorBanner
                  error={form.error}
                  sourceTab={form.errorSourceTab}
                  onOpenTab={handleOpenTab}
                />
              </div>
            </aside>

            <main className="flex flex-1 flex-col min-h-0 bg-surface-overlay">
              <div
                className={`flex-1 min-h-0 px-6 pt-8 pb-5 settings-scroll ${
                  form.activeTab === "models"
                    ? "overflow-hidden"
                    : "overflow-y-scroll"
                }`}
                style={{ scrollbarGutter: "stable" }}
              >
                {form.loading ? null : (
                  <AnimatePresence mode="wait">
                    {form.activeTab === "account" && (
                      <AccountTab key="account" variants={tabContentVariants} />
                    )}

                    {form.activeTab === "general" && (
                      <GeneralTab
                        key="general"
                        variants={tabContentVariants}
                        transcriptionMode={form.transcriptionMode}
                        onTranscriptionModeChange={form.setTranscriptionMode}
                        modelStatus={form.modelStatus}
                        localModel={form.localModel}
                        remoteSpeechEnabled={form.remoteSpeechEnabled}
                        remoteSpeechProvider={form.remoteSpeechProvider}
                        remoteSpeechEndpoint={form.remoteSpeechEndpoint}
                        remoteSpeechModel={form.remoteSpeechModel}
                        onOpenModelsTab={() => form.setActiveTab("models")}
                        onOpenProvidersTab={() =>
                          form.setActiveTab("providers")
                        }
                        onOpenAccountTab={() => form.setActiveTab("account")}
                        inputDevices={form.inputDevices}
                        microphoneDevice={form.microphoneDevice}
                        onMicrophoneDeviceChange={form.setMicrophoneDevice}
                        language={form.language}
                        onLanguageChange={form.setLanguage}
                        languages={form.languages}
                        smartEnabled={form.smartEnabled}
                        setSmartEnabled={form.setSmartEnabled}
                        holdEnabled={form.holdEnabled}
                        setHoldEnabled={form.setHoldEnabled}
                        toggleEnabled={form.toggleEnabled}
                        setToggleEnabled={form.setToggleEnabled}
                        shortcutBindings={form.shortcutBindings}
                        invalidShortcutDrafts={form.invalidShortcutDrafts}
                        captureActive={form.captureActive}
                        capturePreview={form.capturePreview}
                        onStartCapture={form.handleStartCapture}
                        updateShortcutBinding={form.updateShortcutBinding}
                        addShortcutBinding={form.addShortcutBinding}
                        removeShortcutBinding={form.removeShortcutBinding}
                        editModeEnabled={form.editModeEnabled}
                        setEditModeEnabled={form.setEditModeEnabled}
                        autoDictionaryEnabled={form.autoDictionaryEnabled}
                        autoDictionarySupported={form.autoDictionarySupported}
                        setAutoDictionaryEnabled={form.setAutoDictionaryEnabled}
                        aiFeaturesReady={form.aiFeaturesReady}
                        licenseGateActive={form.licenseGateActive}
                      />
                    )}

                    {form.activeTab === "models" && (
                      <ModelsTab
                        key="models"
                        variants={tabContentVariants}
                        modelCatalog={form.modelCatalog}
                        modelStatus={form.modelStatus}
                        downloadState={form.downloadState}
                        localModel={form.localModel}
                        remoteSpeechEnabled={form.remoteSpeechEnabled}
                        remoteSpeechProvider={form.remoteSpeechProvider}
                        remoteSpeechModel={form.remoteSpeechModel}
                        setLocalModel={form.setLocalModel}
                        handleDownload={form.handleDownload}
                        handleDelete={form.handleDelete}
                        handleCancelDownload={form.handleCancelDownload}
                        onOpenProvidersTab={() =>
                          form.setActiveTab("providers")
                        }
                      />
                    )}

                    {form.activeTab === "providers" && (
                      <ProvidersTab
                        key="providers"
                        variants={tabContentVariants}
                        llmEnabled={form.llmEnabled}
                        setLlmEnabled={form.setLlmEnabled}
                        llmProvider={form.llmProvider}
                        setLlmProvider={form.setLlmProvider}
                        llmEndpoint={form.llmEndpoint}
                        setLlmEndpoint={form.setLlmEndpoint}
                        llmApiKey={form.llmApiKey}
                        setLlmApiKey={form.setLlmApiKey}
                        llmModel={form.llmModel}
                        setLlmModel={form.setLlmModel}
                        availableModels={form.availableModels}
                        fetchAvailableModels={form.fetchAvailableModels}
                        remoteSpeechEnabled={form.remoteSpeechEnabled}
                        setRemoteSpeechEnabled={form.setRemoteSpeechEnabled}
                        remoteSpeechProvider={form.remoteSpeechProvider}
                        setRemoteSpeechProvider={form.setRemoteSpeechProvider}
                        remoteSpeechEndpoint={form.remoteSpeechEndpoint}
                        setRemoteSpeechEndpoint={form.setRemoteSpeechEndpoint}
                        remoteSpeechApiKey={form.remoteSpeechApiKey}
                        setRemoteSpeechApiKey={form.setRemoteSpeechApiKey}
                        remoteSpeechModel={form.remoteSpeechModel}
                        setRemoteSpeechModel={form.setRemoteSpeechModel}
                        availableSpeechModels={form.availableSpeechModels}
                        fetchAvailableSpeechModels={
                          form.fetchAvailableSpeechModels
                        }
                      />
                    )}

                    {form.activeTab === "local-api" && !localApiLocked && (
                      <LocalApiTab
                        key="local-api"
                        variants={tabContentVariants}
                        modelCatalog={form.modelCatalog}
                        modelStatus={form.modelStatus}
                        apiKey={form.localApiKey}
                        setApiKey={form.setLocalApiKey}
                        port={form.localApiPort}
                        setPort={form.setLocalApiPort}
                        model={form.localApiModel}
                        setModel={form.setLocalApiModel}
                        host={form.localApiHost}
                        setHost={form.setLocalApiHost}
                        startOnLaunch={form.localApiStartOnLaunch}
                        setStartOnLaunch={form.setLocalApiStartOnLaunch}
                        cors={form.localApiCors}
                        setCors={form.setLocalApiCors}
                        status={form.localApiStatus}
                        busy={form.localApiBusy}
                        onStart={form.handleStartLocalApi}
                        onStop={form.handleStopLocalApi}
                        onRestart={form.handleRestartLocalApi}
                        onClearLogs={form.handleClearLocalApiLogs}
                      />
                    )}

                    {form.activeTab === "app" && (
                      <AppTab
                        key="app"
                        variants={tabContentVariants}
                        micPermission={form.micPermission}
                        accessibilityPermission={form.accessibilityPermission}
                        inputMonitoringPermission={
                          form.inputMonitoringPermission
                        }
                        onRequestMicrophonePermission={
                          form.handleRequestMicrophonePermission
                        }
                        textSizeMode={form.textSizeMode}
                        onTextSizeModeChange={form.setTextSizeMode}
                        themeMode={form.themeMode}
                        onThemeModeChange={form.setThemeMode}
                        appLocale={form.appLocale}
                        onAppLocaleChange={form.setAppLocale}
                        mediaAction={form.mediaAction}
                        onMediaActionChange={form.setMediaAction}
                        autoUpdateEnabled={form.autoUpdateEnabled}
                        onAutoUpdateEnabledChange={form.setAutoUpdateEnabled}
                        storeBuild={form.appInfo?.store_build ?? false}
                        autoLaunchEnabled={form.autoLaunchEnabled}
                        onAutoLaunchEnabledChange={form.setAutoLaunchEnabled}
                        startInBackground={form.startInBackground}
                        onStartInBackgroundChange={form.setStartInBackground}
                        autoDeleteTarget={form.autoDeleteTarget}
                        onAutoDeleteTargetChange={form.setAutoDeleteTarget}
                        autoDeleteDuration={form.autoDeleteDuration}
                        onAutoDeleteDurationChange={form.setAutoDeleteDuration}
                        analyticsEnabled={form.analyticsEnabled}
                        onAnalyticsEnabledChange={form.setAnalyticsEnabled}
                        platformCapabilities={form.platformCapabilities}
                      />
                    )}

                    {form.activeTab === "about" && (
                      <AboutTab
                        key="about"
                        variants={tabContentVariants}
                        appInfo={form.appInfo}
                        transcriptionMode={form.transcriptionMode}
                        formatBytes={form.formatBytes}
                        cliInstallStatus={form.cliInstallStatus}
                        cliInstallBusy={form.cliInstallBusy}
                        activeLicense={form.activeLicense}
                        onInstallCli={form.handleInstallCli}
                        onRemoveCli={form.handleRemoveCli}
                        onOpenDataDir={form.handleOpenDataDir}
                        onOpenFAQ={() => form.setShowFAQModal(true)}
                        onOpenWhatsNew={() => form.setWhatsNewOpen(true)}
                      />
                    )}
                  </AnimatePresence>
                )}
              </div>
            </main>
          </motion.div>
        </motion.div>
      )}

      <FAQModal
        key="faq-modal"
        isOpen={form.showFAQModal}
        onClose={() => form.setShowFAQModal(false)}
      />
      <WhatsNewModal
        key="whats-new-modal"
        isOpen={form.whatsNewOpen}
        onClose={() => form.setWhatsNewOpen(false)}
      />
    </AnimatePresence>
  );
};

const SettingsErrorBanner = ({
  error,
  sourceTab,
  onOpenTab,
}: {
  error: string | null;
  sourceTab:
    "general" | "models" | "providers" | "local-api" | "about" | "app" | null;
  onOpenTab: (
    tab: "general" | "models" | "providers" | "local-api" | "about" | "app",
  ) => void;
}) => {
  const { copied, copy } = useCopyToClipboard(1500);

  const handleCopy = () => {
    if (error) copy(error);
  };

  return (
    <AnimatePresence initial={false}>
      {error && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          className={`rounded-lg border border-error/20 bg-error/5 px-2 py-1.5 ${
            sourceTab
              ? "cursor-pointer transition-colors hover:bg-error/10"
              : ""
          }`}
          role={sourceTab ? "button" : undefined}
          tabIndex={sourceTab ? 0 : undefined}
          onClick={() => {
            if (sourceTab) onOpenTab(sourceTab);
          }}
          onKeyDown={(event) => {
            if (!sourceTab) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpenTab(sourceTab);
            }
          }}
        >
          <p className="break-words [overflow-wrap:anywhere] ui-text-meta ui-color-error leading-snug">
            <span>{error}</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleCopy();
              }}
              className="ml-1 inline-flex align-[-2px] text-error/60 transition-colors hover:text-error"
              aria-label="Copy error"
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

const ModalNavItem = ({
  icon: Icon,
  label,
  active,
  disabled = false,
  disabledReason,
  onClick,
}: {
  icon: PhosphorIcon;
  label: string;
  active: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
}) => (
  <motion.button
    onClick={onClick}
    disabled={disabled}
    title={disabled ? disabledReason : undefined}
    className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 ui-text-body-sm-strong transition-colors ${
      disabled
        ? "cursor-not-allowed text-content-disabled/60"
        : active
          ? "bg-surface-elevated ui-color-primary"
          : "ui-color-muted hover:bg-surface-elevated hover:text-content-secondary"
    }`}
    whileTap={disabled ? undefined : { scale: 0.98 }}
  >
    <div
      className={
        disabled
          ? "text-content-disabled/50"
          : active
            ? "text-content-primary"
            : "text-content-disabled"
      }
    >
      <Icon size={14} weight={active ? "fill" : "regular"} aria-hidden="true" />
    </div>
    {label}
  </motion.button>
);

export default SettingsModal;
