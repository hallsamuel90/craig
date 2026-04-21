import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { executeCommand } from "../src/commands/command-router.js";
import { parseArgv } from "../src/commands/parse-argv.js";
import { parseReplCommand } from "../src/commands/parse-repl.js";
import { getCraigPaths } from "../src/state/craig-paths.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
    }),
  );
});

describe("command routing", () => {
  test("argv and REPL list commands normalize to the same command", () => {
    expect(parseArgv(["task", "list"]).command).toEqual({ kind: "listTasks" });
    expect(parseArgv(["--", "task", "list"]).command).toEqual({ kind: "listTasks" });
    expect(parseReplCommand("list")).toEqual({ kind: "listTasks" });
  });

  test("shared executor handles list commands from both entry points", async () => {
    const repoRoot = await createRepoRoot();
    const paths = await createCraigState(repoRoot);

    const argvCommand = parseArgv(["task", "list"]).command;
    const replCommand = parseReplCommand("list");

    const argvResult = await executeCommand(argvCommand!, { paths });
    const replResult = await executeCommand(replCommand, { paths });

    expect(argvResult).toEqual(replResult);
  });

  test("unknown commands are rejected in both parsing flows", () => {
    expect(() => parseArgv(["task", "unknown"])).toThrow(/Unsupported command/);
    expect(() => parseReplCommand("wat")).toThrow(/Unknown command/);
  });
});

async function createRepoRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "craig-router-"));
  tempRoots.push(root);
  return root;
}

async function createCraigState(repoRoot: string) {
  const paths = getCraigPaths(repoRoot);

  await mkdir(paths.craigDir, { recursive: true });
  await Promise.all([
    mkdir(paths.tasksDir, { recursive: true }),
    mkdir(paths.jobsDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.artifactsDir, { recursive: true }),
    mkdir(paths.worktreesDir, { recursive: true }),
  ]);
  await writeFile(
    paths.indexFile,
    JSON.stringify(
      {
        version: 1,
        repoRoot,
        taskIds: [],
        jobIds: [],
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
      null,
      2,
    ),
  );

  return paths;
}
