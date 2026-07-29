import { useQuery } from "@tanstack/react-query";
import * as surveyApi from "./api";

export const surveyKeys = {
  prompt: () => ["survey", "prompt"] as const,
};

export function useSurveyPrompt(enabled: boolean) {
  return useQuery({
    queryKey: surveyKeys.prompt(),
    queryFn: surveyApi.getSurveyPrompt,
    enabled,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
