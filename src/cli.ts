#!/usr/bin/env node

import { executeCommand } from "./commands/command-router.js";
import { parseArgv } from "./commands/parse-argv.js";
import { ensureCraigState } from "./state/ensure-state.js";
import { getCraigPaths } from "./state/craig-paths.js";
import { formatCommandResult } from "./main.js";
import { startTerminalApp } from "./ui/app.js";
import { getCurrentWorkingDirectory } from "./utils/cwd.js";

async function main(): Promise<number> {
  try {
    const parsed = parseArgv(process.argv.slice(2));
    const cwd = getCurrentWorkingDirectory();
    const paths = getCraigPaths(cwd);
    const index = await ensureCraigState(cwd);
    const context = { paths };

    if (parsed.mode === "interactive") {
      void index;
      return await startTerminalApp();
    }

    if (!parsed.command) {
      throw new Error("Command mode requires a command.");
    }

    const result = await executeCommand(parsed.command, context);

    const output = formatCommandResult(result);

    if (output.length > 0) {
      process.stdout.write(`${output}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Craig error";
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const exitCode = await main();
process.exit(exitCode);
