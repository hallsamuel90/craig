import { mkdir, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { taskService } from "../src/domain/task/index.js";
import { createCraigState, createGitRepo, createRepoRoot, writeTaskRecord } from "./test-helpers.js";
import { runCommand } from "../src/utils/exec.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("showTaskDiff", () => {
  test("returns an empty diff result when there are no changes", async () => {
    const repoRoot = await createRepoRoot("craig-diff-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = `${repoRoot}/worktree`;

    await mkdir(worktreePath, { recursive: true });
    await createGitRepo(worktreePath);
    await writeFile(`${worktreePath}/tracked.txt`, "hello\n", "utf8");
    await runCommand("git", ["add", "tracked.txt"], { cwd: worktreePath });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: worktreePath });
    await writeTaskRecord(repoRoot, { id: "task_1", worktreePath });

    const result = await taskService.showTaskDiff(paths, "task_1");

    expect(result.isEmpty).toBe(true);
    expect(result.diffText).toBe("");
  });

  test("returns diff text when the worktree has changes", async () => {
    const repoRoot = await createRepoRoot("craig-diff-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = `${repoRoot}/worktree`;

    await mkdir(worktreePath, { recursive: true });
    await createGitRepo(worktreePath);
    await writeFile(`${worktreePath}/tracked.txt`, "hello\n", "utf8");
    await runCommand("git", ["add", "tracked.txt"], { cwd: worktreePath });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: worktreePath });
    await writeFile(`${worktreePath}/tracked.txt`, "hello world\n", "utf8");
    await writeTaskRecord(repoRoot, { id: "task_1", worktreePath });

    const result = await taskService.showTaskDiff(paths, "task_1");

    expect(result.isEmpty).toBe(false);
    expect(result.diffText).toContain("tracked.txt");
    expect(result.diffText).toContain("+hello world");
  });

  test("includes staged changes in the diff output", async () => {
    const repoRoot = await createRepoRoot("craig-diff-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = `${repoRoot}/worktree`;

    await mkdir(worktreePath, { recursive: true });
    await createGitRepo(worktreePath);
    await writeFile(`${worktreePath}/tracked.txt`, "hello\n", "utf8");
    await runCommand("git", ["add", "tracked.txt"], { cwd: worktreePath });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: worktreePath });
    await writeFile(`${worktreePath}/tracked.txt`, "hello staged\n", "utf8");
    await runCommand("git", ["add", "tracked.txt"], { cwd: worktreePath });
    await writeTaskRecord(repoRoot, { id: "task_1", worktreePath });

    const result = await taskService.showTaskDiff(paths, "task_1");

    expect(result.isEmpty).toBe(false);
    expect(result.diffText).toContain("tracked.txt");
    expect(result.diffText).toContain("+hello staged");
  });

  test("includes untracked files in the diff output", async () => {
    const repoRoot = await createRepoRoot("craig-diff-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const worktreePath = `${repoRoot}/worktree`;

    await mkdir(worktreePath, { recursive: true });
    await createGitRepo(worktreePath);
    await writeFile(`${worktreePath}/tracked.txt`, "hello\n", "utf8");
    await runCommand("git", ["add", "tracked.txt"], { cwd: worktreePath });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: worktreePath });
    await writeFile(`${worktreePath}/new-file.txt`, "brand new\n", "utf8");
    await writeTaskRecord(repoRoot, { id: "task_1", worktreePath });

    const result = await taskService.showTaskDiff(paths, "task_1");

    expect(result.isEmpty).toBe(false);
    expect(result.diffText).toContain("new-file.txt");
    expect(result.diffText).toContain("+brand new");
  });

  test("fails when the worktree path is missing", async () => {
    const repoRoot = await createRepoRoot("craig-diff-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);

    await writeTaskRecord(repoRoot, {
      id: "task_1",
      worktreePath: `${repoRoot}/missing-worktree`,
    });

    await expect(taskService.showTaskDiff(paths, "task_1")).rejects.toThrow(/worktree does not exist/);
  });
});
