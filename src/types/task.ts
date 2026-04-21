export type TaskType = "repo";
export type TaskStatus =
  | "draft"
  | "running"
  | "review"
  | "checked"
  | "pr_open"
  | "merge_ready"
  | "merged";
export type RunnerType = "cursor" | "codex";

export interface TaskPromptSource {
  source: "inline" | "file";
  value: string;
}

export interface TaskChecks {
  source: {
    type: "repo_config";
    path: string;
  };
  lastRunAt: string | null;
  status: "not_run" | "running" | "passed" | "failed";
  commands: string[];
}

export interface TaskPullRequestCheck {
  name: string;
  status: "pending" | "success" | "failed";
  conclusion: string | null;
}

export interface TaskPullRequest {
  provider: "github";
  number: number | null;
  url: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  status: "open" | "closed" | "merged" | null;
  mergeable: boolean;
  requiredChecks: TaskPullRequestCheck[];
  lastSyncedAt: string | null;
}

export interface TaskArtifacts {
  logPath: string | null;
  prDraftPath: string | null;
  prStatusPath: string | null;
}

export type RunnerSessionState = "starting" | "running" | "exited" | "failed";

export interface RunnerSession {
  command: string[];
  tmuxTarget: string;
  pid: number | null;
  startedAt: string | null;
  lastKnownState: RunnerSessionState;
  exitCode: number | null;
  exitedAt: string | null;
}

export interface TaskRecord {
  id: string;
  title: string;
  slug: string;
  type: TaskType;
  status: TaskStatus;
  runner: RunnerType;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  tmuxTarget: string;
  runnerSession: RunnerSession;
  prompt: TaskPromptSource;
  checks: TaskChecks;
  pullRequest: TaskPullRequest;
  artifacts: TaskArtifacts;
  lastFailureReason?: string | null;
  createdAt: string;
  updatedAt: string;
}
