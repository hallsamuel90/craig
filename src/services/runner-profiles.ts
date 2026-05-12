import type { RunnerType } from "../types/task.js";

export interface RunnerProfile {
  id: RunnerType;
  displayName: string;
  executable: string;
  defaultAgentTitle: string;
}

export const RUNNER_IDS = ["codex", "cursor", "claude"] as const satisfies readonly RunnerType[];

const RUNNER_PROFILES: Record<RunnerType, RunnerProfile> = {
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

export function getRunnerProfile(runner: RunnerType): RunnerProfile {
  return RUNNER_PROFILES[runner];
}

export function isRunnerType(value: string): value is RunnerType {
  return (RUNNER_IDS as readonly string[]).includes(value);
}

export function parseRunnerType(value: string | null | undefined): RunnerType {
  if (!value || value.length === 0) {
    return "codex";
  }

  if (!isRunnerType(value)) {
    throw new Error(`Unsupported runner "${value}". Expected one of: ${RUNNER_IDS.join(", ")}.`);
  }

  return value;
}

export function getRunnerDisplayName(runner: RunnerType): string {
  return getRunnerProfile(runner).displayName;
}

export function buildRunnerCommand(runner: RunnerType, prompt?: string): string[] {
  const command = [getRunnerProfile(runner).executable];
  if (prompt && prompt.length > 0) {
    command.push(prompt);
  }
  return command;
}
