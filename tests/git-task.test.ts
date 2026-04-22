import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createWorktree } from "../src/services/git-task.js";
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
    await writeFile(path.join(localRepo, "README.md"), "base\n", "utf8");
    await runCommand("git", ["add", "README.md"], { cwd: localRepo });
    await runCommand("git", ["commit", "-m", "base"], { cwd: localRepo });
    await runCommand("git", ["push", "-u", "origin", "main"], { cwd: localRepo });

    await runCommand("git", ["clone", remoteRepo, updaterRepo]);
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
});
