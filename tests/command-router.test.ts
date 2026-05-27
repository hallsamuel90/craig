import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { executeCommand } from "../src/commands/command-router.js";
import { parseArgv } from "../src/commands/parse-argv.js";
import { getCraigPaths } from "../src/state/craig-paths.js";
import { readRepo } from "../src/state/repo-store.js";
import { readTask } from "../src/state/task-store.js";
import { readUiState } from "../src/state/ui-state-store.js";
import { readWorkspace } from "../src/state/workspace-store.js";
import { createCraigState, createGitRepo, createRepoRoot } from "./test-helpers.js";
import { runCommand } from "../src/utils/exec.js";
import { provisionProjectTask } from "../src/services/task-provisioning.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("command routing", () => {
  test("argv repo list commands normalize consistently", () => {
    expect(parseArgv(["repo", "list"]).command).toEqual({ kind: "listRepos" });
    expect(parseArgv(["--", "repo", "list"]).command).toEqual({ kind: "listRepos" });
  });

  test("argv workspace commands normalize consistently", () => {
    expect(parseArgv(["workspace", "list"]).command).toEqual({ kind: "listWorkspaces", archived: false });
    expect(parseArgv(["workspace", "list", "--archived"]).command).toEqual({
      kind: "listWorkspaces",
      archived: true,
    });
    expect(parseArgv(["workspace", "archive", "workspace_repo_one"]).command).toEqual({
      kind: "archiveWorkspace",
      workspaceId: "workspace_repo_one",
    });
    expect(parseArgv(["workspace", "restore", "workspace_repo_one"]).command).toEqual({
      kind: "restoreWorkspace",
      workspaceId: "workspace_repo_one",
    });
  });

  test("argv task new accepts explicit runner profiles", () => {
    expect(parseArgv(["task", "new", "--repo", "repo_a", "ship default"]).command).toEqual({
      kind: "createTask",
      repoId: "repo_a",
      prompt: "ship default",
    });
    expect(parseArgv(["task", "new", "--repo", "repo_a", "--runner", "claude", "ship claude"]).command).toEqual({
      kind: "createTask",
      repoId: "repo_a",
      prompt: "ship claude",
      runner: "claude",
    });
    expect(() => parseArgv(["task", "new", "--repo", "repo_a", "--runner", "vim", "ship"])).toThrow(/Unsupported runner/);
  });

  test("shared executor registers a repo and creates a matching active workspace", async () => {
    const workspaceRoot = await createRepoRoot("craig-router-");
    const repoRoot = path.join(workspaceRoot, "repo-a");
    tempRoots.push(workspaceRoot);
    await createCraigState(workspaceRoot);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(repoRoot, { recursive: true }));
    await createGitRepo(repoRoot);
    const paths = getCraigPaths(workspaceRoot);

    const argvResult = await executeCommand(parseArgv(["repo", "add", "./repo-a"]).command!, { paths });
    const listResult = await executeCommand(parseArgv(["repo", "list"]).command!, { paths });

    if (argvResult.kind !== "createRepo" || listResult.kind !== "listRepos") {
      throw new Error("Expected repo registration results.");
    }

    expect(argvResult.created).toBe(true);
    expect(listResult.repos).toHaveLength(1);

    const repo = await readRepo(paths, argvResult.repo.id);
    const workspace = await readWorkspace(paths, argvResult.workspaceId);
    const uiState = await readUiState({ uiStateFile: paths.uiStateFile });

    expect(repo.rootPath).toBe(repoRoot);
    expect(workspace.primaryRepoId).toBe(repo.id);
    expect(workspace.status).toBe("active");
    expect(uiState?.selectedRepoId).toBe(repo.id);
    expect(uiState?.selectedWorkspaceId).toBe(workspace.id);
  });

  test("repo list is deterministic across multiple registrations", async () => {
    const workspaceRoot = await createRepoRoot("craig-router-list-");
    tempRoots.push(workspaceRoot);
    await createCraigState(workspaceRoot);
    const paths = getCraigPaths(workspaceRoot);

    for (const name of ["zebra", "alpha"]) {
      const repoRoot = path.join(workspaceRoot, name);
      await import("node:fs/promises").then(({ mkdir }) => mkdir(repoRoot, { recursive: true }));
      await createGitRepo(repoRoot);
      await executeCommand({ kind: "addRepo", path: `./${name}` }, { paths });
    }

    const result = await executeCommand({ kind: "listRepos" }, { paths });

    expect(result.kind).toBe("listRepos");
    if (result.kind !== "listRepos") {
      throw new Error("Expected listRepos result.");
    }

    expect(result.repos.map((repo) => repo.name)).toEqual(["alpha", "zebra"]);
  });

  test("workspace add registers a project workspace with direct child repos and preserves overlap", async () => {
    const workspaceRoot = await createRepoRoot("craig-router-project-");
    tempRoots.push(workspaceRoot);
    await createCraigState(workspaceRoot);
    const paths = getCraigPaths(workspaceRoot);

    for (const name of ["repo-a", "repo-b"]) {
      const repoRoot = path.join(workspaceRoot, name);
      await mkdir(repoRoot, { recursive: true });
      await createGitRepo(repoRoot);
    }
    const nestedRepo = path.join(workspaceRoot, "repo-a", "nested");
    await mkdir(nestedRepo, { recursive: true });
    await createGitRepo(nestedRepo);

    const project = await executeCommand({ kind: "addWorkspace", path: "." }, { paths });
    const explicitRepo = await executeCommand({ kind: "addWorkspace", path: "./repo-a" }, { paths });

    expect(project.kind).toBe("createWorkspace");
    expect(explicitRepo.kind).toBe("createWorkspace");
    if (project.kind !== "createWorkspace" || explicitRepo.kind !== "createWorkspace") {
      throw new Error("Expected workspace registration results.");
    }

    expect(project.workspace.kind).toBe("project");
    expect(project.repos.map((repo) => repo.name)).toEqual(["repo-a", "repo-b"]);
    expect(project.workspace.discoveredRepoIds).toEqual(project.repos.map((repo) => repo.id));
    expect(project.repos.some((repo) => repo.rootPath === nestedRepo)).toBe(false);
    expect(explicitRepo.workspace.kind).toBe("repo");
    expect(explicitRepo.workspace.id).not.toBe(project.workspace.id);
    expect(explicitRepo.workspace.rootPath).toBe(path.join(workspaceRoot, "repo-a"));
  });

  test("task new with a project workspace provisions per-repo targets and a bundle root", async () => {
    const workspaceRoot = await createRepoRoot("craig-router-project-task-");
    tempRoots.push(workspaceRoot);
    await createCraigState(workspaceRoot);
    const paths = getCraigPaths(workspaceRoot);

    for (const name of ["repo-a", "repo-b"]) {
      const repoRoot = path.join(workspaceRoot, name);
      await mkdir(repoRoot, { recursive: true });
      await createGitRepo(repoRoot);
      await writeFile(path.join(repoRoot, "README.md"), `${name}\n`, "utf8");
      await runCommand("git", ["add", "README.md"], { cwd: repoRoot });
      await runCommand("git", ["commit", "-m", "seed"], { cwd: repoRoot });
    }

    const project = await executeCommand({ kind: "addWorkspace", path: "." }, { paths });
    if (project.kind !== "createWorkspace") {
      throw new Error("Expected project workspace.");
    }

    const provisioned = await provisionProjectTask(paths, project.workspace.id, "ship project");
    const task = await readTask(paths, provisioned.task.id);
    expect(task.type).toBe("project");
    expect(task.workspaceId).toBe(project.workspace.id);
    expect(task.bundlePath).toBe(path.join(paths.craigDir, "task-bundles", task.id));
    expect(task.worktreePath).toBe(task.bundlePath);
    expect(task.repoTargets?.map((target) => target.repoId).sort()).toEqual(project.workspace.discoveredRepoIds?.slice().sort());
    expect(task.repoTargets?.every((target) => target.status === "ready")).toBe(true);
    await expect(readFile(path.join(task.bundlePath ?? "", "manifest.json"), "utf8")).resolves.toContain("ship project");
  });

  test("workspace archive and restore update state and persisted UI selection", async () => {
    const workspaceRoot = await createRepoRoot("craig-router-archive-");
    const repoRoot = path.join(workspaceRoot, "repo-a");
    tempRoots.push(workspaceRoot);
    await createCraigState(workspaceRoot);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(repoRoot, { recursive: true }));
    await createGitRepo(repoRoot);
    const paths = getCraigPaths(workspaceRoot);

    const created = await executeCommand({ kind: "addRepo", path: "./repo-a" }, { paths });
    if (created.kind !== "createRepo") {
      throw new Error("Expected createRepo result.");
    }

    const archived = await executeCommand({ kind: "archiveWorkspace", workspaceId: created.workspaceId }, { paths });
    expect(archived.kind).toBe("archiveWorkspace");

    const archivedRecord = await readWorkspace(paths, created.workspaceId);
    const afterArchiveUi = await readUiState({ uiStateFile: paths.uiStateFile });
    expect(archivedRecord.status).toBe("archived");
    expect(afterArchiveUi?.selectedRepoId).toBeNull();
    expect(afterArchiveUi?.selectedWorkspaceId).toBeNull();

    const restored = await executeCommand({ kind: "restoreWorkspace", workspaceId: created.workspaceId }, { paths });
    expect(restored.kind).toBe("restoreWorkspace");

    const restoredRecord = await readWorkspace(paths, created.workspaceId);
    const afterRestoreUi = await readUiState({ uiStateFile: paths.uiStateFile });
    expect(restoredRecord.status).toBe("active");
    expect(afterRestoreUi?.selectedRepoId).toBe(created.repo.id);
    expect(afterRestoreUi?.selectedWorkspaceId).toBe(created.workspaceId);
  });

  test("repo remove requires the workspace to be archived first and then removes archived state", async () => {
    const workspaceRoot = await createRepoRoot("craig-router-remove-");
    const repoRoot = path.join(workspaceRoot, "repo-a");
    tempRoots.push(workspaceRoot);
    await createCraigState(workspaceRoot);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(repoRoot, { recursive: true }));
    await createGitRepo(repoRoot);
    const paths = getCraigPaths(workspaceRoot);

    const created = await executeCommand({ kind: "addRepo", path: "./repo-a" }, { paths });
    if (created.kind !== "createRepo") {
      throw new Error("Expected createRepo result.");
    }

    await expect(executeCommand({ kind: "removeRepo", repoId: created.repo.id }, { paths })).rejects.toThrow(
      /active workspace records still reference it/,
    );

    await executeCommand({ kind: "archiveWorkspace", workspaceId: created.workspaceId }, { paths });
    const removed = await executeCommand({ kind: "removeRepo", repoId: created.repo.id }, { paths });

    expect(removed.kind).toBe("removeRepo");
    await expect(readFile(path.join(paths.reposDir, `${created.repo.id}.json`), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(paths.workspacesDir, `${created.workspaceId}.json`), "utf8")).rejects.toThrow();
  });

  test("invalid repo registrations are rejected", async () => {
    const workspaceRoot = await createRepoRoot("craig-router-invalid-");
    tempRoots.push(workspaceRoot);
    await createCraigState(workspaceRoot);
    const paths = getCraigPaths(workspaceRoot);

    await expect(executeCommand({ kind: "addRepo", path: "./missing" }, { paths })).rejects.toThrow(
      /Repo path does not exist/,
    );
  });

  test("unknown argv commands are rejected", () => {
    expect(() => parseArgv(["repo", "unknown"])).toThrow(/Unsupported command/);
  });
});
