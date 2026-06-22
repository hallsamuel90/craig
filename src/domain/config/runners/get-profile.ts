import type { RunnerProfile, RunnerType } from "../types.js";
import { RUNNER_PROFILES } from "./profiles.js";

export const getProfile = (runner: RunnerType): RunnerProfile => RUNNER_PROFILES[runner];
