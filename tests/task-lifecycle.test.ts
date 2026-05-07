import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { commitTask } from "../src/services/commit-task.js";
import { closeTask } from "../src/services/close-task.js";
import { mergeTask } from "../src/services/merge-task.js";
import { openPullRequest, refreshPullRequestChecks } from "../src/services/open-pull-request.js";
import { runChecks } from "../src/services/run-checks.js";
import { showTask } from "../src/services/show-task.js";
import { readTask } from "../src/state/task-store.js";
import { runCommand } from "../src/utils/exec.js";
import {
  createCraigState,
  createGitRepo,
  createRepoRoot,
  createStubCommands,
  writeTaskRecord,
} from "./test-helpers.js";

const tempRoots: string[] = [];
const originalPath = process.env.PATH ?? "";
const originalEnv = {
  CRAIG_TEST_GH_MODE: process.env.CRAIG_TEST_GH_MODE,
  CRAIG_TEST_GH_PR_NUMBER: process.env.CRAIG_TEST_GH_PR_NUMBER,
  CRAIG_TEST_GH_PR_URL: process.env.CRAIG_TEST_GH_PR_URL,
  CRAIG_TEST_GH_VIEW_FILE: process.env.CRAIG_TEST_GH_VIEW_FILE,
  CRAIG_TEST_TMUX_STATE_FILE: process.env.CRAIG_TEST_TMUX_STATE_FILE,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  process.env.PATH = originalPath;
  process.env.CRAIG_TEST_GH_MODE = originalEnv.CRAIG_TEST_GH_MODE;
  process.env.CRAIG_TEST_GH_PR_NUMBER = originalEnv.CRAIG_TEST_GH_PR_NUMBER;
  process.env.CRAIG_TEST_GH_PR_URL = originalEnv.CRAIG_TEST_GH_PR_URL;
  process.env.CRAIG_TEST_GH_VIEW_FILE = originalEnv.CRAIG_TEST_GH_VIEW_FILE;
  process.env.CRAIG_TEST_TMUX_STATE_FILE = originalEnv.CRAIG_TEST_TMUX_STATE_FILE;
});

describe("task lifecycle services", () => {
  test("runChecks fails clearly when no checks are configured", async () => {
    const repoRoot = await createRepoRoot("craig-checks-empty-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    await createGitRepo(repoRoot);
    await seedGitRepo(repoRoot);

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "review",
      worktreePath: repoRoot,
    });

    await expect(runChecks(paths, "task_1")).rejects.toThrow(/checks\.commands/);
  });

  test("runChecks persists results and promotes the task to checked", async () => {
    const repoRoot = await createRepoRoot("craig-checks-pass-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    await createGitRepo(repoRoot);
    await seedGitRepo(repoRoot);
    await writeFile(paths.configFile, JSON.stringify({ checks: { commands: ["printf ok"] } }, null, 2), "utf8");

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "review",
      worktreePath: repoRoot,
    });

    const result = await runChecks(paths, "task_1");
    const task = await readTask(paths, "task_1");
    const summary = JSON.parse(
      await readFile(path.join(paths.artifactsDir, "task_1", "check-summary.json"), "utf8"),
    ) as { status: string; results: Array<{ exitCode: number }> };

    expect(result.status).toBe("passed");
    expect(task.status).toBe("checked");
    expect(task.checks.status).toBe("passed");
    expect(task.checks.results).toHaveLength(1);
    expect(summary.status).toBe("passed");
    expect(summary.results[0]?.exitCode).toBe(0);
  });

  test("commitTask uses the task title as the default commit message", async () => {
    const repoRoot = await createRepoRoot("craig-commit-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    await createGitRepo(repoRoot);
    await seedGitRepo(repoRoot);
    await writeFile(path.join(repoRoot, "index.ts"), "export const value = 2;\n", "utf8");

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      title: "ship phase 1.4",
      prompt: { source: "inline", value: "ship phase 1.4" },
      status: "review",
      worktreePath: repoRoot,
    });

    const result = await commitTask(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(result.message).toBe("ship phase 1.4");
    expect(task.lastCommit?.message).toBe("ship phase 1.4");
    expect(task.lastCommit?.sha).toBeTruthy();
  });

  test("openPullRequest creates and refreshes tracked PR state", async () => {
    const repoRoot = await createRepoRoot("craig-pr-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        headRefOid: headSha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ context: "ci", state: "SUCCESS", conclusion: "SUCCESS" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "checked",
      branch: "craig/task_1",
      worktreePath,
      lastCommit: {
        sha: "abc1234",
        message: "ship task",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    const result = await openPullRequest(paths, "task_1", { watch: false });
    const task = await readTask(paths, "task_1");

    expect(result.prNumber).toBe(17);
    expect(task.pullRequest.number).toBe(17);
    expect(task.status).toBe("merge_ready");
    expect(task.pullRequest.requiredChecks[0]?.status).toBe("success");
    expect(task.pullRequest.lastSyncedHeadSha).toBe(headSha);
  });

  test("openPullRequest treats skipped required checks as non-blocking but distinct", async () => {
    const repoRoot = await createRepoRoot("craig-pr-skipped-checks-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ context: "ci", state: "COMPLETED", conclusion: "SKIPPED" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "checked",
      branch: "craig/task_1",
      worktreePath,
      lastCommit: {
        sha: "abc1234",
        message: "ship task",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    const result = await openPullRequest(paths, "task_1", { watch: false });
    const task = await readTask(paths, "task_1");

    expect(result.status).toBe("merge_ready");
    expect(task.status).toBe("merge_ready");
    expect(task.pullRequest.requiredChecks[0]?.status).toBe("skipped");
  });

  test("openPullRequest treats GitHub check runs with in-progress status as pending", async () => {
    const repoRoot = await createRepoRoot("craig-pr-checkrun-pending-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "UNSTABLE",
        statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS", conclusion: "" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "checked",
      branch: "craig/task_1",
      worktreePath,
      lastCommit: {
        sha: "abc1234",
        message: "ship task",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    const result = await openPullRequest(paths, "task_1", { watch: false });
    const task = await readTask(paths, "task_1");

    expect(result.status).toBe("pr_open");
    expect(task.status).toBe("pr_open");
    expect(task.pullRequest.requiredChecks[0]?.name).toBe("ci");
    expect(task.pullRequest.requiredChecks[0]?.status).toBe("pending");
  });

  test("openPullRequest preserves failed and unknown GitHub check states distinctly", async () => {
    const repoRoot = await createRepoRoot("craig-pr-check-states-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "UNSTABLE",
        statusCheckRollup: [
          { context: "ci", state: "FAILURE", conclusion: "FAILURE" },
          { context: "build", state: "COMPLETED", conclusion: "STARTUP_FAILURE" },
          { context: "coverage", state: "MYSTERY", conclusion: null },
        ],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "checked",
      branch: "craig/task_1",
      worktreePath,
      lastCommit: {
        sha: "abc1234",
        message: "ship task",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    const result = await openPullRequest(paths, "task_1", { watch: false });
    const task = await readTask(paths, "task_1");

    expect(result.status).toBe("pr_open");
    expect(task.status).toBe("pr_open");
    expect(task.pullRequest.requiredChecks.map((check) => check.status)).toEqual(["failed", "failed", "unknown"]);
  });

  test("refreshPullRequestChecks refreshes existing PR checks without pushing or creating", async () => {
    const repoRoot = await createRepoRoot("craig-pr-refresh-checks-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        headRefOid: "remote123",
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { context: "ci", state: "SUCCESS", conclusion: "SUCCESS" },
          { context: "docs", state: "COMPLETED", conclusion: "SKIPPED" },
        ],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "pr_open",
      branch: "craig/task_1",
      worktreePath,
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "open",
        mergeable: false,
        mergeStateStatus: "UNKNOWN",
        requiredChecks: [{ name: "ci", status: "pending", conclusion: null }],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "abc1234",
      },
    });

    await refreshPullRequestChecks(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(task.status).toBe("merge_ready");
    expect(task.pullRequest.requiredChecks.map((check) => `${check.name}:${check.status}`)).toEqual([
      "ci:success",
      "docs:skipped",
    ]);
    expect(task.pullRequest.lastSyncedHeadSha).toBe("remote123");
  });

  test("refreshPullRequestChecks fails clearly when no PR is tracked", async () => {
    const repoRoot = await createRepoRoot("craig-pr-refresh-no-pr-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    await mkdir(path.join(repoRoot, "worktree"), { recursive: true });
    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "checked",
      worktreePath: path.join(repoRoot, "worktree"),
    });

    await expect(refreshPullRequestChecks(paths, "task_1")).rejects.toThrow(/no tracked PR/);
    expect((await readTask(paths, "task_1")).pullRequest.number).toBeNull();
  });

  test("openPullRequest pushes new commits when refreshing an existing PR", async () => {
    const repoRoot = await createRepoRoot("craig-pr-refresh-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir, remoteRepo } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ context: "ci", state: "SUCCESS", conclusion: "SUCCESS" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    const initialRemoteSha = (
      await runCommand("git", ["rev-parse", "refs/heads/craig/task_1"], { cwd: remoteRepo })
    ).stdout.trim();

    await writeFile(path.join(worktreePath, "index.ts"), "export const value = 3;\n", "utf8");
    await runCommand("git", ["add", "-A"], { cwd: worktreePath });
    await runCommand("git", ["commit", "-m", "refresh task"], { cwd: worktreePath });
    const refreshedSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        headRefOid: refreshedSha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ context: "ci", state: "SUCCESS", conclusion: "SUCCESS" }],
      }),
      "utf8",
    );

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "checked",
      branch: "craig/task_1",
      worktreePath,
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "open",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: initialRemoteSha,
      },
      lastCommit: {
        sha: refreshedSha,
        message: "refresh task",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    await openPullRequest(paths, "task_1", { watch: false });

    const finalRemoteSha = (
      await runCommand("git", ["rev-parse", "refs/heads/craig/task_1"], { cwd: remoteRepo })
    ).stdout.trim();

    expect(finalRemoteSha).not.toBe(initialRemoteSha);
    expect(finalRemoteSha).toBe(refreshedSha);
    expect((await readTask(paths, "task_1")).pullRequest.lastSyncedHeadSha).toBe(refreshedSha);
  });

  test("showTask refresh preserves PR head SHA when local worktree has unpushed commits", async () => {
    const repoRoot = await createRepoRoot("craig-pr-passive-refresh-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir, remoteRepo } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const remoteHeadSha = (
      await runCommand("git", ["rev-parse", "refs/heads/craig/task_1"], { cwd: remoteRepo })
    ).stdout.trim();

    await writeFile(path.join(worktreePath, "index.ts"), "export const value = 4;\n", "utf8");
    await runCommand("git", ["add", "-A"], { cwd: worktreePath });
    await runCommand("git", ["commit", "-m", "local only"], { cwd: worktreePath });
    const localHeadSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        headRefOid: remoteHeadSha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "pr_open",
      branch: "craig/task_1",
      worktreePath,
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "open",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: remoteHeadSha,
      },
      lastCommit: {
        sha: localHeadSha,
        message: "local only",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    await showTask(paths, "task_1");

    const task = await readTask(paths, "task_1");
    expect(localHeadSha).not.toBe(remoteHeadSha);
    expect(task.pullRequest.lastSyncedHeadSha).toBe(remoteHeadSha);
  });

  test("mergeTask marks the task merged and preserves the worktree when requested", async () => {
    const repoRoot = await createRepoRoot("craig-merge-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = path.join(repoRoot, "tmux-state");
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        headRefOid: headSha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ context: "ci", state: "SUCCESS", conclusion: "SUCCESS" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "merge_ready",
      branch: "craig/task_1",
      worktreePath,
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "open",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: headSha,
      },
      lastCommit: {
        sha: headSha,
        message: "ship task",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    const result = await mergeTask(paths, "task_1", { preserveWorktree: true });
    const task = await readTask(paths, "task_1");

    expect(result.status).toBe("merged");
    expect(task.status).toBe("merged");
    expect(task.cleanup.preservedWorktree).toBe(true);
    await expect(readFile(path.join(worktreePath, "index.ts"), "utf8")).resolves.toContain("value");
  });

  test("mergeTask blocks stale PR head before merging", async () => {
    const repoRoot = await createRepoRoot("craig-merge-stale-head-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        headRefOid: "remote-old",
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ context: "ci", state: "SUCCESS", conclusion: "SUCCESS" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "merge_ready",
      branch: "craig/task_1",
      worktreePath,
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "open",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: headSha,
      },
      lastCommit: {
        sha: headSha,
        message: "ship task",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    await expect(mergeTask(paths, "task_1", { preserveWorktree: true })).rejects.toThrow(/not synced/);
  });

  test("mergeTask blocks when GitHub reports no checks", async () => {
    const repoRoot = await createRepoRoot("craig-merge-no-checks-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        headRefOid: headSha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "merge_ready",
      branch: "craig/task_1",
      worktreePath,
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "open",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: headSha,
      },
      lastCommit: {
        sha: headSha,
        message: "ship task",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    await expect(mergeTask(paths, "task_1", { preserveWorktree: true })).rejects.toThrow(/no GitHub checks/);
  });

  test("closeTask marks merged tasks closed and preserves recovery metadata", async () => {
    const repoRoot = await createRepoRoot("craig-close-task-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, "README.md"), "kept\n", "utf8");
    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "merged",
      worktreePath,
      cleanup: {
        paneClosedAt: null,
        worktreeRemovedAt: null,
        preservedWorktree: false,
        warning: "previous warning",
      },
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "merged",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "abc1234",
      },
    });

    await closeTask(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(task.status).toBe("closed");
    expect(task.pullRequest.number).toBe(17);
    expect(task.cleanup.preservedWorktree).toBe(true);
    expect(task.cleanup.worktreeRemovedAt).toBeNull();
    await expect(readFile(path.join(worktreePath, "README.md"), "utf8")).resolves.toContain("kept");
  });

  test("closeTask allows already-cleaned merged tasks", async () => {
    const repoRoot = await createRepoRoot("craig-close-cleaned-task-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });
    await rm(worktreePath, { recursive: true, force: true });
    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "merged",
      worktreePath,
      cleanup: {
        paneClosedAt: "2026-04-21T00:00:00.000Z",
        worktreeRemovedAt: "2026-04-21T00:00:01.000Z",
        preservedWorktree: false,
        warning: null,
      },
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "merged",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "abc1234",
      },
    });

    await closeTask(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(task.status).toBe("closed");
    expect(task.cleanup.preservedWorktree).toBe(false);
    expect(task.cleanup.worktreeRemovedAt).toBe("2026-04-21T00:00:01.000Z");
  });

  test("closeTask blocks before merge", async () => {
    const repoRoot = await createRepoRoot("craig-close-task-blocked-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });
    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "merge_ready",
      worktreePath,
    });

    await expect(closeTask(paths, "task_1")).rejects.toThrow(/cannot close/);
  });

  test("mergeTask blocks when GitHub reports an in-progress check run", async () => {
    const repoRoot = await createRepoRoot("craig-merge-pending-checkrun-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        headRefOid: headSha,
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "UNSTABLE",
        statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS", conclusion: "" }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "merge_ready",
      branch: "craig/task_1",
      worktreePath,
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "open",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: headSha,
      },
      lastCommit: {
        sha: headSha,
        message: "ship task",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    await expect(mergeTask(paths, "task_1", { preserveWorktree: false })).rejects.toThrow(/not merge-ready/);

    const task = await readTask(paths, "task_1");
    expect(task.status).toBe("pr_open");
    expect(task.pullRequest.requiredChecks[0]?.status).toBe("pending");
  });

  test("showTask refreshes persisted PR state for tracked tasks", async () => {
    const repoRoot = await createRepoRoot("craig-show-pr-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const stubDir = await createStubCommands(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;

    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 21,
        url: "https://github.com/example/repo/pull/21",
        baseRefName: "main",
        headRefName: "craig/task_1",
        state: "OPEN",
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        statusCheckRollup: [{ context: "ci", state: "PENDING", conclusion: null }],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(repoRoot, {
      id: "task_1",
      worktreePath,
      status: "pr_open",
      pullRequest: {
        provider: "github",
        number: 21,
        url: "https://github.com/example/repo/pull/21",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "open",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "abc1234",
      },
    });

    const result = await showTask(paths, "task_1");

    expect(result.task.pullRequest.mergeable).toBe(false);
    expect(result.task.pullRequest.mergeStateStatus).toBe("DIRTY");
    expect(result.inspection.prSummary).toContain("mergeable=false");
  });

  test("openPullRequest watch exits when the tracked PR is closed", async () => {
    const repoRoot = await createRepoRoot("craig-pr-watch-closed-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    await writeFile(
      paths.configFile,
      JSON.stringify({ github: { watchIntervalSeconds: 1 } }, null, 2),
      "utf8",
    );

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseRefName: "main",
        headRefName: "craig/task_1",
        state: "CLOSED",
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        statusCheckRollup: [],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "pr_open",
      branch: "craig/task_1",
      worktreePath,
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_1",
        status: "open",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [],
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "abc1234",
      },
      lastCommit: {
        sha: "abc1234",
        message: "ship task",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    const result = await openPullRequest(paths, "task_1", { watch: true });
    const task = await readTask(paths, "task_1");

    expect(result.status).toBe("checked");
    expect(task.status).toBe("checked");
    expect(task.pullRequest.status).toBe("closed");
  });
});

async function seedGitRepo(repoRoot: string) {
  await writeFile(path.join(repoRoot, "index.ts"), "export const value = 1;\n", "utf8");
  await runCommand("git", ["add", "index.ts"], { cwd: repoRoot });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: repoRoot });
}

async function createTrackedTaskRepo(repoRoot: string) {
  const mainRepo = path.join(repoRoot, "repo");
  const remoteRepo = await mkdtemp(path.join(os.tmpdir(), "craig-remote-"));
  tempRoots.push(remoteRepo);

  await mkdir(mainRepo, { recursive: true });
  const paths = await createCraigState(mainRepo);
  await createGitRepo(mainRepo);
  await seedGitRepo(mainRepo);
  await runCommand("git", ["init", "--bare", remoteRepo], { cwd: repoRoot });
  await runCommand("git", ["remote", "add", "origin", remoteRepo], { cwd: mainRepo });
  await runCommand("git", ["push", "-u", "origin", "main"], { cwd: mainRepo });

  const worktreePath = path.join(paths.worktreesDir, "task_1");
  await runCommand("git", ["worktree", "add", "-b", "craig/task_1", worktreePath, "main"], { cwd: mainRepo });
  await writeFile(path.join(worktreePath, "index.ts"), "export const value = 2;\n", "utf8");
  await runCommand("git", ["add", "-A"], { cwd: worktreePath });
  await runCommand("git", ["commit", "-m", "ship task"], { cwd: worktreePath });
  await runCommand("git", ["push", "-u", "origin", "craig/task_1"], { cwd: worktreePath });

  const fullStubDir = await createStubCommands(mainRepo);
  const stubDir = await mkdtemp(path.join(os.tmpdir(), "craig-gh-tmux-"));
  tempRoots.push(stubDir);
  await symlink(path.join(fullStubDir, "gh"), path.join(stubDir, "gh"));
  await symlink(path.join(fullStubDir, "tmux"), path.join(stubDir, "tmux"));
  return { paths, worktreePath, stubDir, remoteRepo };
}
