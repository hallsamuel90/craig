#!/usr/bin/env node

import { executeCommand } from "./commands/command-router.js";
import { parseArgv } from "./commands/parse-argv.js";
import { startRepl } from "./repl.js";
import { renderBanner } from "./banner.js";
import { ensureCraigState } from "./state/ensure-state.js";
import { getCraigPaths } from "./state/craig-paths.js";
import { formatCommandResult } from "./main.js";
import { streamTaskLogs } from "./services/stream-task-logs.js";
import { getCurrentWorkingDirectory } from "./utils/cwd.js";
import { detectRepoRoot } from "./utils/repo-detect.js";

async function main(): Promise<number> {
  try {
    const parsed = parseArgv(process.argv.slice(2));
    const cwd = getCurrentWorkingDirectory();
    const repoRoot = await detectRepoRoot(cwd);
    const paths = getCraigPaths(repoRoot);
    const index = await ensureCraigState(repoRoot);
    const context = { paths };

    if (parsed.mode === "interactive") {
      process.stdout.write(`${renderBanner(repoRoot, index)}\n\n`);
      return startRepl(context);
    }

    if (!parsed.command) {
      throw new Error("Command mode requires a command.");
    }

    const result = await executeCommand(parsed.command, context);

    if (result.kind === "streamTaskLogs") {
      process.stdout.write(`${formatCommandResult(result)}\n`);
      await streamTaskLogs(result.logPath);
      return 0;
    }

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
