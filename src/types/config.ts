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
}

export interface RunnerConfig {
  enabled?: boolean;
  path?: string;
}
