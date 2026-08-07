import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as asksApi from "../api";
import { askKeys, useAskPrompt } from "../queries";

type AskPromptProps = {
  active: boolean;
};

export default function AskPrompt({ active }: AskPromptProps) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const { data } = useAskPrompt(active);
  const [resolving, setResolving] = useState(false);
  const seenRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    listen("ask:eligible", () => {
      if (!cancelled) {
        void queryClient.invalidateQueries({ queryKey: askKeys.prompt() });
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) =>
        console.error("Failed to subscribe to ask:eligible", err),
      );

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);

  useEffect(() => {
    if (!active || !data?.kind || seenRef.current) return;

    let cancelled = false;
    const window = getCurrentWindow();

    const markIfVisible = async () => {
      if (cancelled || seenRef.current) return;
      if (document.visibilityState !== "visible") return;
      if (!(await window.isVisible().catch(() => false))) return;
      seenRef.current = true;
      void asksApi.markAskPromptSeen().catch(() => {
        seenRef.current = false;
      });
    };

    void markIfVisible();
    const onVisibility = () => void markIfVisible();
    document.addEventListener("visibilitychange", onVisibility);
    const unlistenFocus = window.onFocusChanged(() => void markIfVisible());

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void unlistenFocus.then((fn) => fn());
    };
  }, [active, data?.kind]);

  const resolve = useCallback(
    async (action: asksApi.AskAction) => {
      setResolving(true);
      try {
        await asksApi.resolveAskPrompt(action);
        queryClient.setQueryData(askKeys.prompt(), { kind: null });
      } catch (err) {
        console.error(err);
        setResolving(false);
      }
    },
    [queryClient],
  );

  const askCopy = () => {
    switch (data?.kind) {
      case "review":
        return {
          title: t({
            id: "home.ask.review.title",
            message: "Rate Glimpse in the Microsoft Store?",
          }),
          accept: t({ id: "home.ask.review.answer", message: "Rate" }),
        };
      case "star":
        return {
          title: t({
            id: "home.ask.star.title",
            message: "Star Glimpse on GitHub?",
          }),
          accept: t({ id: "home.ask.star.answer", message: "Open GitHub" }),
        };
      default:
        return {
          title: t({
            id: "home.survey.title",
            message: "Some questions about how you use Glimpse?",
          }),
          accept: t({ id: "home.survey.answer", message: "Answer" }),
        };
    }
  };
  const { title, accept } = askCopy();

  return (
    <AnimatePresence initial={false}>
      {data?.kind && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, height: 0, marginTop: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="mt-2 shrink-0 overflow-hidden ui-text-body-sm ui-color-quiet"
        >
          {title}{" "}
          <button
            type="button"
            disabled={resolving}
            onClick={() => void resolve("answer")}
            className="ui-color-cloud transition-colors hover:text-cloud-hover disabled:opacity-50"
          >
            <span className="underline underline-offset-2">{accept}</span>
            <ArrowUpRight size={11} aria-hidden="true" className="inline" />
          </button>
          <span aria-hidden="true" className="mx-1.5">
            ·
          </span>
          <button
            type="button"
            disabled={resolving}
            onClick={() => void resolve("dismiss")}
            className="underline underline-offset-2 transition-colors hover:text-content-secondary disabled:opacity-50"
          >
            {t({ id: "home.survey.dismiss", message: "No thanks" })}
          </button>
        </motion.p>
      )}
    </AnimatePresence>
  );
}
