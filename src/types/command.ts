import type { TaskRecord } from "./task.js";

export type AppCommand =
  | { kind: "createTask"; title: string }
  | { kind: "listTasks" }
  | { kind: "showTask"; taskId: string }
  | { kind: "streamTaskLogs"; taskId: string }
  | { kind: "showTaskDiff"; taskId: string }
  | { kind: "focusTask"; taskId: string }
  | { kind: "openTask"; taskId: string }
  | { kind: "runChecks"; taskId: string }
  | { kind: "commitTask"; taskId: string }
  | { kind: "openPullRequest"; taskId: string; watch: boolean }
  | { kind: "mergeTask"; taskId: string; preserveWorktree: boolean }
  | { kind: "help" }
  | { kind: "exit" };

export interface CommandCreateTaskResult {
  kind: "createTask";
  taskId: string;
  status: string;
  branch: string;
  worktreePath: string;
  tmuxTarget: string;
  runner: string;
}

export interface CommandHelpResult {
  kind: "help";
  text: string;
}

export interface CommandExitResult {
  kind: "exit";
}

export interface CommandListResult {
  kind: "listTasks";
  tasks: TaskRecord[];
  missingTaskIds: string[];
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

export interface CommandShowTaskResult {
  kind: "showTask";
  task: TaskRecord;
  inspection: TaskInspection;
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

export interface CommandPullRequestResult {
  kind: "openPullRequest";
  taskId: string;
  watch: boolean;
  prNumber: number;
  url: string;
  status: string;
  mergeable: boolean;
  requiredChecksSummary: string;
}

export interface CommandMergeResult {
  kind: "mergeTask";
  taskId: string;
  status: string;
  prNumber: number;
  preservedWorktree: boolean;
  cleanupWarning: string | null;
}

export type CommandResult =
  | CommandCreateTaskResult
  | CommandHelpResult
  | CommandExitResult
  | CommandListResult
  | CommandShowTaskResult
  | CommandLogsResult
  | CommandDiffResult
  | CommandFocusResult
  | CommandOpenResult
  | CommandChecksResult
  | CommandCommitResult
  | CommandPullRequestResult
  | CommandMergeResult;
