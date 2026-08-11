import { describe, expect, mock, test } from "bun:test";

mock.module("@tauri-apps/api/core", () => ({
  invoke: mock(async () => []),
}));

const { modelKeys, resolveLocalFallbackModel, resolveSpeechModelLabel } =
  await import("../../src/features/settings/models-queries");

describe("settings model query helpers", () => {
  test("keeps provider credentials out of model query keys", () => {
    const serializedKeys = JSON.stringify([
      modelKeys.all,
      modelKeys.catalog(),
      modelKeys.status("local-model"),
      modelKeys.speech(),
      modelKeys.cli(),
    ]);

    expect(serializedKeys).not.toContain("apiKey");
    expect(serializedKeys).not.toContain("endpoint");
    expect(serializedKeys).not.toContain("llm_api_key");
    expect(serializedKeys).not.toContain("remote_speech_api_key");
    expect("llmModels" in modelKeys).toBe(false);
    expect("remoteSpeechModels" in modelKeys).toBe(false);
  });

  test("resolves speech labels from ids, keys, and static fallbacks", () => {
    const models = [
      { id: "remote:model-a", key: "provider:model-a", label: "Model A" },
      { id: "local:model-b", key: "model-b", label: "Model B" },
    ];

    expect(resolveSpeechModelLabel(models, "remote:model-a")).toBe("Model A");
    expect(resolveSpeechModelLabel(models, "  model-b  ")).toBe("Model B");
    expect(resolveSpeechModelLabel(models, "  ")).toBeNull();
    expect(
      resolveSpeechModelLabel(undefined, "remote:openai:gpt-4o-transcribe"),
    ).toBe("OpenAI · gpt-4o-transcribe");
    expect(resolveSpeechModelLabel(undefined, "unknown-model")).toBe(
      "unknown-model",
    );
  });

  test("prefers an installed local fallback over an uninstalled preference", () => {
    const catalog = [
      {
        key: "whisper_large_v3_turbo",
        label: "Whisper Large V3 Turbo",
        description: "",
        size_mb: 1600,
        engine_id: "whisper",
        family: "whisper-large-v3-turbo",
        variant: "Q5_0",
        category: "standard",
        downloadable: true,
        tags: ["recommended"],
        capabilities: [],
        supported_languages: [],
        ane_size_mb: null,
      },
      {
        key: "distil_whisper_medium",
        label: "Distil Whisper Medium",
        description: "",
        size_mb: 800,
        engine_id: "whisper",
        family: "distil-whisper-medium",
        variant: "Q5_0",
        category: "standard",
        downloadable: true,
        tags: [],
        capabilities: [],
        supported_languages: [],
        ane_size_mb: null,
      },
    ];

    expect(
      resolveLocalFallbackModel(
        catalog,
        {
          whisper_large_v3_turbo: { installed: false },
          distil_whisper_medium: { installed: true },
        },
        "whisper_large_v3_turbo",
      )?.key,
    ).toBe("distil_whisper_medium");
  });

  test("keeps the preferred local model when it is installed", () => {
    const catalog = [
      {
        key: "preferred",
        downloadable: true,
        tags: ["recommended"],
        size_mb: 10,
      },
      { key: "other", downloadable: true, tags: [], size_mb: 5 },
    ];

    expect(
      resolveLocalFallbackModel(
        catalog,
        { preferred: { installed: true }, other: { installed: true } },
        "preferred",
      )?.key,
    ).toBe("preferred");
  });

  test("does not invent an installed fallback when none is available", () => {
    const catalog = [
      {
        key: "preferred",
        downloadable: true,
        tags: [],
        size_mb: 10,
      },
      {
        key: "recommended",
        downloadable: true,
        tags: ["recommended"],
        size_mb: 5,
      },
    ];

    expect(
      resolveLocalFallbackModel(
        catalog,
        { preferred: { installed: false }, recommended: { installed: false } },
        "preferred",
      )?.key,
    ).toBe("preferred");
  });
});
