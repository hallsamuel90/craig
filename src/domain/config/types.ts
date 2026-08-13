export type RunnerType = "codex" | "cursor" | "claude";
export type PreviewFeatureId = "agentOrchestration";

export interface RunnerConfig {
  enabled?: boolean;
  path?: string;
}

export interface CraigConfig {
  runners?: {
    codex?: RunnerConfig;
    cursor?: RunnerConfig;
    claude?: RunnerConfig;
  };
  checks?: {
    commands: string[];
  };
  open?: {
    command: string[];
  };
  github?: {
    mergeMethod?: "merge" | "rebase" | "squash";
    watchIntervalSeconds?: number;
  };
  previews?: {
    incrementalCenterPane?: boolean;
    agentActivityIndicators?: boolean;
    agentOrchestration?: boolean;
  };
}

export interface RunnerProfile {
  id: RunnerType;
  displayName: string;
  executable: string;
  defaultAgentTitle: string;
}

export interface VersionCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}
