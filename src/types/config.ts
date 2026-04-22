export interface CraigConfig {
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
