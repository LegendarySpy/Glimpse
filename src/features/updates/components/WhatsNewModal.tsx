import { useLingui } from "@lingui/react/macro";
import {
  useState,
  useEffect,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  ArrowSquareOut as ExternalLink,
  CircleNotch as Loader2,
  WarningCircle as AlertCircle,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkGithub from "remark-github";
import remarkBreaks from "remark-breaks";

interface WhatsNewModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ReleaseInfo {
  version: string;
  body: string;
  publishedAt: string;
  htmlUrl: string;
}

const GITHUB_REPO = "glimpse-hq/Glimpse";
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`;
const MAX_RELEASES = 15;

const isFeatureRelease = (version: string): boolean => {
  const match = version.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const patch = parseInt(match[3], 10);
  return patch === 0;
};

const isSafeHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const markdownPlugins: {
  remark: Options["remarkPlugins"];
} = {
  remark: [
    remarkGfm,
    [remarkGithub, { repository: GITHUB_REPO, mentionStrong: false }],
    remarkBreaks,
  ],
};

const OrderedListContext = createContext(false);

function MarkdownListItem({ children }: { children?: ReactNode }) {
  const ordered = useContext(OrderedListContext);
  if (ordered) {
    return (
      <li className="pl-1 ui-text-body leading-relaxed ui-color-secondary">
        {children}
      </li>
    );
  }
  return (
    <li className="flex items-start gap-3 ui-text-body leading-relaxed ui-color-secondary">
      <span className="ui-color-warning-strong mt-1 ui-text-meta">●</span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h2 className="ui-text-title-strong ui-color-primary mt-5 mb-2 first:mt-0">
      {children}
    </h2>
  ),
  h2: ({ children }) => (
    <h3 className="ui-text-body-lg-strong ui-color-primary mt-5 mb-2 first:mt-0">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="ui-text-section-label ui-color-muted mt-5 mb-2 first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="ui-text-body leading-relaxed ui-color-secondary mb-3 last:mb-0">
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold ui-color-primary">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && isSafeHttpUrl(href)) {
          openUrl(href).catch((err) => {
            console.error("Failed to open link:", err);
          });
        }
      }}
      className="ui-color-info-strong hover:underline cursor-pointer"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <OrderedListContext.Provider value={false}>
      <ul className="space-y-2.5 mb-4 ml-1 last:mb-0">{children}</ul>
    </OrderedListContext.Provider>
  ),
  ol: ({ children }) => (
    <OrderedListContext.Provider value={true}>
      <ol className="space-y-2.5 mb-4 ml-1 list-decimal list-inside last:mb-0">
        {children}
      </ol>
    </OrderedListContext.Provider>
  ),
  li: MarkdownListItem,
  code: ({ children }) => (
    <code className="px-1 py-0.5 rounded-sm bg-surface-elevated ui-text-body-sm font-mono ui-color-primary">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-md bg-surface-elevated p-3 ui-text-body-sm [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-border-secondary pl-3 ui-color-muted">
      {children}
    </blockquote>
  ),
  hr: () => <div className="border-t border-border-primary my-4" />,
  table: ({ children }) => (
    <div className="mb-4 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse ui-text-body-sm">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border-secondary px-3 py-1.5 text-left font-semibold ui-color-primary">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border-secondary px-3 py-1.5 ui-color-secondary">
      {children}
    </td>
  ),
};

function WhatsNewModal({ isOpen, onClose }: WhatsNewModalProps) {
  const { t } = useLingui();
  const [releases, setReleases] = useState<ReleaseInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && releases.length === 0) {
      fetchReleases();
    }
  }, [isOpen]);

  const fetchReleases = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `${GITHUB_API_URL}?per_page=${MAX_RELEASES}`,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Glimpse-App",
          },
        },
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }
      const data = (await response.json()) as Array<{
        tag_name: string;
        body: string;
        published_at: string;
        html_url: string;
        prerelease: boolean;
      }>;

      setReleases(
        data
          .filter((release) => !release.prerelease)
          .map((release) => ({
            version: release.tag_name,
            body:
              release.body ||
              t({
                id: "updates.whats_new.no_changelog",
                message: "No changelog available.",
              }),
            publishedAt: release.published_at,
            htmlUrl: release.html_url,
          })),
      );
    } catch (err) {
      console.error("Failed to fetch releases:", err);
      setError(
        err instanceof Error
          ? err.message
          : t({
              id: "updates.whats_new.load_failed",
              message: "Failed to load changelog",
            }),
      );
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="settings-typescale font-sans fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-labelledby="whats-new-title"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-lg h-[75vh] bg-surface-tertiary rounded-2xl border border-border-secondary shadow-2xl shadow-black/50 overflow-hidden flex flex-col"
          >
            <div className="flex items-center justify-between px-7 pt-6 pb-2 shrink-0">
              <div>
                <h2
                  id="whats-new-title"
                  className="ui-text-display font-normal ui-color-primary tracking-tight"
                >
                  {t({
                    id: "updates.whats_new.title",
                    message: "What's New",
                  })}
                </h2>
                <button
                  onClick={() => {
                    openUrl(
                      "https://github.com/glimpse-hq/Glimpse/releases",
                    ).catch((err) => {
                      console.error("Failed to open releases:", err);
                    });
                  }}
                  className="flex items-center gap-1.5 mt-1 ui-text-meta ui-color-muted hover:ui-color-secondary transition-colors"
                >
                  <span>
                    {t({
                      id: "updates.whats_new.view_all",
                      message: "View all releases on GitHub",
                    })}
                  </span>
                  <ExternalLink size={11} />
                </button>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-content-muted hover:text-content-primary hover:bg-surface-elevated transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="relative flex-1 min-h-0 overflow-hidden">
              <div
                className="pointer-events-none absolute left-0 right-3 top-0 h-6 z-10"
                style={{
                  background:
                    "linear-gradient(to bottom, var(--color-bg-tertiary), transparent)",
                }}
                aria-hidden="true"
              />
              <div
                className="pointer-events-none absolute left-0 right-3 bottom-0 h-8 z-10"
                style={{
                  background:
                    "linear-gradient(to top, var(--color-bg-tertiary), transparent)",
                }}
                aria-hidden="true"
              />
              <div className="h-full overflow-y-auto settings-scroll px-7 pt-5 pb-7">
                {(loading || releases.length === 0) && !error && (
                  <div className="flex items-center justify-center py-12">
                    <Loader2
                      size={20}
                      className="animate-spin text-content-muted"
                    />
                  </div>
                )}

                {error && (
                  <div className="flex flex-col items-center gap-3 py-8">
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 w-full">
                      <AlertCircle
                        size={14}
                        className="ui-color-error-strong shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="ui-text-body ui-color-error-strong font-medium">
                          {t({
                            id: "updates.whats_new.couldnt_load",
                            message: "Couldn't load releases",
                          })}
                        </p>
                        <p className="ui-text-label ui-color-error-subtle mt-0.5">
                          {t({
                            id: "updates.whats_new.github_unavailable",
                            message:
                              "GitHub may be temporarily unavailable. Check your connection and try again.",
                          })}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={fetchReleases}
                      className="ui-text-body-sm-strong ui-color-secondary hover:text-content-primary transition-colors"
                    >
                      {t({
                        id: "updates.whats_new.retry",
                        message: "Retry",
                      })}
                    </button>
                  </div>
                )}

                {!loading && !error && releases.length > 0 && (
                  <div className="space-y-8">
                    {releases.map((release: ReleaseInfo, index: number) => {
                      const isFeatured = isFeatureRelease(release.version);
                      return (
                        <div key={release.version || `release-${index}`}>
                          <div className="flex items-baseline gap-3 mb-1">
                            <h3
                              className={`font-semibold tracking-tight ${isFeatured ? "ui-text-title ui-color-warning-strong" : "ui-text-body-lg-strong ui-color-primary"}`}
                            >
                              {release.version}
                            </h3>
                            {isFeatured && (
                              <span className="ui-text-meta font-medium ui-color-warning">
                                {t({
                                  id: "updates.whats_new.major_release",
                                  message: "Major Release",
                                })}
                              </span>
                            )}
                          </div>
                          <span className="ui-text-meta ui-color-disabled">
                            {formatDate(release.publishedAt)}
                          </span>
                          <div className="mt-3">
                            <ReactMarkdown
                              remarkPlugins={markdownPlugins.remark}
                              components={markdownComponents}
                            >
                              {release.body}
                            </ReactMarkdown>
                          </div>
                          {index < releases.length - 1 && (
                            <div className="border-t border-border-primary mt-6" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export default WhatsNewModal;
