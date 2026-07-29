import { useLingui } from "@lingui/react/macro";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  CaretDown as ChevronDown,
  ArrowSquareOut as ExternalLink,
  Info,
  PencilSimple as Pencil,
  Plus,
  Trash as Trash2,
  X,
} from "@phosphor-icons/react";
import DotMatrix from "../../../shared/ui/DotMatrix";
import { useClickOutside } from "../../../shared/hooks/useClickOutside";
import { detectAppPlatform } from "../../../platform/service";
import type { Personality } from "../../../types";
import {
  clampInstructionsHeight,
  clampInstructionsText,
  countInstructionsChars,
  DEFAULT_INSTRUCTIONS_HEIGHT,
  getInitials,
  getWebsiteFallback,
  isValidDomain,
  MAX_INSTRUCTIONS_CHARS,
  normalizeEntry,
  normalizeWebsite,
  type InstalledApp,
} from "./personalization-utils";

export type PendingDeletePersonality = {
  id: string;
  name: string;
};

type AppIconBadgeProps = {
  appName: string;
  iconPath?: string | null;
  size?: "chip" | "list" | "option";
};

const useWindowsAppIconSizing = detectAppPlatform() === "windows";

const AppIconBadge = ({
  appName,
  iconPath,
  size = "chip",
}: AppIconBadgeProps) => {
  const iconUrl = iconPath ? convertFileSrc(iconPath) : null;
  const sizeClass = size === "chip" ? "h-7 w-7" : "h-[18px] w-[18px]";
  const textClass =
    size === "chip" ? "ui-text-micro" : "text-[9px] leading-none";
  const baseClass = `${sizeClass} shrink-0 flex items-center justify-center`;

  if (iconUrl) {
    return (
      <span className={`${baseClass} overflow-visible`} aria-hidden="true">
        <img
          src={iconUrl}
          alt=""
          className={
            useWindowsAppIconSizing
              ? "h-full w-full object-contain"
              : "h-full w-full object-contain scale-[1.18]"
          }
          loading="lazy"
        />
      </span>
    );
  }

  return (
    <span
      className={`${baseClass} rounded-md border border-border-secondary bg-surface-overlay ui-color-secondary`}
      aria-hidden="true"
    >
      <span className={`${textClass} font-semibold`}>
        {getInitials(appName)}
      </span>
    </span>
  );
};

type WebsiteFaviconProps = {
  site: string;
  iconPath?: string | null;
  size?: "chip" | "list";
};

const WebsiteFavicon = ({
  site,
  iconPath,
  size = "chip",
}: WebsiteFaviconProps) => {
  const sizeClass = size === "chip" ? "h-3.5 w-3.5" : "h-4 w-4";
  const fallbackTextClass = size === "chip" ? "text-[8px]" : "text-[9px]";
  if (!iconPath) {
    return (
      <span
        className={`${sizeClass} shrink-0 rounded-xs border border-border-secondary bg-surface-overlay flex items-center justify-center ui-color-secondary ${fallbackTextClass}`}
        aria-hidden="true"
      >
        {getWebsiteFallback(site)}
      </span>
    );
  }

  return (
    <img
      src={convertFileSrc(iconPath)}
      alt=""
      className={`${sizeClass} shrink-0 rounded-xs`}
      loading="lazy"
      aria-hidden="true"
    />
  );
};

export { AppIconBadge, WebsiteFavicon };

type PersonalityModalProps = {
  personality: Personality;
  installedApps: InstalledApp[];
  websiteIconBySite: Record<string, string>;
  onClose: () => void;
  onUpdate: (patch: Partial<Personality>) => void;
  onUpdateList: (updater: (current: Personality) => Personality) => void;
  onDelete: () => void;
};

const PERSONALIZATION_SNIPPETS_WIKI_URL =
  "https://github.com/glimpse-hq/Glimpse/wiki/Personalization-Snippets";

const PersonalityModal = ({
  personality,
  installedApps,
  websiteIconBySite,
  onClose,
  onUpdate,
  onUpdateList,
  onDelete,
}: PersonalityModalProps) => {
  const { t } = useLingui();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(personality.name);
  const [appQuery, setAppQuery] = useState("");
  const [isAppMenuOpen, setIsAppMenuOpen] = useState(false);
  const [appHighlightIndex, setAppHighlightIndex] = useState(0);
  const appComboboxRef = useRef<HTMLDivElement>(null);
  const appInputRef = useRef<HTMLInputElement>(null);
  const [websiteInput, setWebsiteInput] = useState("");
  const [websiteError, setWebsiteError] = useState<string | null>(null);
  const [instructionsText, setInstructionsText] = useState("");
  const [instructionsHeight, setInstructionsHeight] = useState(
    DEFAULT_INSTRUCTIONS_HEIGHT,
  );
  const [isResizingInstructions, setIsResizingInstructions] = useState(false);
  const resizeStartYRef = useRef(0);
  const resizeStartHeightRef = useRef(DEFAULT_INSTRUCTIONS_HEIGHT);

  useEffect(() => {
    setNameDraft(personality.name);
    setIsEditingName(false);
    setAppQuery("");
    setIsAppMenuOpen(false);
    setWebsiteInput("");
    setWebsiteError(null);
    setInstructionsText(
      clampInstructionsText(personality.instructions.join("\n")),
    );
    setInstructionsHeight(DEFAULT_INSTRUCTIONS_HEIGHT);
  }, [personality.id]);

  const commitName = () => {
    const value = normalizeEntry(nameDraft);
    if (!value) {
      setNameDraft(personality.name);
      return;
    }
    if (value !== personality.name) {
      onUpdate({ name: value });
    }
  };

  const appOptions = useMemo(() => {
    const seen = new Set<string>();
    return installedApps.filter((app) => {
      const key = app.name.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }, [installedApps]);

  const installedAppByName = useMemo(() => {
    return new Map(appOptions.map((app) => [app.name.toLowerCase(), app]));
  }, [appOptions]);

  const installedNameSet = useMemo(() => {
    return new Set(installedAppByName.keys());
  }, [installedAppByName]);

  const addedAppsSet = useMemo(() => {
    return new Set(personality.apps.map((app) => app.toLowerCase()));
  }, [personality.apps]);

  const filteredAppOptions = useMemo(() => {
    const query = appQuery.trim().toLowerCase();
    return appOptions.filter((app) => {
      if (addedAppsSet.has(app.name.toLowerCase())) {
        return false;
      }
      if (!query) {
        return true;
      }
      return app.name.toLowerCase().includes(query);
    });
  }, [appOptions, addedAppsSet, appQuery]);

  useEffect(() => {
    setAppHighlightIndex(0);
  }, [appQuery, isAppMenuOpen]);

  useClickOutside(appComboboxRef, () => setIsAppMenuOpen(false), isAppMenuOpen);

  const addApp = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onUpdateList((current) => {
      const exists = current.apps.some(
        (app) => app.toLowerCase() === trimmed.toLowerCase(),
      );
      if (exists) {
        return current;
      }
      return { ...current, apps: [...current.apps, trimmed] };
    });
    setAppQuery("");
    setIsAppMenuOpen(false);
  };

  const handleAppInputKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIsAppMenuOpen(true);
      setAppHighlightIndex((index) =>
        filteredAppOptions.length === 0
          ? 0
          : Math.min(index + 1, filteredAppOptions.length - 1),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setAppHighlightIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const highlight = filteredAppOptions[appHighlightIndex];
      if (highlight) {
        addApp(highlight.name);
      } else if (appQuery.trim()) {
        addApp(appQuery);
      }
      return;
    }
    if (event.key === "Escape") {
      if (isAppMenuOpen) {
        event.preventDefault();
        setIsAppMenuOpen(false);
      }
    }
  };

  const removeApp = (name: string) => {
    onUpdateList((current) => ({
      ...current,
      apps: current.apps.filter(
        (app) => app.toLowerCase() !== name.toLowerCase(),
      ),
    }));
  };

  const addWebsite = () => {
    const value = normalizeWebsite(websiteInput);
    if (!value) {
      setWebsiteError(null);
      return;
    }
    if (!isValidDomain(value)) {
      setWebsiteError(
        t({
          id: "personalization.modal.website.invalid",
          message: "Enter a valid domain like gmail.com",
        }),
      );
      return;
    }
    const exists = personality.websites.some(
      (site) => site.toLowerCase() === value.toLowerCase(),
    );
    if (exists) {
      setWebsiteError(
        t({
          id: "personalization.modal.website.duplicate",
          message: "That domain is already added",
        }),
      );
      return;
    }
    setWebsiteError(null);
    onUpdate({ websites: [...personality.websites, value] });
    setWebsiteInput("");
  };

  const removeWebsite = (site: string) => {
    onUpdate({
      websites: personality.websites.filter((entry) => entry !== site),
    });
  };

  const parseInstructions = (value: string) => {
    return value.split(/\r?\n/);
  };

  const handleInstructionsChange = (value: string) => {
    const nextValue = clampInstructionsText(value);
    setInstructionsText(nextValue);
    onUpdate({ instructions: parseInstructions(nextValue) });
  };

  const instructionsCharCount = useMemo(
    () => countInstructionsChars(instructionsText),
    [instructionsText],
  );

  const handleInstructionsResizeStart = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStartYRef.current = event.clientY;
    resizeStartHeightRef.current = instructionsHeight;
    setIsResizingInstructions(true);
  };

  useEffect(() => {
    if (!isResizingInstructions) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const deltaY = event.clientY - resizeStartYRef.current;
      setInstructionsHeight(
        clampInstructionsHeight(resizeStartHeightRef.current + deltaY),
      );
    };

    const handlePointerUp = () => {
      setIsResizingInstructions(false);
    };

    const handlePointerCancel = () => {
      setIsResizingInstructions(false);
    };

    const handleWindowBlur = () => {
      setIsResizingInstructions(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [isResizingInstructions]);

  const handleSaveName = () => {
    commitName();
    setIsEditingName(false);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-xs"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 20 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="relative w-[540px] h-[640px] max-w-[92vw] max-h-[92vh] bg-surface-overlay border border-border-secondary rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-b border-border-primary">
            <div className="flex items-center gap-2.5 min-w-0">
              <DotMatrix
                rows={2}
                cols={3}
                activeDots={[0, 2, 3]}
                dotSize={3}
                gap={3}
                color="var(--color-section-marker-alt)"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <div className="h-[26px] flex items-center">
                  {isEditingName ? (
                    <div className="flex items-center gap-2">
                      <input
                        ref={nameInputRef}
                        value={nameDraft}
                        onChange={(event) => setNameDraft(event.target.value)}
                        autoFocus
                        aria-label={t({
                          id: "personalization.modal.edit_name",
                          message: "Edit mode name",
                        })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            handleSaveName();
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            setNameDraft(personality.name);
                            setIsEditingName(false);
                          }
                        }}
                        onBlur={handleSaveName}
                        className="bg-transparent ui-text-title-lg font-semibold ui-color-primary outline-hidden border-b border-border-hover"
                      />
                      <button
                        onClick={handleSaveName}
                        className="h-[26px] w-[26px] flex items-center justify-center rounded-md hover:bg-surface-elevated text-content-muted hover:text-content-primary transition-colors"
                        aria-label={t({
                          id: "personalization.modal.save_name",
                          message: "Save name",
                        })}
                      >
                        <Check size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <div
                      onClick={() => {
                        if (
                          personality.name ===
                          t({
                            id: "personalization.new_mode.default_name",
                            message: "New Mode",
                          })
                        ) {
                          setNameDraft("");
                        }
                        setIsEditingName(true);
                      }}
                      className="group/title flex items-center gap-2 cursor-pointer"
                    >
                      <h2
                        id="modal-title"
                        className="ui-text-title-lg font-medium ui-color-primary group-hover/title:text-content-secondary transition-colors"
                      >
                        {personality.name}
                      </h2>
                      <Pencil
                        size={11}
                        className="opacity-0 group-hover/title:opacity-100 transition-opacity text-content-muted"
                        aria-hidden="true"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={onDelete}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-content-muted hover:bg-red-500/10 hover:text-red-400 transition-colors"
                title={t({
                  id: "personalization.modal.delete_mode",
                  message: "Delete mode",
                })}
                aria-label={t({
                  id: "personalization.modal.delete_mode",
                  message: "Delete mode",
                })}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
              <button
                onClick={onClose}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-content-muted hover:bg-surface-elevated hover:text-content-secondary transition-colors"
                aria-label={t({
                  id: "personalization.modal.close",
                  message: "Close modal",
                })}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-5 p-5 flex-1 min-h-0 overflow-hidden">
            <section className="shrink-0 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <h3 className="ui-text-section-label-sm ui-color-muted">
                    {t({
                      id: "personalization.modal.custom_instructions",
                      message: "Custom instructions",
                    })}
                  </h3>
                  <div className="group/snippets relative">
                    <button
                      type="button"
                      className="flex h-4 w-4 items-center justify-center rounded-sm text-content-disabled transition-colors hover:text-content-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-hover"
                      aria-label={t({
                        id: "personalization.modal.snippets.info",
                        message: "Show personalization snippet examples",
                      })}
                    >
                      <Info size={11} aria-hidden="true" />
                    </button>
                    <div
                      role="tooltip"
                      className="absolute left-full top-1/2 z-30 hidden -translate-y-[42%] pl-2 group-hover/snippets:block group-focus-within/snippets:block"
                    >
                      <div className="w-72 rounded-lg border border-border-secondary bg-surface-overlay px-3 py-2.5 text-left shadow-lg">
                        <p className="ui-text-meta ui-color-primary">
                          {t({
                            id: "personalization.modal.snippets.summary",
                            message:
                              "Use snippets to pass live context to the language model, like",
                          })}{" "}
                          <code>{"{{date}}"}</code>, <code>{"{{app}}"}</code>,{" "}
                          <code>{"{{window}}"}</code>.
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            void openUrl(PERSONALIZATION_SNIPPETS_WIKI_URL);
                          }}
                          className="mt-2 inline-flex items-center gap-1 ui-text-meta ui-color-muted underline decoration-border-hover underline-offset-2 transition-colors hover:text-content-secondary"
                        >
                          {t({
                            id: "personalization.modal.snippets.full_list",
                            message: "Full snippet list",
                          })}
                          <ExternalLink size={10} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                <span className="ui-text-meta ui-color-disabled tabular-nums">
                  {instructionsCharCount}/{MAX_INSTRUCTIONS_CHARS}
                </span>
              </div>
              <div className="rounded-lg bg-surface-surface px-3 py-2.5">
                <textarea
                  value={instructionsText}
                  onChange={(event) =>
                    handleInstructionsChange(event.target.value)
                  }
                  placeholder={t({
                    id: "personalization.modal.custom_instructions.placeholder",
                    message: "Add custom instructions",
                  })}
                  aria-label={t({
                    id: "personalization.modal.custom_instructions",
                    message: "Custom instructions",
                  })}
                  className="w-full resize-none bg-transparent ui-text-label font-mono ui-color-primary placeholder-content-disabled outline-hidden instructions-scroll"
                  style={{ height: `${instructionsHeight}px` }}
                />
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onPointerDown={handleInstructionsResizeStart}
                    className="h-4 w-4 rounded-sm text-content-disabled hover:text-content-secondary transition-colors cursor-pointer touch-none"
                    aria-label={t({
                      id: "personalization.modal.custom_instructions.resize",
                      message: "Resize custom instructions",
                    })}
                    title={t({
                      id: "personalization.modal.custom_instructions.drag",
                      message: "Drag to resize",
                    })}
                  >
                    <svg
                      viewBox="0 0 20 20"
                      className="h-full w-full"
                      aria-hidden="true"
                    >
                      <path
                        d="M7 13L13 7M9.5 13L13 9.5M12 13L13 12"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </section>

            <div className="grid grid-cols-2 gap-4">
              <section className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="ui-text-section-label-sm ui-color-muted">
                    {t({
                      id: "personalization.modal.applications",
                      message: "Applications",
                    })}
                  </h3>
                  <span className="ui-text-meta ui-color-disabled tabular-nums">
                    {personality.apps.length}
                  </span>
                </div>
                <div className="rounded-lg bg-surface-surface p-2">
                  <div
                    ref={appComboboxRef}
                    className="relative flex items-center gap-1 px-1"
                  >
                    <input
                      ref={appInputRef}
                      value={appQuery}
                      onChange={(event) => {
                        setAppQuery(event.target.value);
                        setIsAppMenuOpen(true);
                      }}
                      onFocus={() => setIsAppMenuOpen(true)}
                      onKeyDown={handleAppInputKeyDown}
                      placeholder={t({
                        id: "personalization.modal.applications.add",
                        message: "Add an application",
                      })}
                      aria-label={t({
                        id: "personalization.modal.applications.add",
                        message: "Add an application",
                      })}
                      role="combobox"
                      aria-expanded={isAppMenuOpen}
                      aria-autocomplete="list"
                      className="min-w-0 flex-1 border-b border-border-secondary bg-transparent px-0.5 py-1 ui-text-body-sm ui-color-primary placeholder-content-disabled focus:outline-none focus:border-content-primary transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setIsAppMenuOpen((open) => !open);
                        appInputRef.current?.focus();
                      }}
                      aria-label={t({
                        id: "personalization.modal.applications.toggle_list",
                        message: "Toggle application list",
                      })}
                      aria-expanded={isAppMenuOpen}
                      className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-content-muted hover:text-content-primary hover:bg-surface-overlay transition-colors"
                    >
                      <ChevronDown
                        size={14}
                        aria-hidden="true"
                        className={`transition-transform ${
                          isAppMenuOpen ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                    <AnimatePresence>
                      {isAppMenuOpen && filteredAppOptions.length > 0 && (
                        <motion.ul
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={{ duration: 0.12 }}
                          role="listbox"
                          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[220px] overflow-y-auto rounded-md border border-border-secondary bg-surface-overlay px-1 py-1 shadow-lg instructions-scroll"
                        >
                          {filteredAppOptions.map((app, index) => (
                            <li key={`app-option-${app.name}`}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={index === appHighlightIndex}
                                onMouseEnter={() => setAppHighlightIndex(index)}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => addApp(app.name)}
                                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ui-text-meta font-medium ui-color-primary ${
                                  index === appHighlightIndex
                                    ? "bg-surface-elevated"
                                    : "hover:bg-surface-elevated/60"
                                }`}
                              >
                                <AppIconBadge
                                  appName={app.name}
                                  iconPath={app.icon_path}
                                  size="option"
                                />
                                <span className="truncate">{app.name}</span>
                              </button>
                            </li>
                          ))}
                        </motion.ul>
                      )}
                    </AnimatePresence>
                  </div>
                  <div className="mt-1 max-h-[240px] overflow-y-auto instructions-scroll">
                    {personality.apps.length === 0 ? (
                      <p className="px-2 py-2 ui-text-meta ui-color-disabled">
                        {t({
                          id: "personalization.modal.applications.none",
                          message: "No applications selected",
                        })}
                      </p>
                    ) : (
                      <ul className="space-y-0.5">
                        {personality.apps.map((app, index) => {
                          const installedApp = installedAppByName.get(
                            app.toLowerCase(),
                          );
                          const isMissing = !installedNameSet.has(
                            app.toLowerCase(),
                          );
                          return (
                            <li
                              key={`app-${index}-${app || "empty"}`}
                              className="group/row flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-surface-overlay transition-colors"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <AppIconBadge
                                  appName={app}
                                  iconPath={installedApp?.icon_path}
                                  size="list"
                                />
                                <span className="ui-text-body-sm ui-color-primary truncate">
                                  {app}
                                </span>
                                {isMissing && (
                                  <span className="ui-text-meta ui-color-disabled shrink-0">
                                    {t({
                                      id: "personalization.modal.applications.not_installed",
                                      message: "Not installed",
                                    })}
                                  </span>
                                )}
                              </div>
                              <button
                                onClick={() => removeApp(app)}
                                className="rounded-md p-1 text-content-disabled opacity-0 group-hover/row:opacity-100 hover:text-content-primary hover:bg-surface-elevated transition-all"
                                title={t({
                                  id: "personalization.modal.remove",
                                  message: "Remove",
                                })}
                                aria-label={t({
                                  id: "personalization.modal.remove_app",
                                  message: `Remove ${app}`,
                                })}
                              >
                                <X size={12} />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              </section>

              <section className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="ui-text-section-label-sm ui-color-muted">
                    {t({
                      id: "personalization.modal.websites",
                      message: "Websites",
                    })}
                  </h3>
                  <span className="ui-text-meta ui-color-disabled tabular-nums">
                    {personality.websites.length}
                  </span>
                </div>
                <div className="rounded-lg bg-surface-surface p-2">
                  <div className="flex items-center gap-1 px-1">
                    <input
                      value={websiteInput}
                      onChange={(event) => {
                        setWebsiteInput(event.target.value);
                        if (websiteError) {
                          setWebsiteError(null);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addWebsite();
                        }
                      }}
                      placeholder={t({
                        id: "personalization.modal.websites.placeholder",
                        message: "Add a site like gmail.com",
                      })}
                      aria-label={t({
                        id: "personalization.modal.websites.aria",
                        message: "Add website domain",
                      })}
                      className="min-w-0 flex-1 border-b border-border-secondary bg-transparent px-0.5 py-1 ui-text-body-sm ui-color-primary placeholder-content-disabled focus:outline-none focus:border-content-primary transition-colors"
                    />
                    <button
                      onClick={addWebsite}
                      aria-label={t({
                        id: "personalization.modal.add",
                        message: "Add",
                      })}
                      className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-content-muted hover:text-content-primary hover:bg-surface-overlay transition-colors"
                    >
                      <Plus size={14} aria-hidden="true" />
                    </button>
                  </div>
                  {websiteError && (
                    <p className="shrink-0 px-2 ui-text-meta ui-color-error">
                      {websiteError}
                    </p>
                  )}
                  <div className="mt-1 max-h-[240px] overflow-y-auto instructions-scroll">
                    {personality.websites.length === 0 ? (
                      <p className="px-2 py-2 ui-text-meta ui-color-disabled">
                        {t({
                          id: "personalization.modal.websites.none",
                          message: "No websites added",
                        })}
                      </p>
                    ) : (
                      <ul className="space-y-0.5">
                        {personality.websites.map((site, index) => (
                          <li
                            key={`site-${index}-${site || "empty"}`}
                            className="group/row flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-surface-overlay transition-colors"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <WebsiteFavicon
                                site={site}
                                iconPath={
                                  websiteIconBySite[normalizeWebsite(site)]
                                }
                                size="list"
                              />
                              <span className="ui-text-label font-mono ui-color-primary truncate">
                                {site}
                              </span>
                            </div>
                            <button
                              onClick={() => removeWebsite(site)}
                              className="rounded-md p-1 text-content-disabled opacity-0 group-hover/row:opacity-100 hover:text-content-primary hover:bg-surface-elevated transition-all"
                              title={t({
                                id: "personalization.modal.remove",
                                message: "Remove",
                              })}
                              aria-label={t({
                                id: "personalization.modal.remove_site",
                                message: `Remove ${site}`,
                              })}
                            >
                              <X size={12} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default PersonalityModal;
