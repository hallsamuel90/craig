import type { CraigConfig, RunnerType } from "../types.js";
import { getEnabled } from "./get-enabled.js";

export const getDefault = (config: CraigConfig = {}): RunnerType => {
  const enabled = getEnabled(config);
  if (enabled.length === 0) {
    throw new Error("No runners are enabled. Enable at least one runner in .craig/config.json.");
  }
  return enabled.includes("codex") ? "codex" : enabled[0]!;
};
