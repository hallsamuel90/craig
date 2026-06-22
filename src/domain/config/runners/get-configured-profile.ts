import type { CraigConfig, RunnerProfile, RunnerType } from "../types.js";
import { getProfile } from "./get-profile.js";

export const getConfiguredProfile = (runner: RunnerType, config: CraigConfig = {}): RunnerProfile => {
  const profile = getProfile(runner);
  const configuredPath = config.runners?.[runner]?.path?.trim();
  return {
    ...profile,
    executable: configuredPath && configuredPath.length > 0 ? configuredPath : profile.executable,
  };
};
