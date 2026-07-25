import type { AppLocaleSetting } from "../../types/settings";
import supportedAppLocalesJson from "../../../supported-app-locales.json";

// `supported-app-locales.json` is the single source of truth for shipped app
// translations. Add a locale there only after adding `src/locales/<locale>/messages.po`,
// and mirror it in CFBundleLocalizations in src-tauri/Info.plist.
function parseSupportedAppLocales(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("supported-app-locales.json must be a non-empty array");
  }

  const locales = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(
        "supported-app-locales.json must only contain locale strings",
      );
    }

    if (
      entry.length === 0 ||
      entry !== entry.trim() ||
      entry !== entry.toLowerCase()
    ) {
      throw new Error(
        "supported-app-locales.json must use lowercase, trimmed locale codes",
      );
    }

    return entry;
  });

  if (new Set(locales).size !== locales.length) {
    throw new Error(
      "supported-app-locales.json cannot contain duplicate locale codes",
    );
  }

  return locales;
}

export const DEFAULT_LOCALE = "en";
export const DEFAULT_APP_LOCALE: AppLocaleSetting = "system";
export const SUPPORTED_APP_LOCALES = Object.freeze(
  parseSupportedAppLocales(supportedAppLocalesJson),
);

if (!SUPPORTED_APP_LOCALES.includes(DEFAULT_LOCALE)) {
  throw new Error(`supported-app-locales.json must include ${DEFAULT_LOCALE}`);
}

const supportedAppLocaleSet = new Set(SUPPORTED_APP_LOCALES);

function normalizeLocaleCode(locale?: string | null): string | null {
  const trimmed = locale?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/_/g, "-").toLowerCase();
}

export function matchSupportedAppLocale(locale?: string | null): string | null {
  const normalized = normalizeLocaleCode(locale);
  if (!normalized) {
    return null;
  }

  if (supportedAppLocaleSet.has(normalized)) {
    return normalized;
  }

  const baseLocale = normalized.split("-")[0];
  if (baseLocale && supportedAppLocaleSet.has(baseLocale)) {
    return baseLocale;
  }

  return null;
}

export function normalizeSupportedAppLocale(locale?: string | null): string {
  return matchSupportedAppLocale(locale) ?? DEFAULT_LOCALE;
}

function getLocaleAutonym(locale: string): string {
  try {
    const canonicalLocale = Intl.getCanonicalLocales(locale)[0] ?? locale;
    return (
      new Intl.DisplayNames([canonicalLocale], { type: "language" }).of(
        canonicalLocale,
      ) ?? canonicalLocale
    );
  } catch {
    return locale;
  }
}

export function buildAppLocaleOptions(systemLabel: string) {
  const options: Array<{ value: AppLocaleSetting; label: string }> = [
    {
      value: DEFAULT_APP_LOCALE,
      label: systemLabel,
    },
  ];

  options.push(
    ...SUPPORTED_APP_LOCALES.map((locale) => ({
      value: locale,
      label: getLocaleAutonym(locale),
    })),
  );

  return options;
}
