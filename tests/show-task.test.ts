import { mkdir, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { showTask } from "../src/services/show-task.js";
import { createCraigState, createRepoRoot, createStubCommands, writeTaskRecord } from "./test-helpers.js";

const tempRoots: string[] = [];
const originalPath = process.env.PATH ?? "";
const originalGhMode = process.env.CRAIG_TEST_GH_MODE;
const originalGhPrNumber = process.env.CRAIG_TEST_GH_PR_NUMBER;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  process.env.PATH = originalPath;
  process.env.CRAIG_TEST_GH_MODE = originalGhMode;
  process.env.CRAIG_TEST_GH_PR_NUMBER = originalGhPrNumber;
});

describe("showTask", () => {
  test("loads a valid task and reports inspection details", async () => {
    const repoRoot = await createRepoRoot("craig-show-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = `${repoRoot}/worktree`;
    const stubDir = await createStubCommands(repoRoot);

    await mkdir(worktreePath, { recursive: true });
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(`${paths.logsDir}/task_1.log`, "runner output\n", "utf8");
    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_GH_MODE = "success";
    process.env.CRAIG_TEST_GH_PR_NUMBER = "12";
    await writeTaskRecord(repoRoot, {
      id: "task_1",
      title: "inspect me",
      worktreePath,
      checks: {
        source: { type: "repo_config", path: ".craig/config.json" },
        lastRunAt: null,
        status: "not_run",
        commands: ["pnpm test"],
        results: [],
      },
      pullRequest: {
        provider: "github",
        number: 12,
        url: "https://github.com/example/repo/pull/12",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "open",
        mergeable: false,
        mergeStateStatus: "BLOCKED",
        requiredChecks: [{ name: "ci", status: "pending", conclusion: null }],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "abc1234",
      },
    });

    const result = await showTask(paths, "task_1");

    expect(result.task.id).toBe("task_1");
    expect(result.inspection.worktreeExists).toBe(true);
    expect(result.inspection.logExists).toBe(true);
    expect(result.inspection.runnerCommandText).toBe("codex inspect me");
    expect(result.inspection.checksSummary).toBe("not_run (1 command)");
    expect(result.inspection.prSummary).toContain("#12 open");
  });

  test("reports a missing task with a user-facing error", async () => {
    const repoRoot = await createRepoRoot("craig-show-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);

    await expect(showTask(paths, "missing")).rejects.toThrow('Craig task "missing" was not found.');
  });

  test("surfaces missing worktree and log warnings without throwing", async () => {
    const repoRoot = await createRepoRoot("craig-show-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);

    await writeTaskRecord(repoRoot, {
      id: "task_1",
      worktreePath: `${repoRoot}/missing-worktree`,
      artifacts: {
        logPath: ".craig/logs/task_1.log",
        checkSummaryPath: ".craig/artifacts/task_1/check-summary.json",
        prDraftPath: null,
        prStatusPath: ".craig/artifacts/task_1/pr-status.json",
      },
      lastFailureReason: "cursor launch failed",
    });

    const result = await showTask(paths, "task_1");

    expect(result.inspection.worktreeExists).toBe(false);
    expect(result.inspection.logExists).toBe(false);
    expect(result.inspection.recentFailureReason).toBe("cursor launch failed");
  });
});
