import type { TaskRecord } from "./task.js";

export type AppCommand =
  | { kind: "listTasks" }
  | { kind: "help" }
  | { kind: "exit" };

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
  | CommandHelpResult
  | CommandExitResult
  | CommandListResult;
