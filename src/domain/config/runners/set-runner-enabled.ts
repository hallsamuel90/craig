import type { CraigConfig, RunnerType } from "../types.js";

export const setRunnerEnabled = (config: CraigConfig, runner: RunnerType, enabled: boolean): CraigConfig => ({
  ...config,
  runners: {
    ...(config.runners ?? {}),
    [runner]: {
      ...(config.runners?.[runner] ?? {}),
      enabled,
    },
  },
});
