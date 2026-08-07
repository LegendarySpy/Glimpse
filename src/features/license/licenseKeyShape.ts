export function looksLikeDiscountCode(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const hyphens = trimmed.split("-").length - 1;
  return trimmed.length <= 24 && hyphens < 2;
}
