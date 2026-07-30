import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { taskService } from "../src/domain/task/index.js";
import { workspaceService } from "../src/domain/workspace/index.js";
import { runCommand } from "../src/shared/exec.js";
import {
  buildTaskRecord,
  createCraigState,
  createGitRepo,
  createRepoRoot,
  writeTaskRecord,
} from "./test-helpers.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace context resolution", () => {
  test("uses explicit, environment, and nearest-ancestor precedence", async () => {
    const root = await createRepoRoot("craig-context-");
    const explicit = path.join(root, "explicit");
    const environment = path.join(root, "environment");
    const ancestor = path.join(root, "ancestor");
    const nested = path.join(ancestor, "one", "two");
    tempRoots.push(root);
    await Promise.all([
      mkdir(explicit, { recursive: true }),
      mkdir(environment, { recursive: true }),
      mkdir(nested, { recursive: true }),
    ]);
    await Promise.all([
      createCraigState(explicit),
      createCraigState(environment),
      createCraigState(ancestor),
    ]);

    await expect(
      workspaceService.resolveContext({
        cwd: nested,
        explicitWorkspaceRoot: explicit,
        environmentWorkspaceRoot: environment,
      }),
    ).resolves.toMatchObject({ workspaceRoot: explicit, source: "explicit" });
    await expect(
      workspaceService.resolveContext({ cwd: nested, environmentWorkspaceRoot: environment }),
    ).resolves.toMatchObject({ workspaceRoot: environment, source: "environment" });
    await expect(workspaceService.resolveContext({ cwd: nested })).resolves.toMatchObject({
      workspaceRoot: ancestor,
      source: "ancestor",
    });
  });

  test("resolves an external Git worktree through its common worktree", async () => {
    const root = await createRepoRoot("craig-context-git-");
    const worktree = await mkdtemp(path.join(tmpdir(), "craig-context-worktree-"));
    tempRoots.push(root, worktree);
    await createGitRepo(root);
    await writeFile(path.join(root, "README.md"), "context\n", "utf8");
    await runCommand("git", ["add", "README.md"], { cwd: root });
    await runCommand("git", ["commit", "-m", "context fixture"], { cwd: root });
    await createCraigState(root);
    await rm(worktree, { recursive: true, force: true });
    await runCommand("git", ["worktree", "add", worktree, "-b", "context-test"], { cwd: root });

    await expect(workspaceService.resolveContext({ cwd: worktree })).resolves.toMatchObject({
      workspaceRoot: root,
      source: "git_common_dir",
    });
  });

  test("returns stable missing and invalid workspace failures", async () => {
    const root = await createRepoRoot("craig-context-missing-");
    const invalid = path.join(root, "invalid");
    tempRoots.push(root);
    await mkdir(path.join(invalid, ".craig"), { recursive: true });
    await writeFile(path.join(invalid, ".craig", "index.json"), "{bad json", "utf8");

    await expect(workspaceService.resolveContext({ cwd: root })).rejects.toMatchObject({
      code: "WORKSPACE_CONTEXT_NOT_FOUND",
      exitCode: 3,
    });
    await expect(workspaceService.resolveContext({ cwd: invalid })).rejects.toMatchObject({
      code: "WORKSPACE_CONTEXT_INVALID",
      exitCode: 4,
    });
  });
});

describe("task context resolution", () => {
  test("uses explicit, environment, worktree, bundle, and project-target precedence", async () => {
    const root = await createRepoRoot("craig-task-context-");
    const worktree = path.join(root, "task-worktree");
    const bundle = path.join(root, "task-bundle");
    const target = path.join(root, "target-worktree");
    tempRoots.push(root);
    await Promise.all([
      mkdir(worktree, { recursive: true }),
      mkdir(bundle, { recursive: true }),
      mkdir(target, { recursive: true }),
    ]);
    const taskIds = ["task_explicit", "task_environment", "task_worktree", "task_project"];
    const paths = await createCraigState(root, taskIds);
    await Promise.all([
      writeTaskRecord(root, { id: "task_explicit" }),
      writeTaskRecord(root, { id: "task_environment" }),
      writeTaskRecord(root, { id: "task_worktree", worktreePath: worktree }),
      writeTaskRecord(root, {
        id: "task_project",
        type: "project",
        worktreePath: bundle,
        bundlePath: bundle,
        repoTargets: [
          {
            ...buildProjectTarget(root, target),
            repoId: "repo_target",
          },
        ],
      }),
    ]);

    await expect(
      taskService.resolveContext(paths, {
        cwd: target,
        explicitTaskId: "task_explicit",
        environmentTaskId: "task_environment",
      }),
    ).resolves.toMatchObject({ task: { id: "task_explicit" }, source: "explicit" });
    await expect(
      taskService.resolveContext(paths, { cwd: target, environmentTaskId: "task_environment" }),
    ).resolves.toMatchObject({ task: { id: "task_environment" }, source: "environment" });
    await expect(taskService.resolveContext(paths, { cwd: worktree })).resolves.toMatchObject({
      task: { id: "task_worktree" },
      source: "cwd",
    });
    await expect(taskService.resolveContext(paths, { cwd: bundle })).resolves.toMatchObject({
      task: { id: "task_project" },
      source: "cwd",
    });
    await expect(taskService.resolveContext(paths, { cwd: target })).resolves.toMatchObject({
      task: { id: "task_project" },
      source: "cwd",
    });
  });

  test("returns stable missing, ambiguous, and agent-tab conflict failures", async () => {
    const root = await createRepoRoot("craig-task-context-errors-");
    const shared = path.join(root, "shared");
    const nested = path.join(shared, "nested");
    tempRoots.push(root);
    await mkdir(nested, { recursive: true });
    const paths = await createCraigState(root, ["task_parent", "task_nested"]);
    const parent = await writeTaskRecord(root, { id: "task_parent", worktreePath: shared });
    await writeTaskRecord(root, { id: "task_nested", worktreePath: nested });

    await expect(taskService.resolveContext(paths, { cwd: root, required: true })).rejects.toMatchObject({
      code: "TASK_CONTEXT_NOT_FOUND",
      exitCode: 3,
    });
    await expect(taskService.resolveContext(paths, { cwd: nested, required: true })).rejects.toMatchObject({
      code: "TASK_CONTEXT_AMBIGUOUS",
      exitCode: 4,
    });
    await expect(
      taskService.resolveContext(paths, {
        cwd: root,
        explicitTaskId: parent.id,
        environmentAgentTabId: "not-this-task",
      }),
    ).rejects.toMatchObject({ code: "TASK_CONTEXT_CONFLICT", exitCode: 4 });
  });
});

function buildProjectTarget(root: string, worktreePath: string) {
  const task = buildTaskRecord(root, { id: "target_template" });
  return {
    repoId: "repo_test",
    branch: "craig/target",
    repoRoot: root,
    worktreePath,
    status: "ready" as const,
    failureReason: null,
    checks: task.checks,
    lastCommit: null,
    pullRequest: {
      provider: "github" as const,
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
    cleanup: task.cleanup,
  };
}
