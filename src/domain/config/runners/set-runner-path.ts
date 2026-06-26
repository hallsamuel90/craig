import type { CraigConfig, RunnerType } from "../types.js";

export const setRunnerPath = (config: CraigConfig, runner: RunnerType, executablePath: string | null): CraigConfig => {
  const existing = config.runners?.[runner] ?? {};
  const { path: _removed, ...withoutPath } = existing;
  return {
    ...config,
    runners: {
      ...(config.runners ?? {}),
      [runner]: executablePath != null ? { ...existing, path: executablePath } : withoutPath,
    },
  };
};
