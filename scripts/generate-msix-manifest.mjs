import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const RESOURCE_LANGUAGES_PLACEHOLDER = "GLIMPSE_MSIX_RESOURCE_LANGUAGES";
const BCP_47_LOCALE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

function renderMsixManifest(template, locales) {
  if (!Array.isArray(locales) || locales.length === 0) {
    throw new Error("supported-app-locales.json must be a non-empty array");
  }

  const seen = new Set();
  for (const locale of locales) {
    if (
      typeof locale !== "string" ||
      locale !== locale.trim() ||
      locale !== locale.toLowerCase() ||
      !BCP_47_LOCALE.test(locale)
    ) {
      throw new Error(
        "supported-app-locales.json must contain lowercase BCP-47 locale codes",
      );
    }
    if (seen.has(locale)) {
      throw new Error(
        `supported-app-locales.json contains duplicate locale: ${locale}`,
      );
    }
    seen.add(locale);
  }

  const placeholderCount =
    template.split(RESOURCE_LANGUAGES_PLACEHOLDER).length - 1;
  if (placeholderCount !== 1) {
    throw new Error(
      `MSIX manifest template must contain exactly one ${RESOURCE_LANGUAGES_PLACEHOLDER} placeholder`,
    );
  }

  const resources = locales
    .map((locale) => `<Resource Language="${locale}" />`)
    .join("\n    ");
  return template.replace(RESOURCE_LANGUAGES_PLACEHOLDER, resources);
}

const outputPath = process.argv[2];
if (!outputPath || process.argv.length !== 3) {
  throw new Error(
    "Usage: bun scripts/generate-msix-manifest.mjs <output-path>",
  );
}

const workspace = process.cwd();
const template = readFileSync(
  resolve(workspace, "src-tauri/msix/AppxManifest.xml"),
  "utf8",
);
const locales = JSON.parse(
  readFileSync(resolve(workspace, "supported-app-locales.json"), "utf8"),
);
const manifest = renderMsixManifest(template, locales);
writeFileSync(resolve(outputPath), manifest, "utf8");
