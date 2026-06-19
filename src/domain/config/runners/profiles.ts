import type { RunnerProfile, RunnerType } from "../types.js";

export const RUNNER_PROFILES: Record<RunnerType, RunnerProfile> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    executable: "codex",
    defaultAgentTitle: "Codex",
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    executable: "cursor-agent",
    defaultAgentTitle: "Cursor",
  },
  claude: {
    id: "claude",
    displayName: "Claude",
    executable: "claude",
    defaultAgentTitle: "Claude",
  },
};
