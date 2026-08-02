import { type QueryClient, useQuery } from "@tanstack/react-query";
import * as personalizationApi from "./api";
import { buildWebsiteIconMap } from "./components/personalization-utils";
import type { Personality } from "../../types";

const APP_CATALOG_STALE_TIME = 10 * 60 * 1000;
// This view is the only writer, and saves are debounced. Without this the
// default refetch on focus reads disk mid save and reverts the edit.
const PERSONALITIES_STALE_TIME = 5 * 60 * 1000;
const WEBSITE_ICON_STALE_TIME = 10 * 60 * 1000;

export const personalizationKeys = {
  all: ["personalization"] as const,
  personalities: () => [...personalizationKeys.all, "personalities"] as const,
  installedApps: () => [...personalizationKeys.all, "installedApps"] as const,
  websiteIcons: (sites: string[]) =>
    [...personalizationKeys.all, "websiteIcons", sites] as const,
};

export function usePersonalities(enabled: boolean = true) {
  return useQuery({
    queryKey: personalizationKeys.personalities(),
    queryFn: personalizationApi.getPersonalities,
    enabled,
    staleTime: PERSONALITIES_STALE_TIME,
  });
}

export function useInstalledApps(enabled: boolean = true) {
  return useQuery({
    queryKey: personalizationKeys.installedApps(),
    queryFn: personalizationApi.listInstalledApps,
    enabled,
    staleTime: APP_CATALOG_STALE_TIME,
  });
}

export function useWebsiteIconMap(sites: string[], enabled: boolean = true) {
  return useQuery({
    queryKey: personalizationKeys.websiteIcons(sites),
    queryFn: () => personalizationApi.listWebsiteIcons(sites),
    enabled: enabled && sites.length > 0,
    select: buildWebsiteIconMap,
    staleTime: WEBSITE_ICON_STALE_TIME,
  });
}

export function setPersonalitiesCache(
  queryClient: QueryClient,
  personalities: Personality[],
) {
  queryClient.setQueryData(personalizationKeys.personalities(), personalities);
}
