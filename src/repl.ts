import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { executeCommand, type CommandContext } from "./commands/command-router.js";
import { parseReplCommand } from "./commands/parse-repl.js";
import { formatCommandResult } from "./main.js";

export async function startRepl(context: CommandContext): Promise<number> {
  const rl = createInterface({ input, output, terminal: true });

  let sigintCount = 0;
  rl.on("SIGINT", () => {
    sigintCount += 1;

    if (sigintCount >= 2) {
      rl.close();
      return;
    }

    output.write("\nPress Ctrl-C again to exit.\n");
    rl.prompt();
  });

  try {
    while (true) {
      const line = await rl.question("craig> ");
      sigintCount = 0;

      try {
        const command = parseReplCommand(line);
        const result = await executeCommand(command, context);

        if (result.kind === "exit") {
          return 0;
        }

        output.write(`${formatCommandResult(result)}\n`);
      } catch (error) {
        output.write(`${formatError(error)}\n`);
      }
    }
  } catch {
    return 0;
  } finally {
    rl.close();
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown Craig error";
}
