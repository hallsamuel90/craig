import type { RunnerType } from "../types.js";

export const STABLE_RUNNER_IDS = ["codex", "cursor", "claude"] as const satisfies readonly RunnerType[];
export const RUNNER_IDS = [...STABLE_RUNNER_IDS, "pi"] as const satisfies readonly RunnerType[];
