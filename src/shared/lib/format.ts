import { i18n } from "../../i18n";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

// Uses the active locale's decimal separator: "1,5 MB" in de, "1.5 MB" in en.
export const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / Math.pow(k, index);
  return `${i18n.number(value, { maximumFractionDigits: 1 })} ${BYTE_UNITS[index]}`;
};
