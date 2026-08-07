import { invoke } from "@tauri-apps/api/core";

export type AskKind = "survey" | "review" | "star";

export interface AskPromptState {
  kind: AskKind | null;
}

export type AskAction = "answer" | "dismiss";

export function getAskPrompt(): Promise<AskPromptState> {
  return invoke<AskPromptState>("get_ask_prompt");
}

export function markAskPromptSeen(): Promise<void> {
  return invoke("mark_ask_prompt_seen");
}

export function resolveAskPrompt(action: AskAction): Promise<void> {
  return invoke("resolve_ask_prompt", { action });
}
