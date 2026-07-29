import { invoke } from "@tauri-apps/api/core";

export interface SurveyPromptState {
  show: boolean;
}

export type SurveyAction = "answer" | "dismiss";

export function getSurveyPrompt(): Promise<SurveyPromptState> {
  return invoke<SurveyPromptState>("get_survey_prompt");
}

export function markSurveyPromptSeen(): Promise<void> {
  return invoke("mark_survey_prompt_seen");
}

export function resolveSurveyPrompt(action: SurveyAction): Promise<void> {
  return invoke("resolve_survey_prompt", { action });
}
