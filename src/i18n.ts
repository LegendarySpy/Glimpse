import { i18n, type Messages } from "@lingui/core";
import type { AppLocaleSetting } from "./types";
import {
  DEFAULT_APP_LOCALE,
  DEFAULT_LOCALE,
  SUPPORTED_APP_LOCALES,
  matchSupportedAppLocale,
  normalizeSupportedAppLocale,
} from "./shared/lib/appLocales";

// Lazy on purpose: eager loading bundles every catalog into the entry chunk,
// which each window then parses at startup for locales it will never show.
const localeCatalogs = import.meta.glob<Messages>("./locales/*/messages.po", {
  import: "messages",
});

function extractLocaleCode(path: string): string | null {
  const match = path.match(/^\.\/locales\/([^/]+)\/messages\.po$/);
  return match?.[1]?.trim().toLowerCase() || null;
}

export type AppLocale = string;

const catalogLoaders = Object.fromEntries(
  Object.entries(localeCatalogs).flatMap(([path, load]) => {
    const locale = extractLocaleCode(path);
    return locale ? [[locale, load]] : [];
  }),
) as Record<string, () => Promise<Messages>>;

for (const locale of SUPPORTED_APP_LOCALES) {
  if (!catalogLoaders[locale]) {
    throw new Error(`Missing locale catalog for ${locale}`);
  }
}

const loadedCatalogs = new Map<string, Messages>();

async function loadCatalog(locale: string): Promise<Messages> {
  const cached = loadedCatalogs.get(locale);
  if (cached) return cached;
  const messages = await catalogLoaders[locale]();
  loadedCatalogs.set(locale, messages);
  return messages;
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

// Guards against an earlier catalog resolving after a later one and winning.
let activationSeq = 0;

export async function activateLocale(
  localeSetting?: AppLocaleSetting | string | null,
): Promise<AppLocale> {
  const nextLocale = normalizeSupportedAppLocale(
    resolveRequestedLocale(localeSetting),
  );
  const seq = (activationSeq += 1);
  const messages = await loadCatalog(nextLocale);
  if (seq !== activationSeq) return nextLocale;

  i18n.loadAndActivate({ locale: nextLocale, messages });

  if (typeof document !== "undefined") {
    document.documentElement.lang = nextLocale;
    document.documentElement.dir = "ltr";
  }

  return nextLocale;
}

// Keeps the active locale when HMR re-evaluates this module (catalog edits),
// and gives main.tsx a handle to await before the first render.
export const localeReady = activateLocale(i18n.locale || DEFAULT_APP_LOCALE);

export { i18n };
