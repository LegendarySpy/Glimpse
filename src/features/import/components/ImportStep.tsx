import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useMemo, useState } from "react";
import { Check, CircleNotch as Loader2 } from "@phosphor-icons/react";
import DotMatrix from "../../../shared/ui/DotMatrix";
import SegmentedControl from "../../../shared/ui/SegmentedControl";
import {
  OnboardingHeader,
  OnboardingStep,
  PRIMARY_BUTTON_CLASS,
  type StepMotionProps,
} from "../../onboarding/steps/shared";
import { settingsKeys } from "../../settings/queries";
import { transcriptionKeys } from "../../transcriptions/queries";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { formatShortcutForDisplay } from "../../../shared/lib/shortcuts";
import { useImportPreview } from "../queries";
import { applyImport } from "../api";
import type {
  DetectedApp,
  ImportResult,
  ImportSelections,
} from "../../../types";

type CategoryKey = keyof ImportSelections;

type Category = {
  key: CategoryKey;
  label: string;
  detail: string;
};

interface ImportStepProps {
  stepMotionProps: StepMotionProps;
  apps: DetectedApp[];
  onApplied: (result: ImportResult) => void;
  onNext: () => void;
}

const ALL_ON: ImportSelections = {
  dictionary: true,
  replacements: true,
  personalities: true,
  shortcut: true,
  language: true,
  autoLaunch: true,
  model: true,
  history: true,
};

const LIST_SLOT_COUNT = 7;
const ROW_CLASS_NAME = "flex items-center gap-3 py-2.5";

export function ImportStep({
  stepMotionProps,
  apps,
  onApplied,
  onNext,
}: ImportStepProps) {
  const { t } = useLingui();
  const queryClient = useQueryClient();

  const [selectedAppId, setSelectedAppId] = useState<string | null>(
    apps[0]?.id ?? null,
  );
  const previewQuery = useImportPreview(selectedAppId);
  const preview = previewQuery.data;
  const previewForApp =
    preview && preview.id === selectedAppId ? preview : undefined;
  const isLoadingPreview =
    previewQuery.isLoading ||
    (previewQuery.isFetching && previewForApp === undefined);

  const [selections, setSelections] = useState<ImportSelections>(ALL_ON);

  useEffect(() => {
    setSelections(ALL_ON);
  }, [selectedAppId]);

  const categories = useMemo<Category[]>(() => {
    if (!previewForApp) return [];
    const rows: Category[] = [];
    if (previewForApp.dictionaryCount > 0) {
      rows.push({
        key: "dictionary",
        label: t({ id: "import.cat.dictionary", message: "Dictionary" }),
        detail: t({
          id: "import.cat.dictionary.detail",
          message: plural(previewForApp.dictionaryCount, {
            one: "# word",
            other: "# words",
          }),
        }),
      });
    }
    if (previewForApp.replacementsCount > 0) {
      rows.push({
        key: "replacements",
        label: t({
          id: "import.cat.replacements",
          message: "Text replacements",
        }),
        detail: t({
          id: "import.cat.replacements.detail",
          message: plural(previewForApp.replacementsCount, {
            one: "# rule",
            other: "# rules",
          }),
        }),
      });
    }
    if (previewForApp.personalitiesCount > 0) {
      rows.push({
        key: "personalities",
        label: t({ id: "import.cat.personalities", message: "Personalities" }),
        detail: t({
          id: "import.cat.personalities.detail",
          message: plural(previewForApp.personalitiesCount, {
            one: "# saved",
            other: "# saved",
          }),
        }),
      });
    }
    if (previewForApp.transcriptCount > 0) {
      rows.push({
        key: "history",
        label: t({ id: "import.cat.history", message: "Transcript history" }),
        detail: t({
          id: "import.cat.history.detail",
          message: plural(previewForApp.transcriptCount, {
            one: "# transcript",
            other: "# transcripts",
          }),
        }),
      });
    }
    if (previewForApp.shortcut) {
      rows.push({
        key: "shortcut",
        label: t({ id: "import.cat.shortcut", message: "Keyboard shortcut" }),
        detail: formatShortcutForDisplay(previewForApp.shortcut),
      });
    }
    if (previewForApp.language) {
      rows.push({
        key: "language",
        label: t({ id: "import.cat.language", message: "Language" }),
        detail: previewForApp.language,
      });
    }
    if (previewForApp.autoLaunch !== null) {
      rows.push({
        key: "autoLaunch",
        label: t({ id: "import.cat.auto_launch", message: "Launch at login" }),
        detail: previewForApp.autoLaunch
          ? t({ id: "import.cat.auto_launch.on", message: "On" })
          : t({ id: "import.cat.auto_launch.off", message: "Off" }),
      });
    }
    if (previewForApp.modelRecognized && previewForApp.modelKey) {
      rows.push({
        key: "model",
        label: t({ id: "import.cat.model", message: "Transcription model" }),
        detail: previewForApp.modelKey,
      });
    }
    return rows;
  }, [previewForApp, t]);

  const applyMutation = useMutation({
    mutationFn: () => applyImport(selectedAppId as string, selections),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      if (result.transcriptsAdded > 0) {
        void queryClient.invalidateQueries({ queryKey: transcriptionKeys.all });
      }
      onApplied(result);
    },
  });

  const toggle = (key: CategoryKey) =>
    setSelections((prev) => ({ ...prev, [key]: !prev[key] }));

  const hasItems = categories.length > 0;
  const selectedCount = categories.filter((c) => selections[c.key]).length;
  const showAppPicker = apps.length > 1;
  const sourceName = apps.find((a) => a.id === selectedAppId)?.name;
  const appOptions = useMemo(
    () => apps.map((app) => ({ value: app.id, label: app.name })),
    [apps],
  );

  const skeletonRows = (
    <div className="divide-y divide-border-primary/40">
      {Array.from({ length: LIST_SLOT_COUNT }).map((_, i) => (
        <div key={i} className={ROW_CLASS_NAME}>
          <div className="h-5 w-5 shrink-0 rounded-full bg-surface-overlay animate-pulse" />
          <div className="h-3 flex-1 max-w-[9rem] rounded bg-surface-overlay animate-pulse" />
        </div>
      ))}
    </div>
  );

  const categoryRows = (
    <div className="divide-y divide-border-primary/40">
      {categories.map((cat) => {
        const checked = selections[cat.key];
        return (
          <button
            key={cat.key}
            type="button"
            onClick={() => toggle(cat.key)}
            className={`group w-full ${ROW_CLASS_NAME}`}
            aria-pressed={checked}
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors ${
                checked
                  ? "bg-content-primary text-surface-secondary"
                  : "border border-border-secondary group-hover:border-border-hover"
              }`}
            >
              <Check
                size={12}
                strokeWidth={3}
                className={checked ? "opacity-100" : "opacity-0"}
              />
            </span>

            <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
              <span
                className={`ui-text-label font-medium transition-colors ${
                  checked ? "text-content-primary" : "text-content-muted"
                }`}
              >
                {cat.label}
              </span>
              <span className="ui-text-meta text-content-muted truncate text-right">
                {cat.detail}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );

  const previewContent = previewQuery.isError ? (
    <p className="py-4 text-center ui-text-label text-content-muted text-balance">
      {t({
        id: "import.error",
        message:
          "We couldn't read this app's data. You can skip and set things up manually.",
      })}
    </p>
  ) : !hasItems ? (
    <p className="py-4 text-center ui-text-label text-content-muted">
      {t({
        id: "import.empty",
        message: "Nothing to bring over from this app.",
      })}
    </p>
  ) : (
    categoryRows
  );

  return (
    <OnboardingStep
      stepKey="import"
      motionProps={stepMotionProps}
      widthClass="max-w-lg"
      footer={
        <>
          <button
            onClick={() => applyMutation.mutate()}
            disabled={
              applyMutation.isPending || !hasItems || selectedCount === 0
            }
            className={PRIMARY_BUTTON_CLASS}
          >
            {applyMutation.isPending ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                {t({ id: "import.importing", message: "Importing..." })}
              </>
            ) : (
              t({ id: "import.cta", message: "Import" })
            )}
          </button>
          <button
            onClick={onNext}
            disabled={applyMutation.isPending}
            className="ui-text-label font-medium text-content-muted hover:text-content-secondary transition-colors disabled:opacity-50"
          >
            {t({ id: "import.skip", message: "Skip for now" })}
          </button>
        </>
      }
    >
      <div className="flex w-full flex-col items-center">
        <OnboardingHeader
          title={t({
            id: "import.title",
            message: "Want to bring your settings over?",
          })}
          subtitle={t({
            id: "import.subtitle",
            message: plural(apps.length, {
              one: "We found another dictation app. Choose what to import.",
              other: "We found other dictation apps. Choose what to import.",
            }),
          })}
        />

        {showAppPicker && selectedAppId && (
          <div className="relative mb-4 flex w-full justify-center">
            <SegmentedControl
              value={selectedAppId}
              options={appOptions}
              onChange={setSelectedAppId}
              ariaLabel={t({
                id: "import.app_picker.aria",
                message: "Select app to import from",
              })}
              activeIndicatorLayoutId="import-app-picker"
              className="inline-flex items-center gap-0.5 rounded-xl border border-border-primary bg-surface-secondary p-1"
              buttonClassName="relative rounded-lg px-4 py-1.5 ui-text-label font-medium normal-case transition-colors duration-200 z-10"
              activeButtonClassName="text-content-primary"
              inactiveButtonClassName="text-content-muted hover:text-content-secondary"
              activeIndicatorClassName="absolute inset-0 rounded-lg border border-border-primary bg-surface-elevated shadow-sm z-[-1]"
            />
          </div>
        )}

        {!showAppPicker && sourceName && (
          <div className="relative mb-4 inline-flex items-center gap-2 rounded-lg border border-border-primary bg-surface-secondary px-3 py-1.5">
            <DotMatrix
              rows={1}
              cols={3}
              activeDots={[0, 2]}
              dotSize={2}
              gap={2}
              color="var(--color-text-muted)"
            />
            <span className="ui-text-label font-medium text-content-secondary">
              {sourceName}
            </span>
          </div>
        )}
      </div>

      <div className="relative w-full text-left">
        <div
          aria-hidden
          className="divide-y divide-border-primary/40 invisible pointer-events-none"
        >
          {Array.from({ length: LIST_SLOT_COUNT }).map((_, i) => (
            <div key={i} className={ROW_CLASS_NAME}>
              <span className="h-5 w-5 shrink-0" />
              <span className="ui-text-label">&nbsp;</span>
            </div>
          ))}
        </div>

        <div className="absolute inset-0">
          <div
            className={`absolute inset-x-0 top-0 transition-opacity duration-200 ease-out ${
              isLoadingPreview ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
            aria-hidden={!isLoadingPreview}
          >
            {skeletonRows}
          </div>

          <div
            className={`absolute inset-x-0 top-0 transition-opacity duration-200 ease-out ${
              isLoadingPreview ? "pointer-events-none opacity-0" : "opacity-100"
            }`}
            aria-hidden={isLoadingPreview}
          >
            {previewContent}
          </div>
        </div>
      </div>

      {previewForApp &&
        previewForApp.modelSource &&
        !previewForApp.modelRecognized && (
          <p className="relative ui-text-meta text-content-muted text-center mt-3 text-balance">
            {t({
              id: "import.model.unrecognized",
              message:
                "We don't recognize this app's model, so you'll pick one on the next step.",
            })}
          </p>
        )}

      {applyMutation.isError && (
        <p className="relative ui-text-meta ui-color-error-strong text-center mt-3">
          {t({
            id: "import.apply.failed",
            message: "Import failed. Try again or skip.",
          })}
        </p>
      )}
    </OnboardingStep>
  );
}
