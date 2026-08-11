import type { LicenseEdition, LicenseState } from "../types/license";

export type { LicenseEdition, LicenseState };

export const EDITION_COLORS: Record<
  LicenseEdition,
  { fg: string; bg: string }
> = {
  personal: { fg: "#8b5cf6", bg: "rgba(139, 92, 246, 0.12)" },
  commercial: { fg: "#b45309", bg: "rgba(180, 83, 9, 0.10)" },
  founder: { fg: "#0d9488", bg: "rgba(13, 148, 136, 0.12)" },
  contributor: { fg: "#1d4ed8", bg: "rgba(29, 78, 216, 0.10)" },
};

export function editionFromLicenseState(
  licenseState: LicenseState | null,
  active: boolean,
): LicenseEdition {
  if (!active) return "personal";
  return licenseState?.edition ?? "personal";
}
