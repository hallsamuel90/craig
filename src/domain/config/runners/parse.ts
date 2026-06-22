import type { RunnerType } from "../types.js";
import { RUNNER_IDS } from "./runner-ids.js";
import { isRunnerType } from "./is-runner-type.js";

export const parse = (value: string | null | undefined): RunnerType => {
  if (!value || value.length === 0) {
    return "codex";
  }
  if (!isRunnerType(value)) {
    throw new Error(`Unsupported runner "${value}". Expected one of: ${RUNNER_IDS.join(", ")}.`);
  }
  return value;
};
