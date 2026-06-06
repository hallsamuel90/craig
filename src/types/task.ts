export type TaskType = "repo" | "project";
export type TaskStatus =
  | "draft"
  | "running"
  | "review"
  | "checked"
  | "pr_open"
  | "merge_ready"
  | "merged"
  | "closed";
export type RunnerType = "codex" | "cursor" | "claude";
export type TaskPRStatus = "open" | "closed" | "merged" | "draft";

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

export interface TaskPR {
  provider: "github";
  owner: string | null;
  repo: string | null;
  number: number | null;
  url: string | null;
  title: string | null;
  status: TaskPRStatus | null;
  draft: boolean;
  baseBranch: string | null;
  headBranch: string | null;
  mergeable: boolean;
  mergeStateStatus: string | null;
  requiredChecks: TaskPullRequestCheck[];
  createdAt: string | null;
  updatedAt: string | null;
  mergedAt: string | null;
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
  runner?: RunnerType;
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

export type ProjectTaskRepoTargetStatus = "ready" | "unavailable" | "merged" | "closed";

export interface ProjectTaskRepoTarget {
  repoId: string;
  branch: string;
  repoRoot: string;
  worktreePath: string;
  status: ProjectTaskRepoTargetStatus;
  failureReason: string | null;
  checks: TaskChecks;
  lastCommit: TaskLastCommit | null;
  pullRequest: TaskPullRequest;
  cleanup: TaskCleanup;
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
  bundlePath?: string | null;
  selectedRepoTargetId?: string | null;
  repoTargets?: ProjectTaskRepoTarget[];
  runnerSession: RunnerSession;
  prompt: TaskPromptSource;
  checks: TaskChecks;
  lastCommit: TaskLastCommit | null;
  prs: TaskPR[];
  artifacts: TaskArtifacts;
  cleanup: TaskCleanup;
  lastFailureReason?: string | null;
  createdAt: string;
  updatedAt: string;
}
