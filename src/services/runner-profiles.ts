import type { RunnerType } from "../types/task.js";
import type { CraigConfig } from "../types/config.js";

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

export function getConfiguredRunnerProfile(runner: RunnerType, config: CraigConfig = {}): RunnerProfile {
  const profile = getRunnerProfile(runner);
  const configuredPath = config.runners?.[runner]?.path?.trim();
  return {
    ...profile,
    executable: configuredPath && configuredPath.length > 0 ? configuredPath : profile.executable,
  };
}

export function getEnabledRunnerIds(config: CraigConfig = {}): RunnerType[] {
  return RUNNER_IDS.filter((runner) => config.runners?.[runner]?.enabled !== false);
}

export function getDefaultRunner(config: CraigConfig = {}): RunnerType {
  const enabledRunners = getEnabledRunnerIds(config);
  if (enabledRunners.length === 0) {
    throw new Error("No runners are enabled. Enable at least one runner in .craig/config.json.");
  }

  return enabledRunners.includes("codex") ? "codex" : enabledRunners[0]!;
}

export function assertRunnerEnabled(runner: RunnerType, config: CraigConfig = {}): void {
  if (config.runners?.[runner]?.enabled === false) {
    throw new Error(`Runner "${runner}" is disabled in .craig/config.json.`);
  }
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

export function buildRunnerCommand(runner: RunnerType, prompt?: string, config: CraigConfig = {}): string[] {
  const command = [getConfiguredRunnerProfile(runner, config).executable];
  if (prompt && prompt.length > 0) {
    command.push(prompt);
  }
  return command;
}
