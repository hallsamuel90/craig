import type { RunnerType } from "../types.js";
import { RUNNER_IDS } from "./runner-ids.js";

export const isRunnerType = (value: string): value is RunnerType =>
  (RUNNER_IDS as readonly string[]).includes(value);
