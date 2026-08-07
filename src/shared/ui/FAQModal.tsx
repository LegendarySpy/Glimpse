import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface FAQModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PRIVACY_URL = "https://tryglimpse.cc/privacy";

const openExternal = (url: string) => {
  openUrl(url).catch((err) => {
    console.error("Failed to open URL:", url, err);
  });
};

const FaqLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <button
    type="button"
    onClick={() => openExternal(href)}
    className="ui-color-muted hover:text-content-secondary transition-colors underline"
  >
    {children}
  </button>
);

const FAQModal = ({ isOpen, onClose }: FAQModalProps) => {
  const { t } = useLingui();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showTopFade, setShowTopFade] = useState(false);
  const [showBottomFade, setShowBottomFade] = useState(false);

  const updateScrollFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowTopFade(el.scrollTop > 1);
    setShowBottomFade(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    updateScrollFades();
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateScrollFades);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isOpen, updateScrollFades]);

  const faqItems: Array<{ id: string; question: string; answer: ReactNode }> = [
    {
      id: "how-it-works",
      question: t({
        id: "faq.how_it_works.question",
        message: "How does Glimpse work?",
      }),
      answer: t({
        id: "faq.how_it_works.answer",
        message:
          "Press your dictation shortcut, speak, and release. Glimpse transcribes on your device and inserts the text where your cursor is. Core dictation works offline. No account required.",
      }),
    },
    {
      id: "privacy",
      question: t({
        id: "faq.privacy.question",
        message: "Where does my data go?",
      }),
      answer: (
        <>
          {t({
            id: "faq.privacy.answer",
            message:
              "Your audio and transcripts stay on your Mac. Glimpse does not collect recordings, transcripts, API keys, or prompts. Optional anonymous usage analytics (things like session length and feature usage, never your content) help us improve the app. You can turn this off anytime in Settings → App.",
          })}{" "}
          <FaqLink href={PRIVACY_URL}>
            {t({
              id: "faq.privacy.link",
              message: "Privacy policy",
            })}
          </FaqLink>
        </>
      ),
    },
    {
      id: "ai-writing",
      question: t({
        id: "faq.ai_writing.question",
        message: "When does text leave my device?",
      }),
      answer: t({
        id: "faq.ai_writing.answer.v2",
        message:
          "Only if you set up a writing model under Settings → Providers. Shortcuts with Cleanup turned on, and Personalization, then send the relevant text directly to that provider. Your API key stays stored locally in Glimpse. Audio leaves your device only if you pick a cloud speech model in Settings → Models.",
      }),
    },
    {
      id: "free",
      question: t({
        id: "faq.free.question",
        message: "What is free vs Glimpse Personal?",
      }),
      answer: t({
        id: "faq.free.answer.v2",
        message:
          "Core dictation is free: local transcription, dictionary, replacements, and history. There are no per-minute fees or subscriptions for that. Library, Cleanup, personalization with an LLM, the local API server, and the CLI are part of Glimpse Personal. You get a 14-day trial first; after that, activate a Personal license (a one-time purchase) or a Commercial license (billed yearly) in Settings → Account.",
      }),
    },
    {
      id: "delete",
      question: t({
        id: "faq.delete.question",
        message: "How do I manage or delete my data?",
      }),
      answer: t({
        id: "faq.delete.answer",
        message:
          "Delete recordings from History, remove imported files from Library, or uninstall models from Settings → Models. Settings → App can auto-delete Audio only or full Transcripts (including linked audio). You can also open your Glimpse data folder from About → Storage to manage files directly.",
      }),
    },
    {
      id: "permissions",
      question: t({
        id: "faq.permissions.question",
        message: "What permissions does Glimpse need?",
      }),
      answer: t({
        id: "faq.permissions.answer.v2",
        message:
          "Microphone access to record your voice, and Accessibility access to insert text and to read selected text when a shortcut rewrites it. Glimpse only uses these while you are actively dictating.",
      }),
    },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-labelledby="faq-title"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-lg h-[85vh] bg-surface-tertiary rounded-2xl border border-border-secondary shadow-2xl shadow-black/50 overflow-hidden flex flex-col"
          >
            <div className="flex items-center justify-between px-7 pt-6 pb-4 shrink-0">
              <div>
                <h2
                  id="faq-title"
                  className="ui-text-display font-normal ui-color-primary tracking-tight"
                >
                  {t({
                    id: "faq.title",
                    message: "Frequently Asked Questions",
                  })}
                </h2>
                <p className="ui-text-meta ui-color-muted mt-1">
                  {t({
                    id: "faq.subtitle",
                    message: "How Glimpse works, privacy, and AI writing",
                  })}
                </p>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-content-muted hover:text-content-primary hover:bg-surface-elevated transition-colors"
                aria-label={t({
                  id: "faq.close_aria",
                  message: "Close FAQ",
                })}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="relative flex-1 min-h-0 overflow-hidden">
              <div
                className={`pointer-events-none absolute left-0 right-3 top-0 h-6 z-10 transition-opacity duration-150 ${showTopFade ? "opacity-100" : "opacity-0"}`}
                style={{
                  background:
                    "linear-gradient(to bottom, var(--color-bg-tertiary), transparent)",
                }}
                aria-hidden="true"
              />
              <div
                className={`pointer-events-none absolute left-0 right-3 bottom-0 h-8 z-10 transition-opacity duration-150 ${showBottomFade ? "opacity-100" : "opacity-0"}`}
                style={{
                  background:
                    "linear-gradient(to top, var(--color-bg-tertiary), transparent)",
                }}
                aria-hidden="true"
              />
              <div
                ref={scrollRef}
                onScroll={updateScrollFades}
                className="h-full overflow-y-auto settings-scroll px-7 pb-8"
              >
                <div className="space-y-8">
                  {faqItems.map((item, index) => (
                    <div key={item.id}>
                      <h3 className="ui-text-body-lg-strong ui-color-primary mb-2">
                        {item.question}
                      </h3>
                      <div className="ui-text-body leading-relaxed ui-color-secondary">
                        {item.answer}
                      </div>
                      {index < faqItems.length - 1 && (
                        <div className="border-t border-border-primary mt-6" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default FAQModal;
