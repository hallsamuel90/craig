import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { taskService } from "../src/domain/task/index.js";
const { commitTask, closeTask, runChecks, showTask, listTasks } = taskService;
const { discoverOrRefresh: discoverOrRefreshPullRequest, discoverOrRefreshAll: discoverOrRefreshAllProjectPullRequests, discoverOrRefreshMany: discoverOrRefreshPullRequests, refreshChecks: refreshPullRequestChecks } = taskService.prs;
import { readTask } from "../src/domain/task/adapters/task-store.js";
import { runCommand } from "../src/shared/exec.js";
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
  CRAIG_TEST_GH_GRAPHQL_FILE: process.env.CRAIG_TEST_GH_GRAPHQL_FILE,
  CRAIG_TEST_GH_EXPECT_SELECTOR: process.env.CRAIG_TEST_GH_EXPECT_SELECTOR,
  CRAIG_TEST_GH_EXPECT_GRAPHQL_SELECTOR: process.env.CRAIG_TEST_GH_EXPECT_GRAPHQL_SELECTOR,
  CRAIG_GH_RATE_LIMIT_RETRY_BASE_MS: process.env.CRAIG_GH_RATE_LIMIT_RETRY_BASE_MS,
  CRAIG_TEST_GH_VIEW_FILE: process.env.CRAIG_TEST_GH_VIEW_FILE,
  CRAIG_TEST_TMUX_STATE_FILE: process.env.CRAIG_TEST_TMUX_STATE_FILE,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  process.env.PATH = originalPath;
  process.env.CRAIG_TEST_GH_MODE = originalEnv.CRAIG_TEST_GH_MODE;
  process.env.CRAIG_TEST_GH_PR_NUMBER = originalEnv.CRAIG_TEST_GH_PR_NUMBER;
  process.env.CRAIG_TEST_GH_PR_URL = originalEnv.CRAIG_TEST_GH_PR_URL;
  process.env.CRAIG_TEST_GH_GRAPHQL_FILE = originalEnv.CRAIG_TEST_GH_GRAPHQL_FILE;
  restoreOptionalEnv("CRAIG_TEST_GH_EXPECT_SELECTOR", originalEnv.CRAIG_TEST_GH_EXPECT_SELECTOR);
  restoreOptionalEnv("CRAIG_TEST_GH_EXPECT_GRAPHQL_SELECTOR", originalEnv.CRAIG_TEST_GH_EXPECT_GRAPHQL_SELECTOR);
  process.env.CRAIG_GH_RATE_LIMIT_RETRY_BASE_MS = originalEnv.CRAIG_GH_RATE_LIMIT_RETRY_BASE_MS;
  process.env.CRAIG_TEST_GH_VIEW_FILE = originalEnv.CRAIG_TEST_GH_VIEW_FILE;
  process.env.CRAIG_TEST_TMUX_STATE_FILE = originalEnv.CRAIG_TEST_TMUX_STATE_FILE;
});

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

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

  test("discoverOrRefreshPullRequest records an externally-created PR by branch", async () => {
    const repoRoot = await createRepoRoot("craig-pr-discover-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 21,
        url: "https://github.com/example/repo/pull/21",
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
    });

    const result = await discoverOrRefreshPullRequest(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(result.disposition).toBe("discovered");
    expect(task.prs[0]?.number).toBe(21);
    expect(task.prs[0]?.url).toBe("https://github.com/example/repo/pull/21");
    expect(task.prs[0]?.lastSyncedHeadSha).toBe(headSha);
    expect(task.status).toBe("merge_ready");
  });

  test("discoverOrRefreshPullRequests batches tasks that share a GitHub repository", async () => {
    const repoRoot = await createRepoRoot("craig-pr-batch-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    await runCommand("git", ["remote", "set-url", "origin", "https://github.com/example/repo.git"], { cwd: worktreePath });

    const taskOne = await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "checked",
      worktreePath,
      branch: "craig/task_1",
      lastCommit: {
        sha: "task-one-local",
        message: "task one",
        committedAt: "2026-05-01T00:00:00.000Z",
      },
    });
    const taskTwo = await writeTaskRecord(paths.repoRoot, {
      id: "task_2",
      status: "checked",
      worktreePath,
      branch: "craig/task_2",
      lastCommit: {
        sha: "task-two-local",
        message: "task two",
        committedAt: "2026-05-01T00:00:00.000Z",
      },
    });
    const graphqlFile = path.join(repoRoot, "gh-graphql.json");
    await writeFile(
      graphqlFile,
      JSON.stringify({
        data: {
          repository: {
            item0: {
              nodes: [
                {
                  number: 31,
                  url: "https://github.com/example/repo/pull/31",
                  baseRefName: "main",
                  headRefName: "craig/task_1",
                  headRefOid: "task-one-remote",
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  statusCheckRollup: {
                    contexts: {
                      nodes: [{ context: "ci", state: "SUCCESS" }],
                    },
                  },
                },
              ],
            },
            item1: {
              nodes: [
                {
                  number: 32,
                  url: "https://github.com/example/repo/pull/32",
                  baseRefName: "main",
                  headRefName: "craig/task_2",
                  headRefOid: "task-two-remote",
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  statusCheckRollup: {
                    contexts: {
                      nodes: [{ context: "lint", state: "SUCCESS" }],
                    },
                  },
                },
              ],
            },
          },
        },
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_GRAPHQL_FILE = graphqlFile;

    const results = await discoverOrRefreshPullRequests(paths, [taskOne, taskTwo]);

    expect(results.map((result) => `${result.taskId}:${result.discovered}`)).toEqual(["task_1:1", "task_2:1"]);
    expect((await readTask(paths, "task_1")).prs[0]?.number).toBe(31);
    expect((await readTask(paths, "task_2")).prs[0]?.number).toBe(32);
  });

  test("discoverOrRefreshPullRequests retries a rate-limited batch request", async () => {
    const repoRoot = await createRepoRoot("craig-pr-batch-retry-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_GH_MODE = "graphql-rate-limit-once";
    process.env.CRAIG_GH_RATE_LIMIT_RETRY_BASE_MS = "1";
    await runCommand("git", ["remote", "set-url", "origin", "https://github.com/example/repo.git"], { cwd: worktreePath });

    const task = await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "checked",
      worktreePath,
      branch: "craig/task_1",
    });
    const graphqlFile = path.join(repoRoot, "gh-graphql-retry.json");
    await writeFile(
      graphqlFile,
      JSON.stringify({
        data: {
          repository: {
            item0: {
              nodes: [
                {
                  number: 33,
                  url: "https://github.com/example/repo/pull/33",
                  baseRefName: "main",
                  headRefName: "craig/task_1",
                  headRefOid: "task-one-remote",
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  statusCheckRollup: {
                    contexts: {
                      nodes: [{ context: "ci", state: "SUCCESS" }],
                    },
                  },
                },
              ],
            },
          },
        },
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_GRAPHQL_FILE = graphqlFile;

    const results = await discoverOrRefreshPullRequests(paths, [task]);

    expect(results[0]?.discovered).toBe(1);
    expect((await readTask(paths, "task_1")).prs[0]?.number).toBe(33);
    expect(await readFile(path.join(stubDir, ".graphql-attempts"), "utf8")).toBe("2");
  });

  test("discoverOrRefreshPullRequest does not resurrect a closed task", async () => {
    const repoRoot = await createRepoRoot("craig-pr-closed-refresh-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 22,
        url: "https://github.com/example/repo/pull/22",
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
      status: "closed",
      branch: "craig/task_1",
      worktreePath,
    });

    const result = await discoverOrRefreshPullRequest(paths, "task_1");
    const task = await readTask(paths, "task_1");
    const visibleTasks = await listTasks(paths);

    expect(result.disposition).toBe("discovered");
    expect(task.status).toBe("closed");
    expect(task.prs[0]?.number).toBe(22);
    expect(task.prs[0]?.lastSyncedHeadSha).toBe(headSha);
    expect(visibleTasks.tasks).toEqual([]);
  });

  test("discoverOrRefreshPullRequest leaves task unchanged when no branch PR exists", async () => {
    const repoRoot = await createRepoRoot("craig-pr-discover-miss-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_GH_MODE = "no-pr";

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "checked",
      branch: "craig/task_1",
      worktreePath,
    });

    const result = await discoverOrRefreshPullRequest(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(result.disposition).toBe("not_found");
    expect(task.prs).toHaveLength(0);
    expect(task.status).toBe("checked");
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
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "open",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_1",
        mergeable: false,
        mergeStateStatus: "UNKNOWN",
        requiredChecks: [{ name: "ci", status: "pending", conclusion: null }],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "abc1234",
      }],
    });

    await refreshPullRequestChecks(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(task.status).toBe("merge_ready");
    expect(task.prs[0]?.requiredChecks.map((check) => `${check.name}:${check.status}`)).toEqual([
      "ci:success",
      "docs:skipped",
    ]);
    expect(task.prs[0]?.lastSyncedHeadSha).toBe("remote123");
  });

  test("refreshPullRequestChecks discovers by branch when no PR is tracked", async () => {
    const repoRoot = await createRepoRoot("craig-pr-refresh-no-pr-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_GH_MODE = "";
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
        statusCheckRollup: [],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;
    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "checked",
      branch: "craig/task_1",
      worktreePath,
    });

    const task = await refreshPullRequestChecks(paths, "task_1");
    expect(task.prs[0]?.number).toBe(17);
    expect((await readTask(paths, "task_1")).prs[0]?.number).toBe(17);
  });

  test("discoverOrRefreshAllProjectPullRequests refreshes target PRs and parent status", async () => {
    const workspaceRoot = await createRepoRoot("craig-project-pr-refresh-");
    tempRoots.push(workspaceRoot);
    const paths = await createCraigState(workspaceRoot);
    const stubDir = await createStubCommands(workspaceRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const taskWorktree = path.join(paths.worktreesDir, "project", "task_1");
    const targetWorktree = path.join(paths.worktreesDir, "project", "task_1", "repo_a");
    await mkdir(taskWorktree, { recursive: true });
    await mkdir(targetWorktree, { recursive: true });
    const viewFile = path.join(workspaceRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 51,
        url: "https://github.com/example/repo-a/pull/51",
        baseRefName: "main",
        headRefName: "craig/task_1/repo_a",
        headRefOid: "abc51",
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
      type: "project",
      status: "checked",
      worktreePath: taskWorktree,
      repoTargets: [
        {
          repoId: "repo_a",
          branch: "craig/task_1/repo_a",
          repoRoot: path.join(workspaceRoot, "repo-a"),
          worktreePath: targetWorktree,
          status: "ready",
          failureReason: null,
          checks: { source: { type: "repo_config", path: ".craig/config.json" }, lastRunAt: null, status: "not_run", commands: [], results: [] },
          lastCommit: null,
          pullRequest: {
            provider: "github",
            number: null,
            url: null,
            baseBranch: null,
            headBranch: null,
            status: null,
            mergeable: false,
            mergeStateStatus: null,
            requiredChecks: [],
            lastSyncedAt: null,
            lastSyncedHeadSha: null,
          },
          cleanup: { paneClosedAt: null, worktreeRemovedAt: null, preservedWorktree: false, warning: null },
        },
      ],
    });

    const counts = await discoverOrRefreshAllProjectPullRequests(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(counts).toEqual({ synced: 0, discovered: 1, notFound: 0 });
    expect(task.status).toBe("merge_ready");
    expect(task.repoTargets?.[0]?.pullRequest.number).toBe(51);
    expect(task.repoTargets?.[0]?.pullRequest.requiredChecks.map((check) => `${check.name}:${check.status}`)).toEqual(["ci:success"]);
  });

  test("refreshPullRequestChecks refreshes project target PRs", async () => {
    const workspaceRoot = await createRepoRoot("craig-project-check-refresh-");
    tempRoots.push(workspaceRoot);
    const paths = await createCraigState(workspaceRoot);
    const stubDir = await createStubCommands(workspaceRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    const taskWorktree = path.join(paths.worktreesDir, "project", "task_1");
    const targetWorktree = path.join(paths.worktreesDir, "project", "task_1", "repo_a");
    await mkdir(taskWorktree, { recursive: true });
    await mkdir(targetWorktree, { recursive: true });
    const viewFile = path.join(workspaceRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 52,
        url: "https://github.com/example/repo-a/pull/52",
        baseRefName: "main",
        headRefName: "craig/task_1",
        headRefOid: "abc52",
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
      type: "project",
      status: "pr_open",
      worktreePath: taskWorktree,
      selectedRepoTargetId: "repo_a",
      repoTargets: [
        {
          repoId: "repo_a",
          branch: "craig/task_1",
          repoRoot: path.join(workspaceRoot, "repo-a"),
          worktreePath: targetWorktree,
          status: "ready",
          failureReason: null,
          checks: { source: { type: "repo_config", path: ".craig/config.json" }, lastRunAt: null, status: "not_run", commands: [], results: [] },
          lastCommit: null,
          pullRequest: {
            provider: "github",
            number: 52,
            url: "https://github.com/example/repo-a/pull/52",
            baseBranch: "main",
            headBranch: "craig/task_1",
            status: "open",
            mergeable: false,
            mergeStateStatus: "UNKNOWN",
            requiredChecks: [{ name: "ci", status: "pending", conclusion: null }],
            lastSyncedAt: "2026-04-21T00:00:00.000Z",
            lastSyncedHeadSha: null,
          },
          cleanup: { paneClosedAt: null, worktreeRemovedAt: null, preservedWorktree: false, warning: null },
        },
      ],
    });

    const task = await refreshPullRequestChecks(paths, "task_1");

    expect(task.status).toBe("merge_ready");
    expect(task.repoTargets?.[0]?.pullRequest.number).toBe(52);
    expect(task.repoTargets?.[0]?.pullRequest.requiredChecks.map((check) => `${check.name}:${check.status}`)).toEqual(["ci:success"]);
  });

  test("discoverOrRefreshAllProjectPullRequests surfaces tracked target refresh failures", async () => {
    const workspaceRoot = await createRepoRoot("craig-project-pr-refresh-fail-");
    tempRoots.push(workspaceRoot);
    const paths = await createCraigState(workspaceRoot);
    const stubDir = await createStubCommands(workspaceRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_GH_MODE = "no-pr";
    const taskWorktree = path.join(paths.worktreesDir, "project", "task_1");
    const targetWorktree = path.join(paths.worktreesDir, "project", "task_1", "repo_a");
    await mkdir(taskWorktree, { recursive: true });
    await mkdir(targetWorktree, { recursive: true });
    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      type: "project",
      status: "pr_open",
      worktreePath: taskWorktree,
      repoTargets: [
        {
          repoId: "repo_a",
          branch: "craig/task_1",
          repoRoot: path.join(workspaceRoot, "repo-a"),
          worktreePath: targetWorktree,
          status: "ready",
          failureReason: null,
          checks: { source: { type: "repo_config", path: ".craig/config.json" }, lastRunAt: null, status: "not_run", commands: [], results: [] },
          lastCommit: null,
          pullRequest: {
            provider: "github",
            number: 52,
            url: "https://github.com/example/repo-a/pull/52",
            baseBranch: "main",
            headBranch: "craig/task_1",
            status: "open",
            mergeable: false,
            mergeStateStatus: "UNKNOWN",
            requiredChecks: [],
            lastSyncedAt: "2026-04-21T00:00:00.000Z",
            lastSyncedHeadSha: null,
          },
          cleanup: { paneClosedAt: null, worktreeRemovedAt: null, preservedWorktree: false, warning: null },
        },
      ],
    });

    await expect(discoverOrRefreshAllProjectPullRequests(paths, "task_1")).rejects.toThrow(/no pull requests found/);
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
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "open",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_1",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: remoteHeadSha,
      }],
      lastCommit: {
        sha: localHeadSha,
        message: "local only",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    await showTask(paths, "task_1");

    const task = await readTask(paths, "task_1");
    expect(localHeadSha).not.toBe(remoteHeadSha);
    expect(task.prs[0]?.lastSyncedHeadSha).toBe(remoteHeadSha);
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
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "merged",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_1",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "abc1234",
      }],
    });

    await closeTask(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(task.status).toBe("closed");
    expect(task.prs[0]?.number).toBe(17);
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
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "merged",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_1",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "abc1234",
      }],
    });

    await closeTask(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(task.status).toBe("closed");
    expect(task.cleanup.preservedWorktree).toBe(false);
    expect(task.cleanup.worktreeRemovedAt).toBe("2026-04-21T00:00:01.000Z");
  });

  test("closeTask archives unmerged tasks and preserves their worktree", async () => {
    const repoRoot = await createRepoRoot("craig-close-task-unmerged-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, "README.md"), "kept\n", "utf8");
    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "merge_ready",
      worktreePath,
    });

    await closeTask(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(task.status).toBe("closed");
    expect(task.cleanup.preservedWorktree).toBe(true);
    await expect(readFile(path.join(worktreePath, "README.md"), "utf8")).resolves.toContain("kept");
  });

  test("refreshTrackedPullRequest discovers a new PR when the current primary is merged", async () => {
    const repoRoot = await createRepoRoot("craig-pr-sequential-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;

    // Stub gh to return a new open PR (#22) when discovery runs
    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 22,
        url: "https://github.com/example/repo/pull/22",
        baseRefName: "main",
        headRefName: "craig/task_1",
        headRefOid: "newsha123",
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
      status: "merged",
      branch: "craig/task_1",
      worktreePath,
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 21,
        url: "https://github.com/example/repo/pull/21",
        title: null,
        status: "merged",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_1",
        mergeable: false,
        mergeStateStatus: "UNKNOWN",
        requiredChecks: [],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "oldsha456",
      }],
    });

    const { taskService: ts } = await import("../src/domain/task/index.js");
    await ts.prs.refresh(paths, "task_1");
    const task = await readTask(paths, "task_1");

    // Original merged PR preserved, new PR appended
    expect(task.prs).toHaveLength(2);
    expect(task.prs[0]?.number).toBe(21);
    expect(task.prs[0]?.status).toBe("merged");
    expect(task.prs[1]?.number).toBe(22);
    expect(task.prs[1]?.status).toBe("open");
  });

  test("refreshTrackedPullRequest discovers a new PR from the current worktree branch", async () => {
    const repoRoot = await createRepoRoot("craig-pr-current-branch-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    await runCommand("git", ["switch", "-c", "agent/follow-up"], { cwd: worktreePath });

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 42,
        url: "https://github.com/example/repo/pull/42",
        baseRefName: "main",
        headRefName: "agent/follow-up",
        headRefOid: "followupsha",
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [],
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_VIEW_FILE = viewFile;
    process.env.CRAIG_TEST_GH_EXPECT_SELECTOR = "agent/follow-up";

    await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "merged",
      branch: "craig/task_1",
      worktreePath,
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 21,
        url: "https://github.com/example/repo/pull/21",
        title: null,
        status: "merged",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_1",
        mergeable: false,
        mergeStateStatus: "UNKNOWN",
        requiredChecks: [],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "oldsha456",
      }],
    });

    const { taskService: ts } = await import("../src/domain/task/index.js");
    await ts.prs.refresh(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(task.prs).toHaveLength(2);
    expect(task.prs[0]?.number).toBe(21);
    expect(task.prs[0]?.status).toBe("merged");
    expect(task.prs[1]?.number).toBe(42);
    expect(task.prs[1]?.status).toBe("open");
    expect(task.prs[1]?.headBranch).toBe("agent/follow-up");
  });

  test("background polling discovers a new PR from the current worktree branch", async () => {
    const repoRoot = await createRepoRoot("craig-pr-poll-current-branch-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;
    await runCommand("git", ["remote", "set-url", "origin", "https://github.com/example/repo.git"], { cwd: worktreePath });
    await runCommand("git", ["switch", "-c", "agent/polled-follow-up"], { cwd: worktreePath });

    const graphqlFile = path.join(repoRoot, "gh-graphql.json");
    await writeFile(
      graphqlFile,
      JSON.stringify({
        data: {
          repository: {
            item0: {
              nodes: [{
                number: 43,
                url: "https://github.com/example/repo/pull/43",
                baseRefName: "main",
                headRefName: "agent/polled-follow-up",
                headRefOid: "polledsha",
                state: "OPEN",
                isDraft: false,
                title: "Follow-up",
                createdAt: null,
                updatedAt: null,
                mergedAt: null,
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: null,
                statusCheckRollup: { contexts: { nodes: [] } },
                commits: { nodes: [] },
                comments: { nodes: [] },
              }],
            },
          },
        },
      }),
      "utf8",
    );
    process.env.CRAIG_TEST_GH_GRAPHQL_FILE = graphqlFile;
    process.env.CRAIG_TEST_GH_EXPECT_GRAPHQL_SELECTOR = "agent/polled-follow-up";

    const originalTask = await writeTaskRecord(paths.repoRoot, {
      id: "task_1",
      status: "merged",
      branch: "craig/task_1",
      worktreePath,
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 21,
        url: "https://github.com/example/repo/pull/21",
        title: null,
        status: "merged",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_1",
        mergeable: false,
        mergeStateStatus: "UNKNOWN",
        requiredChecks: [],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "oldsha456",
      }],
    });

    await discoverOrRefreshPullRequests(paths, [originalTask]);
    const task = await readTask(paths, "task_1");

    expect(task.prs).toHaveLength(2);
    expect(task.prs[0]?.number).toBe(21);
    expect(task.prs[0]?.status).toBe("merged");
    expect(task.prs[1]?.number).toBe(43);
    expect(task.prs[1]?.status).toBe("open");
    expect(task.prs[1]?.headBranch).toBe("agent/polled-follow-up");
  });

  test("refreshPullRequestChecks discovers a new PR when current primary is closed", async () => {
    const repoRoot = await createRepoRoot("craig-pr-checks-terminal-");
    tempRoots.push(repoRoot);
    const { paths, worktreePath, stubDir } = await createTrackedTaskRepo(repoRoot);
    process.env.PATH = `${stubDir}:${originalPath}`;

    const viewFile = path.join(repoRoot, "gh-view.json");
    await writeFile(
      viewFile,
      JSON.stringify({
        number: 33,
        url: "https://github.com/example/repo/pull/33",
        baseRefName: "main",
        headRefName: "craig/task_1",
        headRefOid: "freshsha789",
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
      status: "pr_open",
      branch: "craig/task_1",
      worktreePath,
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 30,
        url: "https://github.com/example/repo/pull/30",
        title: null,
        status: "closed",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_1",
        mergeable: false,
        mergeStateStatus: "UNKNOWN",
        requiredChecks: [],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "closedsha",
      }],
    });

    await refreshPullRequestChecks(paths, "task_1");
    const task = await readTask(paths, "task_1");

    expect(task.prs).toHaveLength(2);
    expect(task.prs[0]?.number).toBe(30);
    expect(task.prs[0]?.status).toBe("closed");
    expect(task.prs[1]?.number).toBe(33);
    expect(task.prs[1]?.status).toBe("open");
    expect(task.status).toBe("merge_ready");
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
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 21,
        url: "https://github.com/example/repo/pull/21",
        title: null,
        status: "open",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_1",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-04-21T00:00:00.000Z",
        lastSyncedHeadSha: "abc1234",
      }],
    });

    const result = await showTask(paths, "task_1");

    expect(result.task.prs[0]?.mergeable).toBe(false);
    expect(result.task.prs[0]?.mergeStateStatus).toBe("DIRTY");
    expect(result.inspection.prSummary).toContain("mergeable=false");
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
