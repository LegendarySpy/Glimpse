import {
  AppWindow,
  Cpu,
  Info,
  Key,
  HardDrives as Server,
  SquaresFour,
  User,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

export type SettingsPane =
  "account" | "general" | "app" | "about" | "models" | "providers" | "api";

export interface SettingsPaneDef {
  id: SettingsPane;
  icon: PhosphorIcon;
  label: MessageDescriptor;
  licensed?: boolean;
}

export interface SettingsPaneGroup {
  caption?: MessageDescriptor;
  panes: SettingsPaneDef[];
}

export const SETTINGS_PANE_GROUPS: SettingsPaneGroup[] = [
  {
    panes: [
      {
        id: "account",
        icon: User,
        label: msg({ id: "settings.modal.tab.account", message: "Account" }),
      },
    ],
  },
  {
    caption: msg({ id: "settings.modal.section.core", message: "Core" }),
    panes: [
      {
        id: "general",
        icon: SquaresFour,
        label: msg({ id: "settings.modal.tab.general", message: "General" }),
      },
      {
        id: "app",
        icon: AppWindow,
        label: msg({ id: "settings.modal.tab.app", message: "App" }),
      },
      {
        id: "about",
        icon: Info,
        label: msg({ id: "settings.modal.tab.about", message: "About" }),
      },
    ],
  },
  {
    caption: msg({
      id: "settings.modal.section.dictation",
      message: "Dictation",
    }),
    panes: [
      {
        id: "models",
        icon: Cpu,
        label: msg({ id: "settings.modal.tab.models", message: "Models" }),
      },
      {
        id: "providers",
        icon: Key,
        label: msg({
          id: "settings.modal.tab.providers",
          message: "Providers",
        }),
      },
    ],
  },
  {
    caption: msg({
      id: "settings.modal.section.developer",
      message: "Developer",
    }),
    panes: [
      {
        id: "api",
        icon: Server,
        label: msg({
          id: "settings.modal.tab.api_server",
          message: "API Server",
        }),
        licensed: true,
      },
    ],
  },
];
