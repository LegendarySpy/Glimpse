import { i18n, type Messages } from "@lingui/core";
import type { AppLocaleSetting } from "./types";
import {
  DEFAULT_APP_LOCALE,
  DEFAULT_LOCALE,
  SUPPORTED_APP_LOCALES,
  matchSupportedAppLocale,
  normalizeSupportedAppLocale,
} from "./shared/lib/appLocales";

const localeCatalogs = import.meta.glob<Messages>("./locales/*/messages.po", {
  eager: true,
  import: "messages",
});

function extractLocaleCode(path: string): string | null {
  const match = path.match(/^\.\/locales\/([^/]+)\/messages\.po$/);
  return match?.[1]?.trim().toLowerCase() || null;
}

export type AppLocale = string;

const catalogs = Object.fromEntries(
  Object.entries(localeCatalogs).flatMap(([path, messages]) => {
    const locale = extractLocaleCode(path);
    return locale ? [[locale, messages]] : [];
  }),
) as Record<string, Messages>;

for (const locale of SUPPORTED_APP_LOCALES) {
  if (!catalogs[locale]) {
    throw new Error(`Missing locale catalog for ${locale}`);
  }
}

function resolveSystemLocale(): string {
  if (typeof navigator === "undefined") {
    return DEFAULT_LOCALE;
  }

  const preferred = navigator.languages?.length
    ? navigator.languages
    : [navigator.language];

  for (const locale of preferred) {
    const match = matchSupportedAppLocale(locale);
    if (match) {
      return match;
    }
  }

  return DEFAULT_LOCALE;
}

function resolveRequestedLocale(
  localeSetting?: AppLocaleSetting | string | null,
): string | null {
  if (!localeSetting || localeSetting === DEFAULT_APP_LOCALE) {
    return resolveSystemLocale();
  }
  return localeSetting;
}

export function activateLocale(
  localeSetting?: AppLocaleSetting | string | null,
): AppLocale {
  const nextLocale = normalizeSupportedAppLocale(
    resolveRequestedLocale(localeSetting),
  );

  i18n.loadAndActivate({
    locale: nextLocale,
    messages: catalogs[nextLocale],
  });

  if (typeof document !== "undefined") {
    document.documentElement.lang = nextLocale;
  }

  return nextLocale;
}

activateLocale(DEFAULT_APP_LOCALE);

export { i18n };
