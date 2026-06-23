import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createWorktree } from "../src/domain/task/adapters/git.js";
import { runCommand } from "../src/utils/exec.js";
import { createGitRepo } from "./test-helpers.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("git-task", () => {
  test("createWorktree bases new task branches on fetched origin/main when local main is behind", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "craig-git-task-"));
    tempRoots.push(root);
    const remoteRepo = path.join(root, "remote.git");
    const localRepo = path.join(root, "local");
    const updaterRepo = path.join(root, "updater");
    const worktreePath = path.join(root, "task-worktree");

    await runCommand("git", ["init", "--bare", remoteRepo]);

    await runCommand("git", ["clone", remoteRepo, localRepo]);
    await createGitRepo(localRepo);
    await runCommand("git", ["checkout", "-B", "main"], { cwd: localRepo });
    await writeFile(path.join(localRepo, "README.md"), "base\n", "utf8");
    await runCommand("git", ["add", "README.md"], { cwd: localRepo });
    await runCommand("git", ["commit", "-m", "base"], { cwd: localRepo });
    await runCommand("git", ["push", "-u", "origin", "main"], { cwd: localRepo });

    await runCommand("git", ["clone", "--branch", "main", remoteRepo, updaterRepo]);
    await runCommand("git", ["config", "user.name", "Craig Tests"], { cwd: updaterRepo });
    await runCommand("git", ["config", "user.email", "craig@example.com"], { cwd: updaterRepo });
    await writeFile(path.join(updaterRepo, "README.md"), "base\nremote update\n", "utf8");
    await runCommand("git", ["add", "README.md"], { cwd: updaterRepo });
    await runCommand("git", ["commit", "-m", "remote update"], { cwd: updaterRepo });
    await runCommand("git", ["push", "origin", "main"], { cwd: updaterRepo });

    await createWorktree(localRepo, "craig/task_1", worktreePath);

    const worktreeHead = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
    const remoteHead = (await runCommand("git", ["rev-parse", "origin/main"], { cwd: worktreePath })).stdout.trim();
    const readme = await runCommand("git", ["show", "HEAD:README.md"], { cwd: worktreePath });

    expect(worktreeHead).toBe(remoteHead);
    expect(readme.stdout).toContain("remote update");
  });

  test("createWorktree uses the requested base branch when the repo does not have local main", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "craig-git-task-base-"));
    tempRoots.push(root);
    const repoRoot = path.join(root, "repo");
    const worktreePath = path.join(root, "task-worktree");

    await runCommand("git", ["init", "-b", "trunk", repoRoot]);
    await runCommand("git", ["config", "user.name", "Craig Tests"], { cwd: repoRoot });
    await runCommand("git", ["config", "user.email", "craig@example.com"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "README.md"), "trunk\n", "utf8");
    await runCommand("git", ["add", "README.md"], { cwd: repoRoot });
    await runCommand("git", ["commit", "-m", "seed"], { cwd: repoRoot });

    await createWorktree(repoRoot, "craig/task_1", worktreePath, "trunk");

    const readme = await runCommand("git", ["show", "HEAD:README.md"], { cwd: worktreePath });

    expect(readme.stdout).toContain("trunk");
  });
});
