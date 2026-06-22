import type { CraigConfig, RunnerType } from "../types.js";

export const assertEnabled = (runner: RunnerType, config: CraigConfig = {}): void => {
  if (config.runners?.[runner]?.enabled === false) {
    throw new Error(`Runner "${runner}" is disabled in .craig/config.json.`);
  }
};
