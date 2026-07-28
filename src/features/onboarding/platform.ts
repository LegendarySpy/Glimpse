import {
  detectAppPlatform,
  getPlatformCapabilities,
} from "../../platform/service";
import type { AppPlatformId } from "../../shared/lib/platform";

type OnboardingPlatformId = AppPlatformId;

export type OnboardingStep =
  "welcome" | "model" | "import" | "permissions" | "done";

export type OnboardingPlatform = {
  id: OnboardingPlatformId;
  requiresMicrophonePermission: boolean;
  requiresAccessibilityPermission: boolean;
};

// Alt+Space opens the window menu on Windows, so the hotkey never reaches us.

export const getDefaultShortcuts = (platform: OnboardingPlatformId) =>
  platform === "windows"
    ? {
        smart: "Control+Shift+Space",
        hold: "Control+Alt+Space",
        toggle: "Control+Shift+Alt+Space",
      }
    : {
        smart: "Alt+Space",
        hold: "Control+Shift+Space",
        toggle: "Control+Alt+Space",
      };

export const getOnboardingPlatform = (): OnboardingPlatform => {
  const id = detectAppPlatform();
  const capabilities = getPlatformCapabilities();

  return {
    id,
    requiresMicrophonePermission:
      capabilities.requiresNativeMicrophonePermission,
    requiresAccessibilityPermission:
      capabilities.requiresAccessibilityPermission,
  };
};
