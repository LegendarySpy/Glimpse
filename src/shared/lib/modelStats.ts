import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../../i18n";
import type { ModelInfo } from "../../types";

export type ModelStats = {
  langCount: number;
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

// Q5_1/Q8_0/Int8 are technical tokens shown as-is; only word variants localize.
const VARIANT_LABELS: Record<string, MessageDescriptor> = {
  Full: msg({ id: "models.variant.full", message: "Full" }),
  System: msg({ id: "models.variant.system", message: "System" }),
};

export const variantLabel = (variant: string): string => {
  const descriptor = VARIANT_LABELS[variant];
  return descriptor ? i18n._(descriptor) : variant;
};

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
  return {
    langCount,
    englishOnly,
  };
};
