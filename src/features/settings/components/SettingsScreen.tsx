import { useLingui } from "@lingui/react/macro";
import { useEffect } from "react";
import { useCopyToClipboard } from "../../../shared/hooks/useCopyToClipboard";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Copy } from "@phosphor-icons/react";
import FAQModal from "../../../shared/ui/FAQModal";
import WhatsNewModal from "../../updates/components/WhatsNewModal";
import AboutTab from "./tabs/AboutTab";
import AccountTab from "./tabs/AccountTab";
import GeneralTab from "./tabs/GeneralTab";
import LocalApiTab from "./tabs/LocalApiTab";
import ModelsTab from "./tabs/ModelsTab";
import AppTab from "./tabs/AppTab";
import ProvidersTab from "./tabs/ProvidersTab";
import type { PurchaseSource } from "../../license/purchaseConfig";
import type { TranscriptionMode } from "../../../types";
import { useSettingsForm } from "../useSettingsForm";
import { SETTINGS_PANE_LABELS, type SettingsPane } from "../settingsPanes";

type LegacyTab =
  | "general"
  | "account"
  | "models"
  | "providers"
  | "local-api"
  | "about"
  | "app";

const paneForLegacyTab: Record<LegacyTab, SettingsPane> = {
  account: "account",
  general: "general",
  app: "app",
  about: "about",
  models: "models",
  providers: "providers",
  "local-api": "api",
};

const legacyTabFor = (pane: SettingsPane): LegacyTab =>
  pane === "api" ? "local-api" : pane;

interface SettingsScreenProps {
  active: boolean;
  pane: SettingsPane;
  onPaneChange: (pane: SettingsPane) => void;
  onClose: () => void;
  accountSource?: PurchaseSource;
  transcriptionMode: TranscriptionMode;
}

const paneVariants = {
  hidden: { opacity: 1, x: 0 },
  visible: { opacity: 1, x: 0, transition: { duration: 0 } },
  exit: { opacity: 1, x: 0, transition: { duration: 0 } },
};

const SettingsScreen = ({
  active,
  pane,
  onPaneChange,
  onClose,
  accountSource = "settings_account",
  transcriptionMode: initialTranscriptionMode,
}: SettingsScreenProps) => {
  const { i18n } = useLingui();
  const form = useSettingsForm({
    isOpen: true,
    active,
    onClose,
    initialTab: legacyTabFor(pane),
    transcriptionMode: initialTranscriptionMode,
  });
  const { activeLicense, setActiveTab, setShowFAQModal, setWhatsNewOpen } =
    form;
  const localApiLocked = !activeLicense;

  useEffect(() => {
    setActiveTab(legacyTabFor(pane));
  }, [pane, setActiveTab]);

  useEffect(() => {
    setShowFAQModal(false);
    setWhatsNewOpen(false);
  }, [pane, active, setShowFAQModal, setWhatsNewOpen]);

  const handleOpenTab = (tab: LegacyTab) => {
    if (localApiLocked && tab === "local-api") return;
    onPaneChange(paneForLegacyTab[tab]);
  };

  return (
    <div className="settings-typescale flex flex-1 flex-col min-h-0">
      <header className="shrink-0 px-8 pb-4">
        <h1 className="ui-text-screen-title ui-color-primary tracking-tight">
          {i18n._(SETTINGS_PANE_LABELS[pane])}
        </h1>
      </header>

      {form.error && (
        <div className="px-8 pt-2">
          <SettingsErrorBanner
            error={form.error}
            sourceTab={form.errorSourceTab}
            onOpenTab={handleOpenTab}
          />
        </div>
      )}

      <div
        className="flex-1 min-h-0 px-8 pt-2 pb-6 settings-scroll overflow-y-scroll"
        style={{ scrollbarGutter: "stable" }}
      >
        {form.loading ? null : (
          <AnimatePresence mode="wait">
            {pane === "account" && (
              <AccountTab
                key="account"
                variants={paneVariants}
                source={accountSource}
              />
            )}

            {pane === "general" && (
              <GeneralTab
                key="general"
                variants={paneVariants}
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
                autoDictionaryEnabled={form.autoDictionaryEnabled}
                autoDictionarySupported={form.autoDictionarySupported}
                setAutoDictionaryEnabled={form.setAutoDictionaryEnabled}
                aiFeaturesReady={form.aiFeaturesReady}
                licenseGateActive={form.licenseGateActive}
                onOpenAccountTab={() => onPaneChange("account")}
                onOpenProvidersTab={() => onPaneChange("providers")}
              />
            )}

            {pane === "models" && (
              <ModelsTab
                key="models"
                variants={paneVariants}
                modelCatalog={form.modelCatalog}
                modelStatus={form.modelStatus}
                downloadState={form.downloadState}
                localModel={form.localModel}
                remoteSpeechEnabled={form.remoteSpeechEnabled}
                setRemoteSpeechEnabled={form.setRemoteSpeechEnabled}
                remoteSpeechProvider={form.remoteSpeechProvider}
                remoteSpeechEndpoint={form.remoteSpeechEndpoint}
                remoteSpeechModel={form.remoteSpeechModel}
                setLocalModel={form.setLocalModel}
                handleDownload={form.handleDownload}
                handleDelete={form.handleDelete}
                handleCancelDownload={form.handleCancelDownload}
                onOpenProvidersTab={() => onPaneChange("providers")}
              />
            )}

            {pane === "providers" && (
              <ProvidersTab
                key="providers"
                variants={paneVariants}
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
                remoteSpeechProvider={form.remoteSpeechProvider}
                setRemoteSpeechProvider={form.setRemoteSpeechProvider}
                remoteSpeechEndpoint={form.remoteSpeechEndpoint}
                setRemoteSpeechEndpoint={form.setRemoteSpeechEndpoint}
                remoteSpeechApiKey={form.remoteSpeechApiKey}
                setRemoteSpeechApiKey={form.setRemoteSpeechApiKey}
                remoteSpeechModel={form.remoteSpeechModel}
                setRemoteSpeechModel={form.setRemoteSpeechModel}
                availableSpeechModels={form.availableSpeechModels}
                fetchAvailableSpeechModels={form.fetchAvailableSpeechModels}
              />
            )}

            {pane === "app" && (
              <AppTab
                key="app"
                variants={paneVariants}
                active={active}
                micPermission={form.micPermission}
                accessibilityPermission={form.accessibilityPermission}
                inputMonitoringPermission={form.inputMonitoringPermission}
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

            {pane === "about" && (
              <AboutTab
                key="about"
                variants={paneVariants}
                appInfo={form.appInfo}
                transcriptionMode={form.transcriptionMode}
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

            {pane === "api" && !localApiLocked && (
              <LocalApiTab
                key="api"
                variants={paneVariants}
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
          </AnimatePresence>
        )}
      </div>

      {active && (
        <>
          <FAQModal
            isOpen={form.showFAQModal}
            onClose={() => form.setShowFAQModal(false)}
          />
          <WhatsNewModal
            isOpen={form.whatsNewOpen}
            onClose={() => form.setWhatsNewOpen(false)}
          />
        </>
      )}
    </div>
  );
};

const SettingsErrorBanner = ({
  error,
  sourceTab,
  onOpenTab,
}: {
  error: string | null;
  sourceTab: Exclude<LegacyTab, "account"> | null;
  onOpenTab: (tab: LegacyTab) => void;
}) => {
  const { t } = useLingui();
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
              aria-label={t({
                id: "settings.error.copy",
                message: "Copy error",
              })}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default SettingsScreen;
