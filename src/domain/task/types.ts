import type { RunnerType } from "../config/index.js";
import type { RepoRecord } from "../workspace/index.js";

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

export interface TaskPullRequestComment {
  author: string | null;
  body: string;
  createdAt: string | null;
  url: string | null;
}

export type TaskPullRequestReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export interface TaskPullRequest {
  provider: "github";
  owner?: string | null;
  repo?: string | null;
  number: number | null;
  url: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  status: "open" | "closed" | "merged" | null;
  draft?: boolean;
  mergeable: boolean;
  mergeStateStatus: string | null;
  reviewDecision?: TaskPullRequestReviewDecision;
  requiredChecks: TaskPullRequestCheck[];
  comments?: TaskPullRequestComment[];
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
  reviewDecision?: TaskPullRequestReviewDecision;
  requiredChecks: TaskPullRequestCheck[];
  comments?: TaskPullRequestComment[];
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
  capabilityId?: string;
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
  parentTaskId: string | null;
  rootTaskId: string;
  delegationDepth: number;
  delegationIdempotencyKey: string | null;
  swarmRunId: string | null;
  swarmStepId: string | null;
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

export interface TaskInspection {
  worktreeExists: boolean;
  logExists: boolean;
  recentFailureReason: string | null;
  runnerCommandText: string;
  checksSummary: string;
  lastCommitSummary: string;
  prSummary: string;
  cleanupSummary: string;
}

export interface CommandCreateTaskResult {
  kind: "createTask";
  taskId: string;
  repoId: string;
  workspaceId: string;
  sessionId: string;
  status: string;
  branch: string;
  worktreePath: string;
  runner: string;
}

export interface CommandListResult {
  kind: "listTasks";
  tasks: TaskRecord[];
  missingTaskIds: string[];
  repoId: string | null;
}

export interface CommandAttachTaskResult {
  kind: "attachTask";
  taskId: string;
  sessionId: string;
  disposition: "attached";
}

export interface CommandAddTaskLinkResult {
  kind: "addTaskLink";
  taskId: string;
  repoId: string;
  linkedRepoIds: string[];
}

export interface CommandListTaskLinksResult {
  kind: "listTaskLinks";
  taskId: string;
  repos: RepoRecord[];
}

export interface CommandShowTaskResult {
  kind: "showTask";
  task: TaskRecord;
  inspection: TaskInspection;
  session: SessionRecord | null;
}

export type TaskContextSource = "explicit" | "environment" | "cwd";

export interface ResolvedTaskContext {
  task: TaskRecord;
  source: TaskContextSource;
  agentTabId: string | null;
}

export interface CommandCurrentTaskResult {
  kind: "currentTask";
  task: TaskRecord;
  context: {
    source: TaskContextSource;
    agentTabId: string | null;
  };
}

export type TaskPrCommandDisposition =
  | "shown"
  | "discovered"
  | "linked"
  | "synced"
  | "unlinked"
  | "unchanged"
  | "not_found";

export interface CommandTaskPrResult {
  kind: "showTaskPr" | "discoverTaskPr" | "linkTaskPr" | "refreshTaskPr" | "unlinkTaskPr";
  taskId: string;
  repoId: string;
  disposition: TaskPrCommandDisposition;
  pullRequests: TaskPR[];
  primaryPullRequest: TaskPR | null;
  warnings: string[];
}

export interface CommandLogsResult {
  kind: "streamTaskLogs";
  taskId: string;
  logPath: string;
}

export interface CommandDiffResult {
  kind: "showTaskDiff";
  taskId: string;
  diffText: string;
  isEmpty: boolean;
}

export interface CommandFocusResult {
  kind: "focusTask";
  taskId: string;
  tmuxTarget: string;
}

export interface CommandOpenResult {
  kind: "openTask";
  taskId: string;
  worktreePath: string;
  launched: boolean;
  command: string[] | null;
}

export interface CommandChecksResult {
  kind: "runChecks";
  taskId: string;
  status: "passed" | "failed";
  commands: string[];
}

export interface CommandCommitResult {
  kind: "commitTask";
  taskId: string;
  status: string;
  commitSha: string;
  message: string;
}

export type SessionSubstrate = "tmux";
export type SessionStatus = "starting" | "running" | "exited" | "failed";

export interface SessionTerminalSize {
  columns: number;
  rows: number;
}

export interface SessionSnapshot {
  paneId: string;
  windowTarget: string | null;
  alive: boolean;
  capturedAt: string;
}

export interface SessionAttachState {
  detachChord: "ctrl+]";
  lastSize: SessionTerminalSize | null;
}

export interface SessionRecord {
  id: string;
  taskId: string;
  repoId: string;
  workspaceId: string;
  substrate: SessionSubstrate;
  sessionName: string;
  paneId: string;
  windowTarget: string | null;
  worktreePath: string;
  logPath: string | null;
  command: string[];
  status: SessionStatus;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  lastAttachedAt: string | null;
  attach: SessionAttachState;
  snapshot: SessionSnapshot | null;
  createdAt: string;
  updatedAt: string;
}
