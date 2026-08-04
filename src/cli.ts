#!/usr/bin/env node

import { getCraigPaths } from "./state/craig-paths.js";
import { runCli } from "./commands/run.js";
import { startTerminalApp } from "./ui/app.js";
import { requestDaemonShutdown, servePtyDaemon } from "./ui/pty/daemon.js";
async function main(): Promise<number> {
  try {
    if (process.argv[2] === "__craig-daemon") {
      const workspaceRoot = process.argv[3] ?? process.cwd();
      const paths = getCraigPaths(workspaceRoot);
      await servePtyDaemon(paths);
      return 0;
    }

    if (process.argv[2] === "__craig-daemon-shutdown") {
      const workspaceRoot = process.argv[3] ?? process.cwd();
      const paths = getCraigPaths(workspaceRoot);
      await requestDaemonShutdown(paths);
      return 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Craig error";
    process.stderr.write(`${message}\n`);
    return 1;
  }

  return runCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    isInputTty: process.stdin.isTTY === true,
    isOutputTty: process.stdout.isTTY === true,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value),
    readStdin: async () => {
      let value = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) value += chunk;
      return value;
    },
    runInteractive: (workspaceRoot) =>
      startTerminalApp({
        uiStateFile: getCraigPaths(workspaceRoot).uiStateFile,
        workspaceRoot,
      }),
  });
}

const exitCode = await main();
process.exit(exitCode);
