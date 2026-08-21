export type RunnerType = "codex" | "cursor" | "claude" | "pi";
export type PreviewFeatureId = "agentOrchestration" | "piRunner";

export interface RunnerConfig {
  enabled?: boolean;
  path?: string;
}

export interface CraigConfig {
  runners?: {
    codex?: RunnerConfig;
    cursor?: RunnerConfig;
    claude?: RunnerConfig;
    pi?: RunnerConfig;
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
    piRunner?: boolean;
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
