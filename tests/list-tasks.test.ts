import { rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";

import { listTasks } from "../src/services/list-tasks.js";
import { createCraigState, createRepoRoot } from "./test-helpers.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe("listTasks", () => {
  test("returns an empty task list for an empty index", async () => {
    const repoRoot = await createRepoRoot("craig-list-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot, []);

    const result = await listTasks(paths);

    expect(result.tasks).toEqual([]);
    expect(result.missingTaskIds).toEqual([]);
  });

  test("reports missing task files without failing the list", async () => {
    const repoRoot = await createRepoRoot("craig-list-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot, ["task_1"]);

    const result = await listTasks(paths);

    expect(result.tasks).toEqual([]);
    expect(result.missingTaskIds).toEqual(["task_1"]);
  });

  test("loads legacy task records that predate runner-session metadata", async () => {
    const repoRoot = await createRepoRoot("craig-list-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot, ["task_1"]);

    await writeFile(
      `${paths.tasksDir}/task_1.json`,
      JSON.stringify(
        {
          id: "task_1",
          title: "legacy task",
          slug: "legacy-task",
          type: "repo",
          status: "running",
          runner: "cursor",
          repoRoot,
          worktreePath: `${paths.worktreesDir}/task_1`,
          branch: "craig/task_1",
          prompt: {
            source: "inline",
            value: "legacy task",
          },
          checks: {
            source: {
              type: "repo_config",
              path: ".craig/config.json",
            },
            lastRunAt: null,
            status: "not_run",
            commands: [],
          },
          pullRequest: {
            provider: "github",
            number: null,
            url: null,
            baseBranch: null,
            headBranch: null,
            status: null,
            mergeable: false,
            requiredChecks: [],
            lastSyncedAt: null,
          },
          artifacts: {
            logPath: ".craig/logs/task_1.log",
            prDraftPath: null,
            prStatusPath: ".craig/artifacts/task_1/pr-status.json",
          },
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await listTasks(paths);

    expect(result.missingTaskIds).toEqual([]);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.runnerSession).toEqual({
      command: ["cursor", "agent", "legacy task"],
      pid: null,
      startedAt: null,
      lastKnownState: "running",
      exitCode: null,
      exitedAt: null,
    });
  });
});
