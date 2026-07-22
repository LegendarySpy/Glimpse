import type { ModelInfo } from "../../types";

export type ModelStats = {
  languagesLabel: string;
  englishOnly: boolean;
};

// The OS provides the model; there is no artifact on disk.
export const isBuiltInModel = (model: { engine_id: string }): boolean =>
  model.engine_id === "apple";

export const formatModelSize = (mb: number): string =>
  mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;

export const sortInstalledModels = (models: ModelInfo[]): ModelInfo[] =>
  [...models].sort((a, b) => {
    const legacyDelta = Number(!a.downloadable) - Number(!b.downloadable);
    if (legacyDelta !== 0) return legacyDelta;
    return a.label.localeCompare(b.label);
  });

export const variantLabel = (variant: string): string => variant;

export const formatQuantLabel = (variant: string): string | null => {
  if (!variant) return null;
  return variantLabel(variant);
};

export const deriveModelStats = (model: ModelInfo): ModelStats => {
  const langCount = model.supported_languages.length;
  const tagSet = model.tags.map((tag) => tag.toLowerCase());
  const englishOnly = tagSet.includes("english")
    ? true
    : tagSet.includes("multilingual")
      ? false
      : langCount <= 1 ||
        model.supported_languages.every((l) =>
          l.code.toLowerCase().startsWith("en"),
        );
  const languagesLabel = englishOnly
    ? "English only"
    : `${langCount} languages`;

  return {
    languagesLabel,
    englishOnly,
  };
};
