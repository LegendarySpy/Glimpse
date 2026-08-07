import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as libraryApi from "./api";
import type {
  LibraryFilter,
  LibraryImportOptions,
  LibraryItem,
  LibraryItemPatch,
  LibraryItemStatus,
  LibraryItemsPage,
  LibraryProgressPayload,
  LibraryImportProgressPayload,
  ExportFormat,
} from "../../types";

const PAGE_SIZE = 30;

const LIBRARY_STALE_TIME = 5 * 60 * 1000;

export const libraryKeys = {
  all: ["library"] as const,
  list: (filter: LibraryFilter) =>
    [...libraryKeys.all, "list", filter] as const,
  tags: () => [...libraryKeys.all, "tags"] as const,
};

type LibraryInfiniteData = { pages: LibraryItemsPage[]; pageParams: number[] };

function patchItemInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  filter: LibraryFilter,
  id: string,
  updater: (item: LibraryItem) => LibraryItem,
) {
  queryClient.setQueryData<LibraryInfiniteData>(
    libraryKeys.list(filter),
    (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.map((item) =>
            item.id === id ? updater(item) : item,
          ),
        })),
      };
    },
  );
}

export function useLibraryItems(
  filter: LibraryFilter = {},
  enabled: boolean = true,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    const isProgressable = (status: LibraryItemStatus) =>
      status.type === "pending" ||
      status.type === "importing" ||
      status.type === "transcribing";

    listen<LibraryProgressPayload>(
      "library:transcription_progress",
      (event) => {
        if (cancelled) return;
        const {
          id,
          progress,
          chunk_text,
          chunk_segments,
          current_chunk,
          total_chunks,
        } = event.payload;
        patchItemInCache(queryClient, filter, id, (item) => {
          if (!isProgressable(item.status)) return item;
          let nextTranscript = item.transcript;
          let updateTranscript = false;
          const isReset = current_chunk === 0 && total_chunks === 0;
          if (isReset) {
            nextTranscript = "";
            updateTranscript = true;
          }
          if (chunk_text && chunk_text.trim().length > 0) {
            const base = isReset ? "" : (item.transcript ?? "");
            const separator = base.trim().length > 0 ? " " : "";
            nextTranscript = `${base}${separator}${chunk_text}`;
            updateTranscript = true;
          }
          let nextSegments = item.segments;
          let updateSegments = false;
          if (isReset) {
            nextSegments = [];
            updateSegments = true;
          }
          if (chunk_segments && chunk_segments.length > 0) {
            const base = isReset ? [] : (item.segments ?? []);
            nextSegments = [...base, ...chunk_segments];
            updateSegments = true;
          }
          return {
            ...item,
            status: { type: "transcribing" as const, progress },
            ...(updateTranscript ? { transcript: nextTranscript } : {}),
            ...(updateSegments ? { segments: nextSegments } : {}),
          };
        });
      },
    ).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    listen<{ id: string }>("library:transcription_complete", (event) => {
      if (cancelled) return;
      const id = event.payload?.id;
      if (!id) {
        queryClient.invalidateQueries({ queryKey: libraryKeys.all });
        return;
      }
      patchItemInCache(queryClient, filter, id, (item) => ({
        ...item,
        status: { type: "complete" as const },
      }));
      queryClient.invalidateQueries({ queryKey: libraryKeys.all });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    listen<{ id: string; message: string; cancelled: boolean }>(
      "library:transcription_error",
      (event) => {
        if (cancelled) return;
        const { id, message, cancelled: wasCancelled } = event.payload;
        patchItemInCache(queryClient, filter, id, (item) => ({
          ...item,
          status: wasCancelled
            ? { type: "cancelled" as const }
            : { type: "error" as const, message },
        }));
        queryClient.invalidateQueries({ queryKey: libraryKeys.all });
      },
    ).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    listen<LibraryImportProgressPayload>("library:import_progress", (event) => {
      if (cancelled) return;
      const { id, progress } = event.payload;
      patchItemInCache(queryClient, filter, id, (item) => {
        if (
          item.status.type === "transcribing" ||
          item.status.type === "complete" ||
          item.status.type === "cancelling" ||
          item.status.type === "cancelled"
        ) {
          return item;
        }
        return { ...item, status: { type: "importing" as const, progress } };
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [enabled, queryClient, filter]);

  return useInfiniteQuery({
    queryKey: libraryKeys.list(filter),
    queryFn: ({ pageParam = 0 }) =>
      libraryApi.getLibraryItemsPage(filter, PAGE_SIZE, pageParam),
    enabled,
    gcTime: 60_000,
    staleTime: LIBRARY_STALE_TIME,
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.has_more) return undefined;
      return allPages.reduce((acc, p) => acc + p.items.length, 0);
    },
  });
}

export function useCreateLibraryItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      path,
      options,
    }: {
      path: string;
      options: LibraryImportOptions;
    }) => libraryApi.createLibraryItem(path, options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });
}

export function useUpdateLibraryItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: LibraryItemPatch }) =>
      libraryApi.updateLibraryItem(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });
}

export function useDeleteLibraryItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: libraryApi.deleteLibraryItem,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });
}

export function useCancelLibraryTranscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: libraryApi.cancelLibraryTranscription,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });
}

export function useRetryLibraryTranscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: libraryApi.retryLibraryTranscription,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });
}

export function useExportLibraryItem() {
  return useMutation({
    mutationFn: ({
      id,
      format,
      outputPath,
    }: {
      id: string;
      format: ExportFormat;
      outputPath: string;
    }) => libraryApi.exportLibraryItemToPath(id, format, outputPath),
  });
}

export function useLibraryTags(enabled: boolean = true) {
  return useQuery({
    queryKey: libraryKeys.tags(),
    queryFn: libraryApi.getLibraryTags,
    enabled,
    gcTime: 60_000,
  });
}
