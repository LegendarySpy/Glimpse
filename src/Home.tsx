import { useLingui } from "@lingui/react/macro";
import {
  lazy,
  Suspense,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CaretLeft as ChevronLeft,
  House as HomeIcon,
  BookBookmark as Book,
  CardsThree as Brain,
  Info,
  Question as HelpCircle,
  Bug,
  Check,
  Copy,
  X,
  ArrowCircleUp as ArrowUpCircle,
  Books as Library,
} from "@phosphor-icons/react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import WindowControls from "./shared/ui/WindowControls";
import SidebarItem from "./shared/ui/SidebarItem";
import SettingsNavToggle from "./features/settings/components/SettingsNavToggle";
import {
  SETTINGS_PANE_GROUPS,
  type SettingsPane,
} from "./features/settings/settingsPanes";
import { i18n } from "./i18n";
import { detectAppPlatform } from "./platform/service";
import { useClickOutside } from "./shared/hooks/useClickOutside";
import { useCopyToClipboard } from "./shared/hooks/useCopyToClipboard";
import HomeTodayHeader from "./features/transcriptions/components/HomeTodayHeader";
import TranscriptionList from "./features/transcriptions/components/TranscriptionList";
import { useTodayDictationStats } from "./features/transcriptions/queries";
import { EMPTY_TODAY_DICTATION_STATS } from "./features/transcriptions/todayStats";
import { useTimeOfDayPeriodTick } from "./features/transcriptions/homeGreeting";
import DictionaryView from "./features/dictionary/components/DictionaryView";
import PersonalizationView from "./features/personalization/components/PersonalizationView";
import LibraryView from "./features/library/components/LibraryView";
import LocalApiSidebarStatus from "./features/settings/components/LocalApiSidebarStatus";
import NewsMenu from "./features/news/components/NewsMenu";
import AccountPill from "./features/license/components/AccountPill";
import { getLocalApiStatus } from "./features/settings/models-api";
import type { LocalApiStatus } from "./types";
import { useLicenseGate, useLicenseState } from "./features/license/queries";
import type { PurchaseSource } from "./features/license/purchaseConfig";
import { useSettings, useAppInfo } from "./features/settings/queries";
import { useUpdateStatus } from "./features/updates/queries";
import type { TranscriptionMode } from "./types";

const importSettingsScreen = () =>
  import("./features/settings/components/SettingsScreen");
const SettingsScreen = lazy(importSettingsScreen);
const FAQModal = lazy(() => import("./shared/ui/FAQModal"));

type ActiveView = "home" | "dictionary" | "brain" | "library";

let cachedLocalApiStatus: LocalApiStatus | null = null;

const STATIC_LOGO_DOT_SIZE = 5;
const STATIC_LOGO_GAP = 3;
const STATIC_LOGO_DISTANCE = STATIC_LOGO_DOT_SIZE + STATIC_LOGO_GAP;
const STATIC_LOGO_RADIUS = STATIC_LOGO_DOT_SIZE / 2;
const STATIC_LOGO_GRID_SIZE = STATIC_LOGO_DOT_SIZE * 2 + STATIC_LOGO_GAP;
const STATIC_LOGO_DOT_COLORS = [
  "var(--color-cloud)",
  "var(--color-local)",
  "var(--color-local)",
  "var(--color-cloud)",
];
const STATIC_LOGO_COORDS = [
  { cx: STATIC_LOGO_RADIUS, cy: STATIC_LOGO_RADIUS },
  { cx: STATIC_LOGO_RADIUS + STATIC_LOGO_DISTANCE, cy: STATIC_LOGO_RADIUS },
  { cx: STATIC_LOGO_RADIUS, cy: STATIC_LOGO_RADIUS + STATIC_LOGO_DISTANCE },
  {
    cx: STATIC_LOGO_RADIUS + STATIC_LOGO_DISTANCE,
    cy: STATIC_LOGO_RADIUS + STATIC_LOGO_DISTANCE,
  },
];

const isMac = detectAppPlatform() === "macos";
const isWindows = detectAppPlatform() === "windows";

const SUPPORT_GITHUB_URL =
  "https://github.com/glimpse-hq/Glimpse/issues/new/choose";
const SUPPORT_EMAIL = "hello@tryglimpse.cc";

const StaticGlimpseLogo = ({
  cloudActive,
  localActive,
}: {
  cloudActive: boolean;
  localActive: boolean;
}) => {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={STATIC_LOGO_GRID_SIZE}
      height={STATIC_LOGO_GRID_SIZE}
      viewBox={`0 0 ${STATIC_LOGO_GRID_SIZE} ${STATIC_LOGO_GRID_SIZE}`}
      style={{ overflow: "visible" }}
    >
      {STATIC_LOGO_COORDS.map((coord, i) => {
        const isCloudDot = i === 0 || i === 3;
        const isActive = isCloudDot ? cloudActive : localActive;
        return (
          <circle
            key={`dot-${i}`}
            cx={coord.cx}
            cy={coord.cy}
            r={STATIC_LOGO_RADIUS}
            fill={STATIC_LOGO_DOT_COLORS[i]}
            opacity={isActive ? 1 : 0.15}
          />
        );
      })}
    </svg>
  );
};

const Home = () => {
  const { t } = useLingui();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsPane>("account");
  const [accountSource, setAccountSource] =
    useState<PurchaseSource>("settings_account");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const [activeView, setActiveView] = useState<ActiveView>("home");
  const licenseGateActive = useLicenseGate();
  const { data: licenseState } = useLicenseState();
  const activeLicense = licenseState?.status === "active";
  const [showSupportPopup, setShowSupportPopup] = useState(false);
  const {
    copied: supportEmailCopied,
    copy: copyEmail,
    reset: resetEmailCopied,
  } = useCopyToClipboard(1200);
  const [showFAQ, setShowFAQ] = useState(false);
  const [faqOpened, setFaqOpened] = useState(false);
  const supportMenuRef = useRef<HTMLDivElement>(null);

  const [dragActive, setDragActive] = useState(false);
  const [localApiStatus, setLocalApiStatus] = useState<LocalApiStatus | null>(
    () => cachedLocalApiStatus,
  );
  const [pendingImportPaths, setPendingImportPaths] = useState<string[] | null>(
    null,
  );
  const licenseGateActiveRef = useRef(false);

  const { data: settings } = useSettings();
  const { data: updateStatus } = useUpdateStatus();
  const { data: appInfoData } = useAppInfo();

  const transcriptionMode: TranscriptionMode =
    settings?.transcription_mode ?? "local";
  const remoteSpeechEnabled = settings?.remote_speech_enabled ?? false;
  const llmEnabled = settings?.llm_enabled ?? false;
  const appVersion = appInfoData?.version ?? "-";
  const updateAvailable = updateStatus?.available ?? false;

  useEffect(() => {
    if (isSettingsOpen) setSettingsMounted(true);
  }, [isSettingsOpen]);

  // Mount settings hidden while the app is idle so its queries are already
  // warm and the first click has nothing to wait for.
  useEffect(() => {
    const warm = () => {
      void importSettingsScreen().then(() => setSettingsMounted(true));
    };
    const idle = window.requestIdleCallback?.(warm);
    if (idle === undefined) {
      const timer = window.setTimeout(warm, 1500);
      return () => window.clearTimeout(timer);
    }
    return () => window.cancelIdleCallback?.(idle);
  }, []);

  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
    setSettingsTab("account");
    setAccountSource("settings_account");
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    setIsSidebarCollapsed((collapsed) => !collapsed);
  }, []);

  useEffect(() => {
    if (showFAQ) setFaqOpened(true);
  }, [showFAQ]);

  useEffect(() => {
    licenseGateActiveRef.current = licenseGateActive;
    if (
      !licenseGateActive &&
      (activeView === "brain" || activeView === "library")
    ) {
      setActiveView("home");
      setDragActive(false);
      setPendingImportPaths(null);
    }
  }, [activeView, licenseGateActive]);

  const wideLights = isMac && (appInfoData?.os_major ?? 26) >= 26;
  const collapsedWidth = wideLights ? 78 : 68;
  const sidebarIconPl = wideLights ? 21 : isWindows ? 16 : 17;
  const sidebarWidth = isSidebarCollapsed ? collapsedWidth : 200;

  const updateLocalApiStatus = useCallback((status: LocalApiStatus) => {
    cachedLocalApiStatus = status;
    setLocalApiStatus(status);
  }, []);

  const openAccountSettings = useCallback(
    (source: PurchaseSource = "settings_account") => {
      setAccountSource(source);
      setSettingsTab("account");
      setIsSettingsOpen(true);
    },
    [],
  );

  const openLocalApiSettings = useCallback(() => {
    setSettingsTab(activeLicense ? "api" : "account");
    setIsSettingsOpen(true);
  }, [activeLicense]);

  useEffect(() => {
    let cancelled = false;
    let unlistenStatus: UnlistenFn | null = null;

    getLocalApiStatus()
      .then((status) => {
        if (!cancelled) updateLocalApiStatus(status);
      })
      .catch(() => {});

    listen<LocalApiStatus>("local-api:status", (event) => {
      if (!cancelled) updateLocalApiStatus(event.payload);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenStatus = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlistenStatus?.();
    };
  }, [updateLocalApiStatus]);

  useEffect(() => {
    let cancelled = false;
    let unlistenNavigate: UnlistenFn | null = null;
    let unlistenHistory: UnlistenFn | null = null;
    let unlistenModels: UnlistenFn | null = null;
    let unlistenAccount: UnlistenFn | null = null;
    let unlistenDragEnter: UnlistenFn | null = null;
    let unlistenDragOver: UnlistenFn | null = null;
    let unlistenDragLeave: UnlistenFn | null = null;
    let unlistenDragDrop: UnlistenFn | null = null;
    let unlistenOpenImport: UnlistenFn | null = null;
    let unlistenLicenseReturn: UnlistenFn | null = null;

    const navigateReady = listen("navigate:about", () => {
      setSettingsTab("about");
      setIsSettingsOpen(true);
      emit("updater:check").catch(() => {});
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenNavigate = fn;
    });

    const historyReady = listen("navigate:history", () => {
      setIsSettingsOpen(false);
      setAccountSource("settings_account");
      setActiveView("home");
      setDragActive(false);
      setPendingImportPaths(null);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenHistory = fn;
    });

    const modelsReady = listen("navigate:models", () => {
      setSettingsTab("models");
      setIsSettingsOpen(true);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenModels = fn;
    });

    const accountReady = listen("navigate:account", () => {
      setAccountSource("trial_toast");
      setSettingsTab("account");
      setIsSettingsOpen(true);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenAccount = fn;
    });

    Promise.all([navigateReady, historyReady, modelsReady, accountReady])
      .then(() => {
        if (!cancelled) {
          emit("settings:renderer_ready").catch(() => {});
        }
      })
      .catch((err) => {
        console.error("Failed to register settings navigation listeners:", err);
      });

    listen<{ paths?: string[] }>("tauri://drag-enter", (event) => {
      if (!licenseGateActiveRef.current) return;
      if (event.payload?.paths?.length) setDragActive(true);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenDragEnter = fn;
      })
      .catch(() => {});

    listen<{ paths?: string[] }>("tauri://drag-over", (event) => {
      if (!licenseGateActiveRef.current) return;
      if (event.payload?.paths?.length) setDragActive(true);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenDragOver = fn;
      })
      .catch(() => {});

    listen("tauri://drag-leave", () => {
      setDragActive(false);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenDragLeave = fn;
      })
      .catch(() => {});

    listen<{ paths?: string[] }>("tauri://drag-drop", (event) => {
      setDragActive(false);
      if (!licenseGateActiveRef.current) return;
      if (event.payload?.paths?.length) {
        setPendingImportPaths(Array.from(new Set(event.payload.paths)));
        setActiveView("library");
        setIsSettingsOpen(false);
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenDragDrop = fn;
      })
      .catch(() => {});

    listen<string[]>("library:open_import", (event) => {
      if (!licenseGateActiveRef.current) return;
      if (event.payload?.length) {
        setPendingImportPaths(Array.from(new Set(event.payload)));
        setActiveView("library");
        setIsSettingsOpen(false);
      }
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlistenOpenImport = fn;
          emit("library:renderer_ready").catch(() => {});
        }
      })
      .catch(() => {});

    listen("license:checkout-returned", () => {
      setSettingsTab("account");
      setIsSettingsOpen(true);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenLicenseReturn = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlistenNavigate?.();
      unlistenHistory?.();
      unlistenModels?.();
      unlistenAccount?.();
      unlistenDragEnter?.();
      unlistenDragOver?.();
      unlistenDragLeave?.();
      unlistenDragDrop?.();
      unlistenOpenImport?.();
      unlistenLicenseReturn?.();
    };
  }, []);

  useClickOutside(
    supportMenuRef,
    () => setShowSupportPopup(false),
    showSupportPopup,
  );

  useEffect(() => {
    if (!showSupportPopup) {
      resetEmailCopied();
    }
  }, [showSupportPopup, resetEmailCopied]);

  const copySupportEmail = () => copyEmail(SUPPORT_EMAIL);

  useEffect(() => {
    const handleCopy = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!((event.metaKey || event.ctrlKey) && key === "c")) return;

      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      ) {
        return;
      }

      const selection = window.getSelection();
      const text = selection?.toString() ?? "";
      if (!text.trim()) return;

      event.preventDefault();
      navigator.clipboard.writeText(text).catch((err) => {
        console.error("Failed to copy selection:", err);
      });
    };

    document.addEventListener("keydown", handleCopy);
    return () => document.removeEventListener("keydown", handleCopy);
  }, []);

  const showCleanupButtons = llmEnabled && licenseGateActive;
  const currentModeLabel = t({
    id: "home.mode.local",
    message: "Local",
  });

  const lockedHint = t({
    id: "home.sidebar.locked_hint",
    message: "Needs a Glimpse license. Opens Account.",
  });

  const homeViewActive = activeView === "home" && !isSettingsOpen;
  const returnIcon = {
    home: HomeIcon,
    dictionary: Book,
    brain: Brain,
    library: Library,
  }[activeView];
  useTimeOfDayPeriodTick(homeViewActive);
  const {
    data: todayStats = EMPTY_TODAY_DICTATION_STATS,
    isFetched: todayStatsFetched,
  } = useTodayDictationStats(homeViewActive);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-transparent font-sans ui-color-on-solid select-none">
      <WindowControls />
      <aside
        data-app-sidebar
        style={
          {
            width: sidebarWidth,
            "--sidebar-icon-pl": `${sidebarIconPl}px`,
          } as React.CSSProperties
        }
        className="relative z-30 flex flex-col border-r border-border-primary bg-[var(--color-bg-primary)]/85 backdrop-blur-2xl shrink-0 transition-[width] duration-200 ease-out will-change-[width]"
      >
        <div data-tauri-drag-region className="h-8 w-full shrink-0" />

        <div className="px-2 pb-6 pt-1">
          <div
            className={`flex items-center h-6 pl-[var(--sidebar-icon-pl,17px)] pr-3 ${isSidebarCollapsed ? "gap-0" : "gap-3"}`}
          >
            <div className="flex w-[20px] shrink-0 items-center justify-center">
              <StaticGlimpseLogo
                cloudActive={remoteSpeechEnabled || llmEnabled}
                localActive={!remoteSpeechEnabled}
              />
            </div>
            <span
              style={{
                width: isSidebarCollapsed ? 0 : "auto",
                opacity: isSidebarCollapsed ? 0 : 1,
              }}
              className="font-satoshi ui-text-nav-brand ui-color-primary whitespace-nowrap overflow-hidden transition-[width,opacity] duration-200 ease-out"
            >
              Glimpse
            </span>
          </div>
        </div>

        <nav className="flex-1 flex flex-col px-2">
          <div
            key={isSettingsOpen ? "settings-nav" : "app-nav"}
            className="nav-swap space-y-1"
          >
            {isSettingsOpen ? (
              SETTINGS_PANE_GROUPS.map((group, groupIndex) => {
                const panes = group.panes;
                if (panes.length === 0) return null;
                return (
                  <div key={groupIndex} className="space-y-1">
                    {groupIndex > 0 && (
                      <div className="flex h-5 items-center pr-3 pl-[var(--sidebar-icon-pl,17px)]">
                        {isSidebarCollapsed || !group.caption ? (
                          <div className="flex w-[20px] shrink-0 justify-center">
                            <div className="h-px w-3.5 bg-[var(--border-strong)]" />
                          </div>
                        ) : (
                          <span className="ui-text-uppercase-meta ui-color-disabled font-semibold whitespace-nowrap">
                            {i18n._(group.caption)}
                          </span>
                        )}
                      </div>
                    )}
                    {panes.map((paneDef) => {
                      const locked =
                        paneDef.licensed === true && !activeLicense;
                      return (
                        <SidebarItem
                          key={paneDef.id}
                          icon={paneDef.icon}
                          label={i18n._(paneDef.label)}
                          active={settingsTab === paneDef.id}
                          collapsed={isSidebarCollapsed}
                          locked={locked}
                          lockedHint={lockedHint}
                          onClick={() =>
                            locked
                              ? openAccountSettings("sidebar_lock")
                              : setSettingsTab(paneDef.id)
                          }
                        />
                      );
                    })}
                  </div>
                );
              })
            ) : (
              <>
                <SidebarItem
                  icon={HomeIcon}
                  label={t({
                    id: "home.sidebar.home",
                    message: "Home",
                  })}
                  active={activeView === "home"}
                  collapsed={isSidebarCollapsed}
                  onClick={() => setActiveView("home")}
                />
                <SidebarItem
                  icon={Book}
                  label={t({
                    id: "home.sidebar.dictionary",
                    message: "Dictionary",
                  })}
                  active={activeView === "dictionary"}
                  collapsed={isSidebarCollapsed}
                  onClick={() => setActiveView("dictionary")}
                />
                <SidebarItem
                  icon={Brain}
                  label={t({
                    id: "home.sidebar.personalization",
                    message: "Personalization",
                  })}
                  active={activeView === "brain"}
                  collapsed={isSidebarCollapsed}
                  locked={!licenseGateActive}
                  lockedHint={lockedHint}
                  onClick={() =>
                    licenseGateActive
                      ? setActiveView("brain")
                      : openAccountSettings("sidebar_lock")
                  }
                />
                <SidebarItem
                  icon={Library}
                  label={t({
                    id: "home.sidebar.library",
                    message: "Library",
                  })}
                  active={activeView === "library"}
                  collapsed={isSidebarCollapsed}
                  locked={!licenseGateActive}
                  lockedHint={lockedHint}
                  onClick={() =>
                    licenseGateActive
                      ? setActiveView("library")
                      : openAccountSettings("sidebar_lock")
                  }
                />
              </>
            )}
          </div>
          <div className="flex-1" />
        </nav>

        <div className="shrink-0">
          {localApiStatus?.running ? (
            <div className="px-2 pb-1.5">
              <LocalApiSidebarStatus
                collapsed={isSidebarCollapsed}
                status={localApiStatus}
                onOpenSettings={openLocalApiSettings}
              />
            </div>
          ) : null}

          <div className="space-y-1 border-t border-border-primary p-2">
            <button
              onClick={toggleSidebarCollapsed}
              className={`ui-nav-item group h-9 pl-[var(--sidebar-icon-pl,17px)] pr-3 mb-[2px] ${
                isSidebarCollapsed ? "gap-0" : "gap-3"
              }`}
              aria-label={
                isSidebarCollapsed
                  ? t({
                      id: "home.sidebar.expand",
                      message: "Expand sidebar",
                    })
                  : t({
                      id: "home.sidebar.collapse",
                      message: "Collapse sidebar",
                    })
              }
            >
              <div className="flex w-[20px] shrink-0 items-center justify-center">
                <motion.div
                  animate={{ rotate: isSidebarCollapsed ? 180 : 0 }}
                  transition={{ type: "tween", duration: 0.2 }}
                >
                  <ChevronLeft size={18} />
                </motion.div>
              </div>
              <span
                style={{
                  width: isSidebarCollapsed ? 0 : "auto",
                  opacity: isSidebarCollapsed ? 0 : 1,
                }}
                className="ui-text-nav-item whitespace-nowrap overflow-hidden transition-[width,opacity] duration-200 ease-out"
              >
                {t({ id: "home.sidebar.collapse_label", message: "Collapse" })}
              </span>
            </button>

            <div className="relative" ref={supportMenuRef}>
              <button
                onClick={() => setShowSupportPopup(!showSupportPopup)}
                data-active={showSupportPopup ? "true" : "false"}
                className={`ui-nav-item group h-9 pl-[var(--sidebar-icon-pl,17px)] pr-3 mb-[2px] ${
                  isSidebarCollapsed ? "gap-0" : "gap-3"
                }`}
                aria-expanded={showSupportPopup}
                aria-haspopup="menu"
                aria-label={t({
                  id: "home.support.menu_aria",
                  message: "Support menu",
                })}
              >
                <div className="flex items-center justify-center w-[20px] shrink-0 group-hover:text-content-secondary">
                  <Info size={20} weight="regular" />
                </div>
                <span
                  style={{
                    width: isSidebarCollapsed ? 0 : "auto",
                    opacity: isSidebarCollapsed ? 0 : 1,
                  }}
                  className="ui-text-nav-item whitespace-nowrap overflow-hidden transition-[width,opacity] duration-200 ease-out"
                >
                  {t({
                    id: "home.support.label",
                    message: "Support",
                  })}
                </span>
              </button>

              <AnimatePresence>
                {showSupportPopup && (
                  <motion.div
                    initial={{ opacity: 0, y: 8, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.95 }}
                    transition={{ duration: 0.15, ease: "easeOut" }}
                    className="ui-surface-menu absolute bottom-full left-2 mb-2 w-56 z-[60]"
                  >
                    <div className="px-3 pt-3 pb-1">
                      <div className="flex items-center justify-between">
                        <span className="ui-text-body-sm-strong ui-color-primary">
                          {t({
                            id: "home.support.title",
                            message: "Get Support",
                          })}
                        </span>
                        <button
                          onClick={() => setShowSupportPopup(false)}
                          className="p-1 rounded-md hover:bg-surface-elevated text-content-muted hover:text-content-secondary transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="px-2 pb-2 space-y-1">
                      <button
                        onClick={() => {
                          setShowSupportPopup(false);
                          setShowFAQ(true);
                        }}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-elevated transition-colors group w-full text-left"
                      >
                        <HelpCircle
                          size={16}
                          style={{ color: "var(--color-support-help)" }}
                        />
                        <div>
                          <div className="ui-text-body-sm-strong ui-color-primary">
                            {t({
                              id: "home.support.faq.title",
                              message: "FAQ",
                            })}
                          </div>
                          <div className="ui-text-meta ui-color-muted">
                            {t({
                              id: "home.support.faq.subtitle",
                              message: "Common questions",
                            })}
                          </div>
                        </div>
                      </button>
                      <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-elevated transition-colors w-full">
                        <Bug
                          size={16}
                          className="ui-color-secondary shrink-0"
                        />
                        <div className="min-w-0">
                          <div className="ui-text-body-sm-strong ui-color-primary">
                            {t({
                              id: "home.support.feedback.title",
                              message: "Feedback",
                            })}
                          </div>
                          <div className="ui-text-meta ui-color-muted flex items-center flex-nowrap gap-x-1.5">
                            <a
                              href={SUPPORT_GITHUB_URL}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() => setShowSupportPopup(false)}
                              className="inline-flex items-center gap-0.5 underline underline-offset-2 decoration-border-hover hover:text-content-secondary transition-colors"
                            >
                              <Bug size={10} aria-hidden="true" />
                              {t({
                                id: "home.support.feedback.github",
                                message: "GitHub Issue",
                              })}
                            </a>
                            <span aria-hidden="true">·</span>
                            <button
                              type="button"
                              onClick={() => {
                                void copySupportEmail();
                              }}
                              className="inline-flex items-center gap-0.5 underline underline-offset-2 decoration-border-hover hover:text-content-secondary transition-colors"
                            >
                              {supportEmailCopied ? (
                                <Check size={10} aria-hidden="true" />
                              ) : (
                                <Copy size={10} aria-hidden="true" />
                              )}
                              {supportEmailCopied
                                ? t({
                                    id: "home.support.feedback.email_copied",
                                    message: "Copied!",
                                  })
                                : t({
                                    id: "home.support.feedback.email",
                                    message: "Email",
                                  })}
                            </button>
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setShowSupportPopup(false);
                          setSettingsTab("about");
                          setIsSettingsOpen(true);
                        }}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-elevated transition-colors group w-full text-left"
                      >
                        <Info
                          size={16}
                          style={{ color: "var(--color-support-info)" }}
                        />
                        <div>
                          <div className="ui-text-body-sm-strong ui-color-primary">
                            {t({
                              id: "home.support.about.title",
                              message: "About",
                            })}
                          </div>
                          <div className="ui-text-meta ui-color-muted">
                            {t({
                              id: "home.support.about.version_mode",
                              message: `v${{ version: appVersion }} • ${{ mode: currentModeLabel }}`,
                            })}
                          </div>
                        </div>
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {updateAvailable && (
              <button
                onClick={() => {
                  setSettingsTab("about");
                  setIsSettingsOpen(true);
                }}
                className={`ui-nav-item group h-9 pl-[var(--sidebar-icon-pl,17px)] pr-3 mb-[2px] ${isSidebarCollapsed ? "gap-0" : "gap-3"}`}
                style={{ color: "var(--color-accent)" }}
              >
                <div className="flex items-center justify-center w-[20px] shrink-0">
                  <ArrowUpCircle size={20} weight="regular" />
                </div>
                <span
                  style={{
                    width: isSidebarCollapsed ? 0 : "auto",
                    opacity: isSidebarCollapsed ? 0 : 1,
                  }}
                  className="ui-text-nav-item whitespace-nowrap overflow-hidden transition-[width,opacity] duration-200 ease-out"
                >
                  {t({
                    id: "home.update_available",
                    message: "Update available",
                  })}
                </span>
              </button>
            )}

            <SettingsNavToggle
              open={isSettingsOpen}
              collapsed={isSidebarCollapsed}
              openLabel={t({
                id: "home.sidebar.settings",
                message: "Settings",
              })}
              returnIcon={returnIcon}
              closeLabel={t({
                id: "home.sidebar.back",
                message: "Back",
              })}
              onClick={() =>
                isSettingsOpen ? closeSettings() : setIsSettingsOpen(true)
              }
            />
          </div>
        </div>
      </aside>

      <main className="flex flex-1 flex-col min-w-0 bg-surface-tertiary overflow-hidden relative will-change-contents">
        <div data-tauri-drag-region className="h-8 w-full shrink-0" />

        {homeViewActive && (
          <div className="absolute right-6 top-10 z-40 flex items-center gap-2">
            <AccountPill onClick={() => openAccountSettings("home_pill")} />
            <NewsMenu />
          </div>
        )}

        {settingsMounted && (
          <div
            className={`flex flex-1 flex-col min-h-0 ${
              isSettingsOpen ? "view-enter" : "hidden"
            }`}
          >
            <Suspense fallback={null}>
              <SettingsScreen
                active={isSettingsOpen}
                pane={settingsTab}
                onPaneChange={setSettingsTab}
                onClose={closeSettings}
                accountSource={accountSource}
                transcriptionMode={transcriptionMode}
              />
            </Suspense>
          </div>
        )}

        <div
          className={`flex-1 flex flex-col px-8 min-h-0 ${
            isSettingsOpen ? "hidden" : activeView === "home" ? "pb-3" : "pb-6"
          }`}
        >
          <div
            className={`w-full max-w-[680px] mx-auto pt-5 flex-1 flex flex-col min-h-0 ${activeView === "home" ? "" : "hidden"}`}
          >
            <HomeTodayHeader
              transcriptionsFetched={todayStatsFetched}
              stats={todayStats}
              active={homeViewActive}
            />

            <TranscriptionList
              showLlmButtons={showCleanupButtons}
              isActive={homeViewActive}
            />
          </div>

          <div
            className={`w-full max-w-6xl mx-auto min-w-0 pt-8 ${activeView === "dictionary" ? "" : "hidden"}`}
          >
            <DictionaryView isActive={activeView === "dictionary"} />
          </div>

          <div
            className={`w-full max-w-5xl mx-auto pt-8 min-h-0 flex-1 ${activeView === "brain" ? "flex flex-col" : "hidden"}`}
          >
            <PersonalizationView
              isActive={activeView === "brain" && licenseGateActive}
            />
          </div>

          <div
            className={`w-full min-w-0 flex-1 min-h-0 ${activeView === "library" ? "" : "hidden"}`}
          >
            <LibraryView
              pendingImportPaths={pendingImportPaths}
              onSetImportPaths={setPendingImportPaths}
              isActive={activeView === "library" && licenseGateActive}
            />
          </div>
        </div>
      </main>

      <AnimatePresence>
        {dragActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-xs"
          >
            <motion.div
              initial={{ scale: 0.96, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 12 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="flex flex-col items-center justify-center rounded-2xl border border-border-secondary bg-surface-overlay px-8 py-6 shadow-2xl"
            >
              <div className="ui-text-section-label ui-color-muted">
                {t({
                  id: "home.drag_import.eyebrow",
                  message: "Library Import",
                })}
              </div>
              <div className="mt-2 ui-text-title font-medium ui-color-primary">
                {t({
                  id: "home.drag_import.title",
                  message: "Drop files to transcribe",
                })}
              </div>
              <div className="mt-1 ui-text-body-sm ui-color-disabled">
                {t({
                  id: "home.drag_import.subtitle",
                  message: "MP3, WAV, M4A, MP4, MOV, and more",
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <Suspense fallback={null}>
        {faqOpened && (
          <FAQModal isOpen={showFAQ} onClose={() => setShowFAQ(false)} />
        )}
      </Suspense>
    </div>
  );
};

export default Home;
