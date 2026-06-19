import type { RunnerType } from "../types.js";

export const RUNNER_IDS = ["codex", "cursor", "claude"] as const satisfies readonly RunnerType[];
