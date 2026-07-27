import { useQuery } from "@tanstack/react-query";
import * as newsApi from "./api";

export const newsKeys = {
  feed: () => ["news", "feed"] as const,
};

export function useNewsFeed() {
  return useQuery({
    queryKey: newsKeys.feed(),
    queryFn: newsApi.fetchNews,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
