import type { CommandResult, AppCommand } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { getHelpText } from "./parse-argv.js";
import { listTasks } from "../services/list-tasks.js";

export interface CommandContext {
  paths: CraigPaths;
}

export async function executeCommand(
  command: AppCommand,
  context: CommandContext,
): Promise<CommandResult> {
  switch (command.kind) {
    case "listTasks":
      return listTasks(context.paths);
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
