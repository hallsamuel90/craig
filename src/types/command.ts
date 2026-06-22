import type { SessionRecord } from "./session.js";
import type { TaskRecord } from "./task.js";
import type { RunnerType } from "../domain/config/index.js";
import type { RepoRecord, WorkspaceRecord } from "../domain/workspace/index.js";

export type AppCommand =
  | { kind: "addWorkspace"; path: string }
  | { kind: "addRepo"; path: string }
  | { kind: "listRepos" }
  | { kind: "removeRepo"; repoId: string }
  | { kind: "listWorkspaces"; archived: boolean }
  | { kind: "archiveWorkspace"; workspaceId: string }
  | { kind: "restoreWorkspace"; workspaceId: string }
  | { kind: "removeWorkspace"; workspaceId: string }
  | { kind: "createTask"; repoId?: string; workspaceId?: string; prompt: string; runner?: RunnerType }
  | { kind: "listTasks"; repoId?: string; workspaceId?: string }
  | { kind: "attachTask"; taskId: string }
  | { kind: "addTaskLink"; taskId: string; repoId: string }
  | { kind: "listTaskLinks"; taskId: string }
  | { kind: "refreshInteractiveState" }
  | { kind: "showTask"; taskId: string }
  | { kind: "showSelectedTask" }
  | { kind: "streamTaskLogs"; taskId: string }
  | { kind: "streamSelectedTaskLogs" }
  | { kind: "showTaskDiff"; taskId: string }
  | { kind: "showSelectedTaskDiff" }
  | { kind: "focusTask"; taskId: string }
  | { kind: "focusSelectedTask" }
  | { kind: "openTask"; taskId: string }
  | { kind: "openSelectedTask" }
  | { kind: "runChecks"; taskId: string }
  | { kind: "runSelectedTaskChecks" }
  | { kind: "commitTask"; taskId: string }
  | { kind: "commitSelectedTask" }
  | { kind: "help" }
  | { kind: "exit" };

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

export interface CommandCreateWorkspaceResult {
  kind: "createWorkspace";
  workspace: WorkspaceRecord;
  repos: RepoRecord[];
  created: boolean;
}

export interface CommandCreateRepoResult {
  kind: "createRepo";
  repo: RepoRecord;
  workspaceId: string;
  created: boolean;
}

export interface CommandListReposResult {
  kind: "listRepos";
  repos: RepoRecord[];
}

export interface CommandRemoveRepoResult {
  kind: "removeRepo";
  repoId: string;
  rootPath: string;
}

export interface CommandListWorkspacesResult {
  kind: "listWorkspaces";
  workspaces: WorkspaceRecord[];
  archivedOnly: boolean;
}

export interface CommandArchiveWorkspaceResult {
  kind: "archiveWorkspace";
  workspaceId: string;
  status: "archived";
  branch: string;
}

export interface CommandRestoreWorkspaceResult {
  kind: "restoreWorkspace";
  workspaceId: string;
  status: "active";
  branch: string;
}

export interface CommandRemoveWorkspaceResult {
  kind: "removeWorkspace";
  workspaceId: string;
  rootPath: string;
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
  session: SessionRecord | null;
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

export type CommandResult =
  | CommandCreateWorkspaceResult
  | CommandCreateRepoResult
  | CommandListReposResult
  | CommandRemoveRepoResult
  | CommandListWorkspacesResult
  | CommandArchiveWorkspaceResult
  | CommandRestoreWorkspaceResult
  | CommandRemoveWorkspaceResult
  | CommandCreateTaskResult
  | CommandAttachTaskResult
  | CommandAddTaskLinkResult
  | CommandListTaskLinksResult
  | CommandHelpResult
  | CommandExitResult
  | CommandListResult
  | CommandShowTaskResult
  | CommandLogsResult
  | CommandDiffResult
  | CommandFocusResult
  | CommandOpenResult
  | CommandChecksResult
  | CommandCommitResult;
