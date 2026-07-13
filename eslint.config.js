import js from "@eslint/js";
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

export default tseslint.config(
  {
    ignores: ["dist/**", "src-tauri/**", "node_modules/**", "*.config.*"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      boundaries,
    },
    settings: {
      "boundaries/elements": [
        { type: "app", pattern: "src/app/**" },
        { type: "feature", pattern: "src/features/*" },
        { type: "shared", pattern: "src/shared/**" },
        { type: "legacy", pattern: "src/**", partialMatch: false },
      ],
      "boundaries/ignore": ["**/*.test.*", "**/*.spec.*"],
    },
    rules: {
      // Feature isolation: features cannot import from other features
      "boundaries/dependencies": [
        "warn",
        {
          default: "disallow",
          policies: [
            {
              from: { element: { type: "app" } },
              allow: [
                {
                  to: {
                    element: { type: ["app", "feature", "shared", "legacy"] },
                  },
                },
              ],
            },
            {
              from: { element: { type: "feature" } },
              allow: [{ to: { element: { type: ["shared", "legacy"] } } }],
            },
            {
              from: { element: { type: "shared" } },
              allow: [{ to: { element: { type: ["shared", "legacy"] } } }],
            },
            {
              from: { element: { type: "legacy" } },
              allow: [
                {
                  to: {
                    element: { type: ["app", "feature", "shared", "legacy"] },
                  },
                },
              ],
            },
          ],
        },
      ],
      // No direct @tauri-apps imports outside boundary files
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["@tauri-apps/api/*"],
              message:
                "Use feature api.ts or an existing app/shared boundary file instead of adding new direct @tauri-apps imports.",
            },
          ],
        },
      ],
      // Disable rules that conflict with TypeScript or flag pre-existing code
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "no-unused-vars": "off",
      "no-useless-assignment": "off",
    },
  },
  // Override: allow @tauri-apps imports in app/shared boundary files, feature api/query files, and legacy
  {
    files: [
      "src/app/**/*.ts",
      "src/app/**/*.tsx",
      "src/shared/hooks/**/*.ts",
      "src/shared/hooks/**/*.tsx",
      "src/features/*/api.ts",
      "src/features/*/models-api.ts",
      "src/features/*/queries.ts",
      "src/features/*/models-queries.ts",
      "src/features/*/components/**/*.tsx",
      "src/features/*/steps/**/*.tsx",
      "src/features/*/*.ts",
      "src/features/*/*.tsx",
      "src/Home.tsx",
      "src/main.tsx",
      "src/app/App.tsx",
      "src/hooks/**/*.ts",
      "src/lib/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },

  {
    files: [
      "src/features/*/queries.ts",
      "src/features/*/components/**/*.tsx",
      "src/features/settings/useSettingsForm.ts",
      "src/features/onboarding/**",
    ],
    rules: {
      "boundaries/dependencies": [
        "warn",
        {
          default: "disallow",
          policies: [
            {
              from: { element: { type: "feature" } },
              allow: [
                { to: { element: { type: ["feature", "shared", "legacy"] } } },
              ],
            },
          ],
        },
      ],
    },
  },
);
