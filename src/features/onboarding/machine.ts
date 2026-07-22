import { setup, assign } from "xstate";
import type { DetectedApp, TranscriptionMode } from "../../types";
import {
  getOnboardingPlatform,
  type OnboardingPlatform,
  type OnboardingStep,
} from "./platform";

export type OnboardingModelPriority =
  | "quality"
  | "balanced"
  | "compact"
  | "builtin";

export type OnboardingContext = {
  platform: OnboardingPlatform;
  selectedMode: TranscriptionMode;
  importableApps: DetectedApp[];
  localModelChoice: string;
  modelPriority: OnboardingModelPriority | null;
  autoLaunch: boolean;
  showLocalConfirm: boolean;
  smartShortcut: string;
  completionError: string | null;
  isCompleting: boolean;
  showFAQModal: boolean;
  transitionDirection: 1 | -1;
  hasStepTransitioned: boolean;
};

export type OnboardingEvent =
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "SELECT_MODE"; mode: TranscriptionMode }
  | { type: "SET_IMPORTABLE"; apps: DetectedApp[] }
  | { type: "SELECT_MODEL"; key: string }
  | { type: "SELECT_PRIORITY"; priority: OnboardingModelPriority }
  | { type: "SET_AUTO_LAUNCH"; value: boolean }
  | { type: "SET_SHORTCUT"; shortcut: string }
  | { type: "SHOW_LOCAL_CONFIRM"; show: boolean }
  | { type: "COMPLETING" }
  | { type: "COMPLETE_SUCCESS" }
  | { type: "COMPLETE_ERROR"; error: string }
  | { type: "TOGGLE_FAQ"; show: boolean };

function getSteps(
  platform: OnboardingPlatform = getOnboardingPlatform(),
  hasImport: boolean = false,
): OnboardingStep[] {
  const steps: OnboardingStep[] = [];

  if (hasImport) {
    steps.push("import");
  }

  steps.push("model");

  if (
    platform.requiresMicrophonePermission ||
    platform.requiresAccessibilityPermission
  ) {
    steps.push("permissions");
  }

  return steps;
}

const hasImportStep = ({ context }: { context: OnboardingContext }) =>
  context.selectedMode === "local" && context.importableApps.length > 0;

const requiresPermissionsStep = ({ context }: { context: OnboardingContext }) =>
  context.platform.requiresMicrophonePermission ||
  context.platform.requiresAccessibilityPermission;

export const onboardingMachine = setup({
  types: {
    context: {} as OnboardingContext,
    events: {} as OnboardingEvent,
  },
  actions: {
    forward: assign({
      transitionDirection: 1 as const,
      hasStepTransitioned: true,
      showLocalConfirm: false,
      completionError: null,
    }),
    backward: assign({
      transitionDirection: -1 as const,
      hasStepTransitioned: true,
      showLocalConfirm: false,
      completionError: null,
    }),
  },
}).createMachine({
  id: "onboarding",
  initial: "welcome",
  context: {
    platform: getOnboardingPlatform(),
    selectedMode: "local",
    importableApps: [],
    localModelChoice: "",
    modelPriority: "balanced",
    autoLaunch: false,
    showLocalConfirm: false,
    smartShortcut: "Alt+Space",
    completionError: null,
    isCompleting: false,
    showFAQModal: false,
    transitionDirection: 1,
    hasStepTransitioned: false,
  },
  on: {
    SELECT_MODE: {
      actions: assign({ selectedMode: ({ event }) => event.mode }),
    },
    SET_IMPORTABLE: {
      actions: assign({ importableApps: ({ event }) => event.apps }),
    },
    SELECT_MODEL: {
      actions: assign({ localModelChoice: ({ event }) => event.key }),
    },
    SELECT_PRIORITY: {
      actions: assign({
        modelPriority: ({ event }) => event.priority,
        localModelChoice: "",
      }),
    },
    SET_AUTO_LAUNCH: {
      actions: assign({ autoLaunch: ({ event }) => event.value }),
    },
    SET_SHORTCUT: {
      actions: assign({ smartShortcut: ({ event }) => event.shortcut }),
    },
    SHOW_LOCAL_CONFIRM: {
      actions: assign({ showLocalConfirm: ({ event }) => event.show }),
    },
    COMPLETING: {
      actions: assign({ isCompleting: true, completionError: null }),
    },
    COMPLETE_SUCCESS: {
      actions: assign({ isCompleting: false }),
    },
    COMPLETE_ERROR: {
      actions: assign({
        isCompleting: false,
        completionError: ({ event }) => event.error,
      }),
    },
    TOGGLE_FAQ: {
      actions: assign({ showFAQModal: ({ event }) => event.show }),
    },
  },
  states: {
    welcome: {
      on: {
        NEXT: [
          { target: "import", guard: hasImportStep, actions: "forward" },
          { target: "model", actions: "forward" },
        ],
      },
    },
    import: {
      on: {
        NEXT: { target: "model", actions: "forward" },
        BACK: { target: "welcome", actions: "backward" },
      },
    },
    model: {
      on: {
        NEXT: [
          {
            target: "permissions",
            guard: requiresPermissionsStep,
            actions: "forward",
          },
          { target: "done", actions: "forward" },
        ],
        BACK: [
          { target: "import", guard: hasImportStep, actions: "backward" },
          { target: "welcome", actions: "backward" },
        ],
      },
    },
    permissions: {
      on: {
        NEXT: { target: "done", actions: "forward" },
        BACK: { target: "model", actions: "backward" },
      },
    },
    done: {
      on: {
        BACK: [
          {
            target: "permissions",
            guard: requiresPermissionsStep,
            actions: "backward",
          },
          { target: "model", actions: "backward" },
        ],
      },
    },
  },
});

export { getSteps };
