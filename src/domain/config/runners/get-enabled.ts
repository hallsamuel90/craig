import type { CraigConfig, RunnerType } from "../types.js";
import { RUNNER_IDS } from "./runner-ids.js";

export const getEnabled = (config: CraigConfig = {}): RunnerType[] =>
  RUNNER_IDS.filter((runner) => config.runners?.[runner]?.enabled !== false);
