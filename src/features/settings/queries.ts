import { useQuery } from "@tanstack/react-query";
import * as settingsApi from "./api";
import type { StoredSettings } from "../../types";

export const settingsKeys = {
  all: ["settings"] as const,
  detail: () => [...settingsKeys.all, "detail"] as const,
  appInfo: () => ["appInfo"] as const,
  devices: () => ["inputDevices"] as const,
};

const SETTINGS_STALE_TIME = 5 * 60 * 1000;

export function useSettings<TSelect = StoredSettings>(
  select?: (data: StoredSettings) => TSelect,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: settingsKeys.detail(),
    queryFn: settingsApi.getSettings,
    select,
    enabled,
    staleTime: SETTINGS_STALE_TIME,
  });
}

export function useAppInfo(enabled: boolean = true) {
  return useQuery({
    queryKey: settingsKeys.appInfo(),
    queryFn: settingsApi.getAppInfo,
    enabled,
    staleTime: Infinity,
  });
}

export function useInputDevices(enabled: boolean = true) {
  return useQuery({
    queryKey: settingsKeys.devices(),
    queryFn: settingsApi.listInputDevices,
    enabled,
    refetchOnMount: "always",
  });
}
