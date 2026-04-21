import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { executeCommand, type CommandContext } from "./commands/command-router.js";
import { parseReplCommand } from "./commands/parse-repl.js";
import { formatCommandResult } from "./main.js";
import { focusPane } from "./services/tmux-session.js";
import { streamTaskLogs } from "./services/stream-task-logs.js";

type ReplInterface = ReturnType<typeof createInterface>;

export async function startRepl(context: CommandContext): Promise<number> {
  let sigintCount = 0;
  let shouldExit = false;
  let rl = createReadline();

  try {
    while (!shouldExit) {
      const line = await rl.question("craig> ");
      sigintCount = 0;

      try {
        const command = parseReplCommand(line);
        const result = await executeCommand(command, context);

        if (result.kind === "exit") {
          return 0;
        }

        if (result.kind === "streamTaskLogs") {
          rl.close();
          try {
            output.write(`${formatCommandResult(result)}\n`);
            await streamTaskLogs(result.logPath);
          } finally {
            rl = createReadline();
          }
          continue;
        }

        output.write(`${formatCommandResult(result)}\n`);

        if (result.kind === "createTask") {
          rl.close();
          try {
            await focusPane(context.paths.repoRoot, result.tmuxTarget);
          } finally {
            rl = createReadline();
          }
        }
      } catch (error) {
        output.write(`${formatError(error)}\n`);
      }
    }
  } catch {
    return 0;
  } finally {
    rl.close();
  }

  return 0;

  function handleSigint(currentRl: ReplInterface) {
    sigintCount += 1;

    if (sigintCount >= 2) {
      shouldExit = true;
      currentRl.close();
      return;
    }

    output.write("\nPress Ctrl-C again to exit.\n");
    currentRl.prompt();
  }

  function createReadline(): ReplInterface {
    const nextRl = createInterface({ input, output, terminal: true });
    nextRl.on("SIGINT", () => handleSigint(nextRl));
    return nextRl;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown Craig error";
}
