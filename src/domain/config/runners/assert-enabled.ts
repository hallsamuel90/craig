import type { CraigConfig, RunnerType } from "../types.js";

export const assertEnabled = (runner: RunnerType, config: CraigConfig = {}): void => {
  if (runner === "pi" && config.previews?.piRunner !== true) {
    throw new Error('Runner "pi" is experimental. Enable the piRunner feature preview in .craig/config.json.');
  }
  if (config.runners?.[runner]?.enabled === false) {
    throw new Error(`Runner "${runner}" is disabled in .craig/config.json.`);
  }
};
