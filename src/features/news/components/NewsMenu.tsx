import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, ArrowUpRight } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useClickOutside } from "../../../shared/hooks/useClickOutside";
import { getLastSeenId, setLastSeenId } from "../api";
import { useNewsFeed } from "../queries";

const BLOG_URL = "https://tryglimpse.cc/blog";
const MAX_COMPACT = 4;

const NewsMenu = () => {
  const { t } = useLingui();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: items = [], isLoading } = useNewsFeed();
  const [lastSeen, setLastSeen] = useState<string | null>(() => getLastSeenId());

  const markSeen = useCallback((id: string) => {
    setLastSeenId(id);
    setLastSeen(id);
  }, []);

  useEffect(() => {
    if (lastSeen === null && items.length > 0) markSeen(items[0].id);
  }, [lastSeen, items, markSeen]);

  useEffect(() => {
    if (items[0]?.image) new Image().src = items[0].image;
  }, [items]);

  const seenIndex = items.findIndex((item) => item.id === lastSeen);
  let unreadCount = 0;
  if (lastSeen !== null) {
    unreadCount = seenIndex === -1 ? items.length : seenIndex;
  }

  const close = useCallback(() => setIsOpen(false), []);
  useClickOutside(containerRef, close, isOpen);

  const toggle = () => {
    if (!isOpen && items.length > 0) markSeen(items[0].id);
    setIsOpen((open) => !open);
  };

  const openLink = (url: string) => {
    close();
    void openUrl(url);
  };

  const title = t({ id: "news.title", message: "News from Glimpse" });
  const [lead, ...rest] = items;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-label={title}
        className="ui-button-ghost relative flex h-9 w-9 items-center justify-center rounded-lg text-content-muted hover:text-content-primary transition-colors"
      >
        <Bell size={20} weight="regular" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: "var(--color-accent)" }}
          />
        )}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="ui-surface-menu absolute right-0 top-full mt-1.5 w-[300px] z-[60]"
          >
            <div className="px-3.5 pt-2.5 pb-2">
              <span className="ui-text-body-sm ui-color-muted">{title}</span>
            </div>

            {items.length === 0 ? (
              <div className="px-3.5 pb-5 ui-text-meta ui-color-muted">
                {isLoading
                  ? t({ id: "news.loading", message: "Checking for news…" })
                  : t({ id: "news.empty", message: "Nothing new right now." })}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => openLink(lead.url)}
                  className="block w-full text-left border-t border-border-primary transition-colors hover:bg-[var(--surface-interactive)]"
                >
                  {lead.image && (
                    <img
                      src={lead.image}
                      alt=""
                      decoding="async"
                      className="w-full aspect-[3/1] object-cover"
                    />
                  )}
                  <div className="px-3.5 pt-2.5 pb-3">
                    <div className="ui-text-meta ui-color-muted mb-0.5">
                      {[lead.tag, lead.date].filter(Boolean).join(" · ")}
                    </div>
                    <div className="ui-text-body-sm-strong ui-color-primary mb-0.5">
                      {lead.title}
                    </div>
                    {lead.description && (
                      <div className="ui-text-meta ui-color-muted line-clamp-2">
                        {lead.description}
                      </div>
                    )}
                  </div>
                </button>

                {rest.slice(0, MAX_COMPACT).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => openLink(item.url)}
                    className="flex w-full items-baseline gap-2 px-3.5 py-2.5 text-left border-t border-border-primary transition-colors hover:bg-[var(--surface-interactive)]"
                  >
                    <span className="ui-text-body-sm ui-color-secondary min-w-0 flex-1 truncate">
                      {item.title}
                    </span>
                    <span className="ui-text-meta ui-color-muted shrink-0">
                      {item.date}
                    </span>
                  </button>
                ))}

                <button
                  type="button"
                  onClick={() => openLink(BLOG_URL)}
                  className="flex w-full items-center gap-1 px-3.5 py-2.5 border-t border-border-primary ui-text-meta ui-color-muted transition-colors hover:bg-[var(--surface-interactive)] hover:text-content-secondary"
                >
                  {t({ id: "news.all_posts", message: "All posts" })}
                  <ArrowUpRight size={11} aria-hidden="true" />
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default NewsMenu;
