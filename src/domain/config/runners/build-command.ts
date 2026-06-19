import type { CraigConfig, RunnerType } from "../types.js";
import { getConfiguredProfile } from "./get-configured-profile.js";

export const buildCommand = (runner: RunnerType, prompt?: string, config: CraigConfig = {}): string[] => {
  const command = [getConfiguredProfile(runner, config).executable];
  if (prompt && prompt.length > 0) {
    command.push(prompt);
  }
  return command;
};
