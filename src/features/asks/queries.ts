import { useQuery } from "@tanstack/react-query";
import * as asksApi from "./api";

export const askKeys = {
  prompt: () => ["asks", "prompt"] as const,
};

export function useAskPrompt(enabled: boolean) {
  return useQuery({
    queryKey: askKeys.prompt(),
    queryFn: asksApi.getAskPrompt,
    enabled,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
