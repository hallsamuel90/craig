import type { CraigConfig, RunnerType } from "../types.js";

export const setRunnerPath = (config: CraigConfig, runner: RunnerType, executablePath: string | null): CraigConfig => {
  const runnerConfig = {
    ...(config.runners?.[runner] ?? {}),
    ...(executablePath ? { path: executablePath } : {}),
  };

  if (!executablePath) {
    delete runnerConfig.path;
  }

  return {
    ...config,
    runners: {
      ...(config.runners ?? {}),
      [runner]: runnerConfig,
    },
  };
};
