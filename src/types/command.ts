import type { TaskRecord } from "./task.js";

export type AppCommand =
  | { kind: "createTask"; title: string }
  | { kind: "listTasks" }
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

export type CommandResult =
  | CommandCreateTaskResult
  | CommandHelpResult
  | CommandExitResult
  | CommandListResult;
