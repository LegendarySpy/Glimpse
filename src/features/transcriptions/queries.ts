import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as transcriptionsApi from "./api";
import type { TranscriptionFilter, TranscriptionPage } from "../../types";

const PAGE_SIZE = 50;

export const transcriptionKeys = {
  all: ["transcriptions"] as const,
  lists: () => [...transcriptionKeys.all, "list"] as const,
  list: (filter: TranscriptionFilter) =>
    [...transcriptionKeys.lists(), filter] as const,
  today: (dayKey: string) =>
    [...transcriptionKeys.all, "today", dayKey] as const,
};

export function useTranscriptionList(
  filter: TranscriptionFilter,
  enabled: boolean = true,
) {
  return useInfiniteQuery({
    queryKey: transcriptionKeys.list(filter),
    queryFn: ({ pageParam = 0 }) =>
      transcriptionsApi.getTranscriptionsPage(filter, PAGE_SIZE, pageParam),
    enabled,
    staleTime: Infinity,
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore
        ? pages.reduce((count, page) => count + page.items.length, 0)
        : undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useTodayDictationStats(enabled: boolean = true) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const dayKey = start.toDateString();

  return useQuery({
    queryKey: transcriptionKeys.today(dayKey),
    queryFn: () =>
      transcriptionsApi.getTodayDictationStats(start.getTime(), end.getTime()),
    enabled,
    staleTime: Infinity,
  });
}

export function useDeleteTranscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: transcriptionsApi.deleteTranscription,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: transcriptionKeys.all });
      const previous = queryClient.getQueriesData<
        InfiniteData<TranscriptionPage, number>
      >({ queryKey: transcriptionKeys.lists() });
      for (const [key] of previous) {
        queryClient.setQueryData<InfiniteData<TranscriptionPage, number>>(
          key,
          (old) =>
            old
              ? {
                  ...old,
                  pages: old.pages.map((page) => ({
                    ...page,
                    items: page.items.filter((record) => record.id !== id),
                  })),
                }
              : old,
        );
      }
      return { previous };
    },
    onError: (_error, _id, context) => {
      context?.previous.forEach(([key, data]) => {
        queryClient.setQueryData(key, data);
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: [...transcriptionKeys.all, "today"],
      });
    },
  });
}

export function useRetryTranscription(enabled: boolean = true) {
  const [retryingIds, setRetryingIds] = useState<string[]>([]);
  const shouldListen = enabled || retryingIds.length > 0;

  useEffect(() => {
    if (!shouldListen) return;

    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    const clearRetrying = () => {
      setRetryingIds((current) => (current.length > 0 ? [] : current));
    };

    listen("transcription:complete", () => {
      if (!cancelled) clearRetrying();
    }).then((fn) => {
      if (cancelled) void Promise.resolve(fn()).catch(() => {});
      else unlisteners.push(fn);
    });

    listen("transcription:error", () => {
      if (!cancelled) clearRetrying();
    }).then((fn) => {
      if (cancelled) void Promise.resolve(fn()).catch(() => {});
      else unlisteners.push(fn);
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => void Promise.resolve(fn()).catch(() => {}));
    };
  }, [shouldListen]);

  const mutation = useMutation({
    mutationFn: transcriptionsApi.retryTranscription,
    onMutate: (id) => {
      setRetryingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    },
    onError: (_error, id) => {
      setRetryingIds((prev) => prev.filter((entry) => entry !== id));
    },
  });

  const cancelRetry = useMutation({
    mutationFn: transcriptionsApi.cancelRetryTranscription,
    onSettled: (_data, _error, id) => {
      setRetryingIds((prev) => prev.filter((entry) => entry !== id));
    },
  });

  return { retry: mutation, cancelRetry, retryingIds };
}

export function useRetryLlmCleanup() {
  return useMutation({
    mutationFn: transcriptionsApi.retryLlmCleanup,
  });
}

export function useUndoLlmCleanup() {
  return useMutation({
    mutationFn: transcriptionsApi.undoLlmCleanup,
  });
}
