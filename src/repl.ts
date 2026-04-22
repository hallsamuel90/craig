import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { executeCommand, type CommandContext } from "./commands/command-router.js";
import { parseReplCommand } from "./commands/parse-repl.js";
import { renderControlView } from "./control-view.js";
import { formatCommandResult } from "./main.js";
import { streamTaskLogs } from "./services/stream-task-logs.js";

type ReplInterface = ReturnType<typeof createInterface>;

export async function startRepl(context: CommandContext): Promise<number> {
  let sigintCount = 0;
  let shouldExit = false;
  let recentEvent: string | null = null;
  let rl = createReadline();

  try {
    while (!shouldExit) {
      await writeControlView(context, recentEvent);
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
            recentEvent = formatCommandResult(result).split("\n")[0] ?? null;
            output.write(`${formatCommandResult(result)}\n`);
            await streamTaskLogs(result.logPath);
          } finally {
            rl = createReadline();
          }
          continue;
        }

        const message = formatCommandResult(result);
        recentEvent = message.split("\n")[0] ?? null;

        if (message.length > 0) {
          output.write(`${message}\n`);
        }
      } catch (error) {
        recentEvent = formatError(error);
        output.write(`${recentEvent}\n`);
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

async function writeControlView(context: CommandContext, recentEvent: string | null): Promise<void> {
  output.write("\n");
  output.write(`${await renderControlView(context, recentEvent)}\n`);
  output.write("\n");
}
