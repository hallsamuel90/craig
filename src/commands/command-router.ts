import type { CommandResult, AppCommand } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { getHelpText } from "./parse-argv.js";
import { createTask } from "../services/create-task.js";
import { listTasks } from "../services/list-tasks.js";
import { showTask } from "../services/show-task.js";
import { prepareTaskLogs } from "../services/stream-task-logs.js";
import { showTaskDiff } from "../services/show-task-diff.js";
import { focusTask } from "../services/focus-task.js";
import { openTask } from "../services/open-task.js";
import { runChecks } from "../services/run-checks.js";
import { commitTask } from "../services/commit-task.js";
import { openPullRequest } from "../services/open-pull-request.js";
import { mergeTask } from "../services/merge-task.js";

export interface CommandContext {
  paths: CraigPaths;
}

export async function executeCommand(
  command: AppCommand,
  context: CommandContext,
): Promise<CommandResult> {
  switch (command.kind) {
    case "createTask":
      return createTask(context.paths, command.title);
    case "listTasks":
      return listTasks(context.paths);
    case "showTask":
      return showTask(context.paths, command.taskId);
    case "streamTaskLogs":
      return prepareTaskLogs(context.paths, command.taskId);
    case "showTaskDiff":
      return showTaskDiff(context.paths, command.taskId);
    case "focusTask":
      return focusTask(context.paths, command.taskId);
    case "openTask":
      return openTask(context.paths, command.taskId);
    case "runChecks":
      return runChecks(context.paths, command.taskId);
    case "commitTask":
      return commitTask(context.paths, command.taskId);
    case "openPullRequest":
      return openPullRequest(context.paths, command.taskId, { watch: command.watch });
    case "mergeTask":
      return mergeTask(context.paths, command.taskId, {
        preserveWorktree: command.preserveWorktree,
      });
    case "help":
      return { kind: "help", text: getHelpText() };
    case "exit":
      return { kind: "exit" };
    default:
      return assertNever(command);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported command: ${JSON.stringify(value)}`);
}
