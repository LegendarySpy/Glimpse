import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import * as newsApi from "./api";

export const newsKeys = {
  feed: () => ["news", "feed"] as const,
};

export function useNewsFeed() {
  const { i18n } = useLingui();
  const locale = i18n.locale;

  // Localize on read, so switching language doesn't refetch the feed.
  const select = useCallback(
    (items: newsApi.NewsItem[]) => newsApi.localizeNews(items, locale),
    [locale],
  );

  return useQuery({
    queryKey: newsKeys.feed(),
    queryFn: newsApi.fetchNews,
    select,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
