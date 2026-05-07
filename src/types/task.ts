export type TaskType = "repo";
export type TaskStatus =
  | "draft"
  | "running"
  | "review"
  | "checked"
  | "pr_open"
  | "merge_ready"
  | "merged"
  | "closed";
export type RunnerType = "cursor" | "codex";

export interface TaskPromptSource {
  source: "inline" | "file";
  value: string;
}

export interface TaskCheckResult {
  command: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
}

export interface TaskChecks {
  source: {
    type: "repo_config";
    path: string;
  };
  lastRunAt: string | null;
  status: "not_run" | "running" | "passed" | "failed";
  commands: string[];
  results: TaskCheckResult[];
}

export interface TaskPullRequestCheck {
  name: string;
  status: "pending" | "success" | "failed" | "skipped" | "unknown";
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
  mergeStateStatus: string | null;
  requiredChecks: TaskPullRequestCheck[];
  lastSyncedAt: string | null;
  lastSyncedHeadSha: string | null;
}

export interface TaskArtifacts {
  logPath: string | null;
  checkSummaryPath: string | null;
  prDraftPath: string | null;
  prStatusPath: string | null;
}

export type RunnerSessionState = "starting" | "running" | "exited" | "failed";
export type TaskPtyTabKind = "agent" | "terminal";

export interface TaskPtyTabRecord {
  id: string;
  kind: TaskPtyTabKind;
  title: string;
  command: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RunnerSession {
  command: string[];
  pid: number | null;
  startedAt: string | null;
  lastKnownState: RunnerSessionState;
  exitCode: number | null;
  exitedAt: string | null;
}

export interface TaskLastCommit {
  sha: string;
  message: string;
  committedAt: string;
}

export interface TaskCleanup {
  paneClosedAt: string | null;
  worktreeRemovedAt: string | null;
  preservedWorktree: boolean;
  warning: string | null;
}

export interface TaskRecord {
  id: string;
  title: string;
  slug: string;
  type: TaskType;
  status: TaskStatus;
  runner: RunnerType;
  repoId: string;
  workspaceId: string;
  sessionId: string | null;
  selectedPtyTabId: string | null;
  linkedRepoIds: string[];
  repoRoot: string;
  worktreePath: string;
  branch: string;
  ptyTabs: TaskPtyTabRecord[];
  runnerSession: RunnerSession;
  prompt: TaskPromptSource;
  checks: TaskChecks;
  lastCommit: TaskLastCommit | null;
  pullRequest: TaskPullRequest;
  artifacts: TaskArtifacts;
  cleanup: TaskCleanup;
  lastFailureReason?: string | null;
  createdAt: string;
  updatedAt: string;
}
