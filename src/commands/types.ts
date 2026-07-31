import type { RunnerType } from "../domain/task/index.js";
import type {
  CommandCreateTaskResult,
  CommandListResult,
  CommandAttachTaskResult,
  CommandAddTaskLinkResult,
  CommandListTaskLinksResult,
  CommandShowTaskResult,
  CommandCurrentTaskResult,
  CommandTaskPrResult,
  CommandLogsResult,
  CommandDiffResult,
  CommandFocusResult,
  CommandOpenResult,
  CommandChecksResult,
  CommandCommitResult,
} from "../domain/task/index.js";
import type {
  CommandCreateWorkspaceResult,
  CommandCreateRepoResult,
  CommandListReposResult,
  CommandRemoveRepoResult,
  CommandListWorkspacesResult,
  CommandArchiveWorkspaceResult,
  CommandRestoreWorkspaceResult,
  CommandRemoveWorkspaceResult,
} from "../domain/workspace/index.js";
import type { CommandShowContextResult } from "../domain/context/index.js";

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
  | { kind: "currentTask" }
  | { kind: "attachTask"; taskId: string }
  | { kind: "addTaskLink"; taskId: string; repoId: string }
  | { kind: "listTaskLinks"; taskId: string }
  | { kind: "refreshInteractiveState" }
  | { kind: "showTask"; taskId: string }
  | { kind: "showCurrentTask" }
  | { kind: "showTaskPr"; taskId?: string; repoId?: string }
  | { kind: "discoverTaskPr"; taskId?: string; repoId?: string }
  | { kind: "linkTaskPr"; taskId?: string; repoId?: string; pullRequest: string }
  | { kind: "refreshTaskPr"; taskId?: string; repoId?: string }
  | { kind: "unlinkTaskPr"; taskId?: string; repoId?: string; pullRequest: string }
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
  | { kind: "showContext" }
  | { kind: "help" }
  | { kind: "exit" };

export interface CommandHelpResult {
  kind: "help";
  text: string;
}

export interface CommandExitResult {
  kind: "exit";
}

export type {
  CommandCreateTaskResult,
  CommandListResult,
  CommandAttachTaskResult,
  CommandAddTaskLinkResult,
  CommandListTaskLinksResult,
  CommandShowTaskResult,
  CommandCurrentTaskResult,
  CommandTaskPrResult,
  CommandLogsResult,
  CommandDiffResult,
  CommandFocusResult,
  CommandOpenResult,
  CommandChecksResult,
  CommandCommitResult,
  CommandCreateWorkspaceResult,
  CommandCreateRepoResult,
  CommandListReposResult,
  CommandRemoveRepoResult,
  CommandListWorkspacesResult,
  CommandArchiveWorkspaceResult,
  CommandRestoreWorkspaceResult,
  CommandRemoveWorkspaceResult,
  CommandShowContextResult,
};

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
  | CommandCurrentTaskResult
  | CommandTaskPrResult
  | CommandShowContextResult
  | CommandLogsResult
  | CommandDiffResult
  | CommandFocusResult
  | CommandOpenResult
  | CommandChecksResult
  | CommandCommitResult;
