#!/usr/bin/env node
import { runtimePreflight } from "./shell/runtime/preflight.js";

import { ensureRuntimeRunning } from "./shell/runtime/start.js";
import { sessionHostRevision } from "./shell/runtime/host-identity.js";

import path from "node:path";
import { readPrivateRecord, writePrivateRecord, workspaceRuntimeId, type RuntimeRecord } from "./shell/runtime/records.js";
import { serveSessionHost } from "./shell/runtime/session-host.js";
import { serveLegacyGuard } from "./shell/runtime/legacy-guard.js";
import { serveSplitControl } from "./shell/runtime/split-control.js";
import { acquireRuntimeLock } from "./shell/runtime/ownership.js";
import { readdir } from "node:fs/promises";
import { realpath } from "node:fs/promises";

import { getCraigPaths } from "./state/craig-paths.js";
import { runCli } from "./commands/run.js";
import { CRAIG_RESTART_EXIT_CODE, restartCraig } from "./shell/craig-update.js";
import { startTerminalApp } from "./ui/app.js";
import { requestDaemonShutdown, servePtyDaemon } from "./ui/pty/daemon.js";
async function main(): Promise<number> {
  try {
    if (process.argv[2] === "__craig-runtime-preflight") {
      process.stdout.write(JSON.stringify(await runtimePreflight(getCraigPaths(await canonicalWorkspaceRoot(process.argv[3] ?? process.cwd())))) + "\n");
      return 0;
    }
    if (process.argv[2] === "__craig-runtime-bootstrap") {
      await ensureRuntimeRunning(getCraigPaths(await canonicalWorkspaceRoot(process.argv[3] ?? process.cwd())));
      return 0;
    }
    if (process.argv[2] === "__craig-runtime-role") {
      const role = process.argv[3];
      const paths = getCraigPaths(await canonicalWorkspaceRoot(process.argv[4] ?? process.cwd()));
      const file = await realpath(path.resolve(process.argv[5] ?? ""));
      if (!file.startsWith(`${paths.runtimeDir}${path.sep}`)) throw new Error("Runtime record is outside this workspace.");
      const record = await readPrivateRecord<RuntimeRecord>(file);
      if (!record || record.role !== role || record.workspaceId !== await workspaceRuntimeId(paths)) throw new Error("Runtime role identity rejected.");
      if (record.role === "host") record.hostRevision = sessionHostRevision();
      record.pid = process.pid; record.startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
      await writePrivateRecord(file, record);
      if (role === "host") await serveSessionHost(paths, record);
      else if (role === "guard") await serveLegacyGuard(paths, record);
      else if (role === "control") {
        const release = await acquireRuntimeLock(paths, "control-owner");
        try {
          const hosts = (await readdir(path.join(paths.runtimeDir, "hosts"))).filter((name) => name.endsWith(".json"));
          if (hosts.length !== 1) throw new Error("Expected one verified host generation.");
          const host = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "hosts", hosts[0]!));
          if (!host) throw new Error("Host discovery missing.");
          await serveSplitControl(paths, record, host);
        } finally { await release(); }
      } else throw new Error("Unknown runtime role.");
      return 0;
    }

    if (process.argv[2] === "__craig-daemon") {
      const workspaceRoot = await canonicalWorkspaceRoot(process.argv[3] ?? process.cwd());
      const paths = getCraigPaths(workspaceRoot);
      await servePtyDaemon(paths);
      return 0;
    }

    if (process.argv[2] === "__craig-daemon-shutdown") {
      const workspaceRoot = await canonicalWorkspaceRoot(process.argv[3] ?? process.cwd());
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
    runInteractive: async (workspaceRoot) => {
      const code = await startTerminalApp({
        uiStateFile: getCraigPaths(workspaceRoot).uiStateFile,
        workspaceRoot,
      });
      if (code !== CRAIG_RESTART_EXIT_CODE) {
        return code;
      }

      try {
        return await restartCraig({
          argv: process.argv.slice(2),
          cwd: process.cwd(),
          env: process.env,
        });
      } catch (error) {
        const message = (error instanceof Error ? error.message : "Unknown restart error")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        process.stderr.write(`Craig updated, but could not restart automatically: ${message}\nRun \`craig\` again to use the new version.\n`);
        return 1;
      }
    },
  });
}

async function canonicalWorkspaceRoot(value: string): Promise<string> {
  return realpath(value);
}

const exitCode = await main();
await Promise.all([process.stdout, process.stderr]
  .filter((stream) => stream.writableLength > 0)
  .map((stream) => new Promise<void>((resolve) => stream.write("", () => resolve()))));
process.exit(exitCode);
