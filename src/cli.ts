#!/usr/bin/env node

import { executeCommand } from "./commands/command-router.js";
import { parseArgv } from "./commands/parse-argv.js";
import { getCraigPaths } from "./state/craig-paths.js";
import { formatCommandResult } from "./main.js";
import { startTerminalApp } from "./ui/app.js";
import { requestDaemonShutdown, servePtyDaemon } from "./ui/pty-daemon.js";
import { getCurrentWorkingDirectory } from "./utils/cwd.js";

async function main(): Promise<number> {
  try {
    if (process.argv[2] === "__craig-daemon") {
      const workspaceRoot = process.argv[3] ?? getCurrentWorkingDirectory();
      const paths = getCraigPaths(workspaceRoot);
      await servePtyDaemon(paths);
      return 0;
    }

    if (process.argv[2] === "__craig-daemon-shutdown") {
      const workspaceRoot = process.argv[3] ?? getCurrentWorkingDirectory();
      const paths = getCraigPaths(workspaceRoot);
      await requestDaemonShutdown(paths);
      return 0;
    }

    const parsed = parseArgv(process.argv.slice(2));
    const cwd = getCurrentWorkingDirectory();
    const paths = getCraigPaths(cwd);
    const context = { paths };

    if (parsed.mode === "interactive") {
      return await startTerminalApp({ uiStateFile: paths.uiStateFile, workspaceRoot: paths.workspaceRoot });
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
